package gittransport

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type recordedCommand struct {
	directory string
	args      []string
}

type recordingRunner struct {
	commands []recordedCommand
	output   []byte
	err      error
}

type checkoutRunner struct {
	revision string
	content  []byte
	commands []recordedCommand
}

func (r *checkoutRunner) Run(_ context.Context, directory string, args ...string) ([]byte, error) {
	r.commands = append(r.commands, recordedCommand{directory: directory, args: args})
	if len(args) > 0 && args[0] == "clone" {
		repository := args[len(args)-1]
		if err := os.MkdirAll(filepath.Join(repository, "sync"), 0o700); err != nil {
			return nil, err
		}
		if r.content != nil {
			if err := os.WriteFile(filepath.Join(repository, "sync", "hsync.json"), r.content, 0o600); err != nil {
				return nil, err
			}
		}
	}
	if len(args) >= 2 && args[0] == "rev-parse" && args[1] == "HEAD" {
		return []byte(r.revision + "\n"), nil
	}
	if len(args) > 0 && args[0] == "commit" {
		r.revision = "revision-2"
	}
	return nil, nil
}

func (r *recordingRunner) Run(_ context.Context, directory string, args ...string) ([]byte, error) {
	r.commands = append(r.commands, recordedCommand{directory: directory, args: args})
	return r.output, r.err
}

func TestNormalizeConfigAcceptsHTTPSRepository(t *testing.T) {
	config, err := NormalizeConfig(Config{
		RemoteURL: " https://git.example.test/alice/sync.git/ ",
		Branch:    "sync/devices",
		FilePath:  "devices/hsync.json",
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.RemoteURL != "https://git.example.test/alice/sync.git" {
		t.Fatalf("unexpected URL: %s", config.RemoteURL)
	}
}

func TestNormalizeConfigRejectsCredentialBearingURL(t *testing.T) {
	_, err := NormalizeConfig(Config{
		RemoteURL: "https://token@git.example.test/alice/sync.git",
		Branch:    "main",
		FilePath:  "hsync.json",
	})
	if err == nil || !strings.Contains(err.Error(), "credentials") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestNormalizeConfigRejectsTraversalAndGitMetadata(t *testing.T) {
	for _, filePath := range []string{"../hsync.json", ".git/config", "sync/../../hsync.json"} {
		_, err := NormalizeConfig(Config{
			RemoteURL: "https://git.example.test/alice/sync.git",
			Branch:    "main",
			FilePath:  filePath,
		})
		if err == nil {
			t.Fatalf("expected %q to be rejected", filePath)
		}
	}
}

func TestNormalizeConfigRejectsUnsafeBranches(t *testing.T) {
	for _, branch := range []string{"-upload-pack=evil", "main..other", "refs//main", "main.lock"} {
		_, err := NormalizeConfig(Config{
			RemoteURL: "https://git.example.test/alice/sync.git",
			Branch:    branch,
			FilePath:  "hsync.json",
		})
		if err == nil {
			t.Fatalf("expected %q to be rejected", branch)
		}
	}
}

func TestConnectionUsesExactBranchRefWithoutShell(t *testing.T) {
	runner := &recordingRunner{output: []byte("revision\trefs/heads/main\n")}
	service := NewWithRunner(runner)
	err := service.TestConnection(context.Background(), Config{
		RemoteURL: "https://git.example.test/alice/sync.git",
		Branch:    "main",
		FilePath:  "hsync.json",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"ls-remote", "--exit-code", "--heads", "https://git.example.test/alice/sync.git", "refs/heads/main"}
	if strings.Join(runner.commands[0].args, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("got %#v, want %#v", runner.commands[0].args, want)
	}
}

func TestSecureTargetRejectsRepositorySymlink(t *testing.T) {
	repository := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(repository, "devices")); err != nil {
		t.Fatal(err)
	}
	_, err := secureTarget(repository, "devices/hsync.json")
	if err == nil || !strings.Contains(err.Error(), "symbolic links") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSecureTargetAllowsMissingNestedFile(t *testing.T) {
	repository := t.TempDir()
	target, err := secureTarget(repository, "devices/hsync.json")
	if err != nil {
		t.Fatal(err)
	}
	if target != filepath.Join(repository, "devices", "hsync.json") {
		t.Fatalf("unexpected target: %s", target)
	}
}

func TestReadReturnsInventoryAndHeadRevision(t *testing.T) {
	runner := &checkoutRunner{revision: "revision-1", content: []byte(`{"schemaVersion":1}`)}
	service := NewWithRunner(runner)
	result, err := service.Read(context.Background(), Config{
		RemoteURL: "https://git.example.test/alice/sync.git",
		Branch:    "main",
		FilePath:  "sync/hsync.json",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result == nil || result.Version != "revision-1" || result.DataBase64 != "eyJzY2hlbWFWZXJzaW9uIjoxfQ==" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestWriteCommitsAndPushesExpectedRevision(t *testing.T) {
	runner := &checkoutRunner{revision: "revision-1", content: []byte(`{"schemaVersion":1}`)}
	service := NewWithRunner(runner)
	expected := "revision-1"
	result, err := service.Write(context.Background(), WriteInput{
		Config: Config{
			RemoteURL: "https://git.example.test/alice/sync.git",
			Branch:    "main",
			FilePath:  "sync/hsync.json",
		},
		DataBase64:      "eyJzY2hlbWFWZXJzaW9uIjoyfQ==",
		ExpectedVersion: &expected,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Version != "revision-2" {
		t.Fatalf("unexpected result: %#v", result)
	}
	foundPush := false
	for _, command := range runner.commands {
		if len(command.args) > 0 && command.args[0] == "push" {
			foundPush = true
			if command.args[len(command.args)-1] != "HEAD:refs/heads/main" {
				t.Fatalf("unexpected push: %#v", command.args)
			}
		}
	}
	if !foundPush {
		t.Fatal("push command was not run")
	}
}

func TestWriteRejectsStaleRevisionBeforeChangingFile(t *testing.T) {
	runner := &checkoutRunner{revision: "revision-2", content: []byte(`{"schemaVersion":2}`)}
	service := NewWithRunner(runner)
	expected := "revision-1"
	_, err := service.Write(context.Background(), WriteInput{
		Config: Config{
			RemoteURL: "https://git.example.test/alice/sync.git",
			Branch:    "main",
			FilePath:  "sync/hsync.json",
		},
		DataBase64:      "eyJzY2hlbWFWZXJzaW9uIjozfQ==",
		ExpectedVersion: &expected,
	})
	var transportError *Error
	if !errors.As(err, &transportError) || transportError.Code != "conflict" {
		t.Fatalf("unexpected error: %v", err)
	}
}
