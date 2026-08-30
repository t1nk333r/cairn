package gittransport

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/t1nk333r/hsync/native/hsyncd/internal/secrets"
)

const maxInventorySize = 768 * 1024

var branchPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]*$`)

type Config struct {
	RemoteURL string `json:"remoteUrl"`
	Branch    string `json:"branch"`
	FilePath  string `json:"filePath"`
}

type ReadResult struct {
	DataBase64 string `json:"dataBase64"`
	Version    string `json:"version"`
}

type WriteInput struct {
	Config
	DataBase64      string  `json:"dataBase64"`
	ExpectedVersion *string `json:"expectedVersion"`
}

type WriteResult struct {
	Version string `json:"version"`
}

type Error struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *Error) Error() string { return e.Message }

type Runner interface {
	Run(ctx context.Context, directory string, args ...string) ([]byte, error)
}

type ExecRunner struct{}

type authHeaderContextKey struct{}

func (ExecRunner) Run(ctx context.Context, directory string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, "git", args...)
	command.Dir = directory
	command.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_SYSTEM="+os.DevNull,
		"GIT_CONFIG_GLOBAL="+os.DevNull,
		"GIT_SSH_COMMAND=ssh -oBatchMode=yes",
	)
	if header, ok := ctx.Value(authHeaderContextKey{}).(string); ok && header != "" {
		command.Env = append(command.Env,
			"GIT_CONFIG_COUNT=2",
			"GIT_CONFIG_KEY_0=http.extraHeader",
			"GIT_CONFIG_VALUE_0="+header,
			"GIT_CONFIG_KEY_1=http.followRedirects",
			"GIT_CONFIG_VALUE_1=false",
		)
	}
	output, err := command.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("git command failed: %s", message)
	}
	return output, nil
}

type Service struct {
	runner  Runner
	secrets secrets.Store
	timeout time.Duration
}

func New(store secrets.Store) *Service {
	return &Service{runner: ExecRunner{}, secrets: store, timeout: 45 * time.Second}
}

func NewWithRunner(runner Runner) *Service {
	return &Service{runner: runner, timeout: 45 * time.Second}
}

func NormalizeConfig(config Config) (Config, error) {
	remote, err := url.Parse(strings.TrimSpace(config.RemoteURL))
	if err != nil || remote.Scheme != "https" || remote.Host == "" {
		return Config{}, &Error{Code: "invalid_config", Message: "Git remote must be a valid HTTPS URL."}
	}
	if remote.User != nil || remote.RawQuery != "" || remote.Fragment != "" {
		return Config{}, &Error{Code: "invalid_config", Message: "Git remote URL cannot contain credentials, query parameters, or a fragment."}
	}
	branch := strings.TrimSpace(config.Branch)
	if !validBranch(branch) {
		return Config{}, &Error{Code: "invalid_config", Message: "Git branch name is invalid or unsafe."}
	}
	filePath := filepath.ToSlash(strings.TrimSpace(config.FilePath))
	if !validFilePath(filePath) {
		return Config{}, &Error{Code: "invalid_config", Message: "Git inventory path must be a safe repository-relative file path."}
	}
	remote.Path = strings.TrimSuffix(remote.Path, "/")
	return Config{RemoteURL: remote.String(), Branch: branch, FilePath: filePath}, nil
}

func validBranch(branch string) bool {
	return branchPattern.MatchString(branch) &&
		!strings.Contains(branch, "..") &&
		!strings.Contains(branch, "@{") &&
		!strings.Contains(branch, "//") &&
		!strings.HasSuffix(branch, "/") &&
		!strings.HasSuffix(branch, ".") &&
		!strings.HasSuffix(branch, ".lock")
}

func validFilePath(filePath string) bool {
	if filePath == "" || strings.HasPrefix(filePath, "/") || strings.HasSuffix(filePath, "/") || strings.Contains(filePath, "\\") {
		return false
	}
	parts := strings.Split(filePath, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || part == ".git" {
			return false
		}
	}
	return true
}

func (s *Service) TestConnection(parent context.Context, raw Config) error {
	config, err := NormalizeConfig(raw)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(parent, s.timeout)
	defer cancel()
	ctx, err = s.withCredential(ctx, config.RemoteURL)
	if err != nil {
		return err
	}
	_, err = s.runner.Run(ctx, "", "ls-remote", "--exit-code", "--heads", config.RemoteURL, "refs/heads/"+config.Branch)
	return classifyGitError(ctx, err, "Could not find or access the configured Git branch.")
}

func (s *Service) Read(parent context.Context, raw Config) (*ReadResult, error) {
	config, err := NormalizeConfig(raw)
	if err != nil {
		return nil, err
	}
	parent, err = s.withCredential(parent, config.RemoteURL)
	if err != nil {
		return nil, err
	}
	repository, cleanup, ctx, cancel, err := s.clone(parent, config)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	defer cancel()
	target, err := secureTarget(repository, config.FilePath)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(target)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, &Error{Code: "filesystem", Message: "Could not read the Git inventory file."}
	}
	if len(data) > maxInventorySize {
		return nil, &Error{Code: "invalid_inventory", Message: "Git inventory exceeds the safe size limit."}
	}
	version, err := s.revision(ctx, repository)
	if err != nil {
		return nil, err
	}
	return &ReadResult{DataBase64: base64.StdEncoding.EncodeToString(data), Version: version}, nil
}

func (s *Service) Write(parent context.Context, input WriteInput) (*WriteResult, error) {
	config, err := NormalizeConfig(input.Config)
	if err != nil {
		return nil, err
	}
	data, err := base64.StdEncoding.Strict().DecodeString(input.DataBase64)
	if err != nil || len(data) > maxInventorySize {
		return nil, &Error{Code: "invalid_inventory", Message: "Inventory content is not valid Base64 or exceeds the safe size limit."}
	}
	parent, err = s.withCredential(parent, config.RemoteURL)
	if err != nil {
		return nil, err
	}
	repository, cleanup, ctx, cancel, err := s.clone(parent, config)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	defer cancel()
	currentVersion, err := s.revision(ctx, repository)
	if err != nil {
		return nil, err
	}
	target, err := secureTarget(repository, config.FilePath)
	if err != nil {
		return nil, err
	}
	_, statErr := os.Stat(target)
	if input.ExpectedVersion == nil && statErr == nil {
		return nil, &Error{Code: "conflict", Message: "Git inventory already exists. Read it before writing.", Retryable: true}
	}
	if input.ExpectedVersion != nil && *input.ExpectedVersion != currentVersion {
		return nil, &Error{Code: "conflict", Message: "Git branch changed. Read and compare before writing again.", Retryable: true}
	}
	if input.ExpectedVersion != nil && errors.Is(statErr, os.ErrNotExist) {
		return nil, &Error{Code: "conflict", Message: "Git inventory was removed. Read and compare before writing again.", Retryable: true}
	}
	if existing, readErr := os.ReadFile(target); readErr == nil && bytes.Equal(existing, data) {
		return &WriteResult{Version: currentVersion}, nil
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return nil, &Error{Code: "filesystem", Message: "Could not prepare the inventory directory."}
	}
	if err := os.WriteFile(target, data, 0o600); err != nil {
		return nil, &Error{Code: "filesystem", Message: "Could not write the inventory file."}
	}
	commands := [][]string{
		{"config", "user.name", "hsync"},
		{"config", "user.email", "hsync@localhost"},
		{"add", "--", config.FilePath},
		{"commit", "-m", "sync: update " + config.FilePath, "--", config.FilePath},
	}
	for _, args := range commands {
		if _, err := s.runner.Run(ctx, repository, args...); err != nil {
			return nil, classifyGitError(ctx, err, "Could not create the Git inventory commit.")
		}
	}
	version, err := s.revision(ctx, repository)
	if err != nil {
		return nil, err
	}
	if _, err := s.runner.Run(ctx, repository, "push", "origin", "HEAD:refs/heads/"+config.Branch); err != nil {
		return nil, &Error{Code: "conflict", Message: "Git push was rejected. Read and compare before trying again.", Retryable: true}
	}
	return &WriteResult{Version: version}, nil
}

func (s *Service) clone(parent context.Context, config Config) (string, func(), context.Context, context.CancelFunc, error) {
	ctx, cancel := context.WithTimeout(parent, s.timeout)
	root, err := os.MkdirTemp("", "hsyncd-git-")
	if err != nil {
		cancel()
		return "", func() {}, ctx, cancel, &Error{Code: "filesystem", Message: "Could not create a private Git workspace."}
	}
	if err := os.Chmod(root, 0o700); err != nil {
		os.RemoveAll(root)
		cancel()
		return "", func() {}, ctx, cancel, &Error{Code: "filesystem", Message: "Could not secure the Git workspace."}
	}
	repository := filepath.Join(root, "repository")
	_, err = s.runner.Run(ctx, root, "clone", "--quiet", "--depth", "1", "--branch", config.Branch, "--single-branch", "--", config.RemoteURL, repository)
	if err != nil {
		os.RemoveAll(root)
		cancel()
		return "", func() {}, ctx, cancel, classifyGitError(ctx, err, "Could not clone the configured Git branch.")
	}
	return repository, func() { _ = os.RemoveAll(root) }, ctx, cancel, nil
}

func (s *Service) revision(ctx context.Context, repository string) (string, error) {
	output, err := s.runner.Run(ctx, repository, "rev-parse", "HEAD")
	if err != nil {
		return "", classifyGitError(ctx, err, "Could not read the Git revision.")
	}
	return strings.TrimSpace(string(output)), nil
}

func secureTarget(repository, filePath string) (string, error) {
	current := repository
	for _, part := range strings.Split(filePath, "/") {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", &Error{Code: "filesystem", Message: "Could not inspect the Git inventory path."}
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", &Error{Code: "invalid_config", Message: "Git inventory path cannot contain symbolic links."}
		}
	}
	return current, nil
}

func classifyGitError(ctx context.Context, err error, fallback string) error {
	if err == nil {
		return nil
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return &Error{Code: "timeout", Message: "Git operation timed out.", Retryable: true}
	}
	return &Error{Code: "git", Message: fallback, Retryable: true}
}

func (s *Service) withCredential(ctx context.Context, remoteURL string) (context.Context, error) {
	if s.secrets == nil {
		return ctx, nil
	}
	credential, err := s.secrets.Get(remoteURL)
	if err != nil {
		return nil, &Error{Code: "keyring", Message: "Could not read the Git credential from the operating-system keyring."}
	}
	if credential == nil {
		return ctx, nil
	}
	value := base64.StdEncoding.EncodeToString([]byte(credential.Username + ":" + credential.Token))
	return context.WithValue(ctx, authHeaderContextKey{}, "Authorization: Basic "+value), nil
}
