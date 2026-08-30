package secrets

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	keyring "github.com/zalando/go-keyring"
)

const service = "dev.t1nk333r.hsync.git-token"

type Credential struct {
	Username string `json:"username"`
	Token    string `json:"token"`
}

type Store interface {
	Set(remoteURL, username, token string) error
	Get(remoteURL string) (*Credential, error)
	Delete(remoteURL string) error
}

type SystemStore struct{}

func Origin(remoteURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(remoteURL))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("secret remote must be a credential-free HTTPS URL")
	}
	return "https://" + strings.ToLower(parsed.Host), nil
}

func validateCredential(username, token string) (Credential, error) {
	username = strings.TrimSpace(username)
	token = strings.TrimSpace(token)
	if username == "" || strings.ContainsAny(username, ":\r\n") {
		return Credential{}, errors.New("Git username is required and cannot contain a colon or newline")
	}
	if token == "" || len(token) > 16*1024 || strings.ContainsAny(token, "\r\n") {
		return Credential{}, errors.New("Git token is empty, oversized, or contains a newline")
	}
	return Credential{Username: username, Token: token}, nil
}

func (SystemStore) Set(remoteURL, username, token string) error {
	origin, err := Origin(remoteURL)
	if err != nil {
		return err
	}
	credential, err := validateCredential(username, token)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(credential)
	if err != nil {
		return err
	}
	return keyring.Set(service, origin, string(encoded))
}

func (SystemStore) Get(remoteURL string) (*Credential, error) {
	origin, err := Origin(remoteURL)
	if err != nil {
		return nil, err
	}
	encoded, err := keyring.Get(service, origin)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var credential Credential
	if err := json.Unmarshal([]byte(encoded), &credential); err != nil {
		return nil, fmt.Errorf("decode keyring credential: %w", err)
	}
	validated, err := validateCredential(credential.Username, credential.Token)
	if err != nil {
		return nil, err
	}
	return &validated, nil
}

func (SystemStore) Delete(remoteURL string) error {
	origin, err := Origin(remoteURL)
	if err != nil {
		return err
	}
	err = keyring.Delete(service, origin)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}
