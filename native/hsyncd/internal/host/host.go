package host

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"

	"github.com/t1nk333r/hsync/native/hsyncd/internal/gittransport"
	"github.com/t1nk333r/hsync/native/hsyncd/internal/protocol"
	"github.com/t1nk333r/hsync/native/hsyncd/internal/secrets"
)

const Name = "dev.t1nk333r.hsync"

type Host struct {
	version string
	git     GitTransport
	secrets SecretStore
}

type SecretStore interface {
	Set(remoteURL, username, token string) error
	Get(remoteURL string) (*secrets.Credential, error)
	Delete(remoteURL string) error
}

type setSecretPayload struct {
	RemoteURL string `json:"remoteUrl"`
	Username  string `json:"username"`
	Token     string `json:"token"`
}

type deleteSecretPayload struct {
	RemoteURL string `json:"remoteUrl"`
}

type GitTransport interface {
	TestConnection(context.Context, gittransport.Config) error
	Read(context.Context, gittransport.Config) (*gittransport.ReadResult, error)
	Write(context.Context, gittransport.WriteInput) (*gittransport.WriteResult, error)
}

func New(version string) *Host {
	store := secrets.SystemStore{}
	return &Host{version: version, git: gittransport.New(store), secrets: store}
}

func NewWithGitTransport(version string, transport GitTransport) *Host {
	return &Host{version: version, git: transport}
}

func NewWithDependencies(version string, transport GitTransport, store SecretStore) *Host {
	return &Host{version: version, git: transport, secrets: store}
}

func (h *Host) Run(input io.Reader, output io.Writer) error {
	reader := protocol.NewReader(input)
	writer := protocol.NewWriter(output)
	for {
		var request protocol.Request
		if err := reader.Read(&request); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("read request: %w", err)
		}
		if err := writer.Write(h.handle(request)); err != nil {
			return fmt.Errorf("write response: %w", err)
		}
	}
}

func (h *Host) handle(request protocol.Request) protocol.Response {
	if request.RequestID == "" || utf8.RuneCountInString(request.RequestID) > 128 {
		return protocol.Failed("", "invalid_request", "requestId must contain 1 to 128 characters", false)
	}
	if request.ProtocolVersion != protocol.Version {
		return protocol.Failed(
			request.RequestID,
			"unsupported_protocol",
			fmt.Sprintf("protocol version %d is not supported", request.ProtocolVersion),
			false,
		)
	}
	switch request.Command {
	case protocol.CommandHello:
		return protocol.Completed(request.RequestID, protocol.HelloResult{
			HostName:         Name,
			HostVersion:      h.version,
			ProtocolVersions: []int{protocol.Version},
			Capabilities: []protocol.Command{
				protocol.CommandHello,
				protocol.CommandTestConnection,
				protocol.CommandReadInventory,
				protocol.CommandWriteInventory,
				protocol.CommandSetSecret,
				protocol.CommandDeleteSecret,
			},
		})
	case protocol.CommandTestConnection:
		var config gittransport.Config
		if err := decodePayload(request.Payload, &config); err != nil {
			return protocol.Failed(request.RequestID, "invalid_request", err.Error(), false)
		}
		if err := h.git.TestConnection(context.Background(), config); err != nil {
			return gitFailure(request.RequestID, err)
		}
		return protocol.Completed(request.RequestID, map[string]bool{"connected": true})
	case protocol.CommandReadInventory:
		var config gittransport.Config
		if err := decodePayload(request.Payload, &config); err != nil {
			return protocol.Failed(request.RequestID, "invalid_request", err.Error(), false)
		}
		result, err := h.git.Read(context.Background(), config)
		if err != nil {
			return gitFailure(request.RequestID, err)
		}
		return protocol.Completed(request.RequestID, result)
	case protocol.CommandWriteInventory:
		var input gittransport.WriteInput
		if err := decodePayload(request.Payload, &input); err != nil {
			return protocol.Failed(request.RequestID, "invalid_request", err.Error(), false)
		}
		result, err := h.git.Write(context.Background(), input)
		if err != nil {
			return gitFailure(request.RequestID, err)
		}
		return protocol.Completed(request.RequestID, result)
	case protocol.CommandSetSecret:
		var payload setSecretPayload
		if err := decodePayload(request.Payload, &payload); err != nil {
			return protocol.Failed(request.RequestID, "invalid_request", err.Error(), false)
		}
		if h.secrets == nil {
			return protocol.Failed(request.RequestID, "keyring", "Keyring storage is unavailable.", false)
		}
		if err := h.secrets.Set(payload.RemoteURL, payload.Username, payload.Token); err != nil {
			return protocol.Failed(request.RequestID, "keyring", "Could not save the Git token in the operating-system keyring.", false)
		}
		return protocol.Completed(request.RequestID, map[string]bool{"stored": true})
	case protocol.CommandDeleteSecret:
		var payload deleteSecretPayload
		if err := decodePayload(request.Payload, &payload); err != nil {
			return protocol.Failed(request.RequestID, "invalid_request", err.Error(), false)
		}
		if h.secrets == nil {
			return protocol.Failed(request.RequestID, "keyring", "Keyring storage is unavailable.", false)
		}
		if err := h.secrets.Delete(payload.RemoteURL); err != nil {
			return protocol.Failed(request.RequestID, "keyring", "Could not delete the Git token from the operating-system keyring.", false)
		}
		return protocol.Completed(request.RequestID, map[string]bool{"deleted": true})
	default:
		return protocol.Failed(
			request.RequestID,
			"unsupported_command",
			fmt.Sprintf("command %q is not implemented in this companion build", request.Command),
			false,
		)
	}
}

func decodePayload(payload json.RawMessage, destination any) error {
	if len(payload) == 0 {
		return errors.New("command payload is required")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("command payload is invalid: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("command payload contains trailing data")
	}
	return nil
}

func gitFailure(requestID string, err error) protocol.Response {
	var transportError *gittransport.Error
	if errors.As(err, &transportError) {
		return protocol.Failed(requestID, transportError.Code, transportError.Message, transportError.Retryable)
	}
	return protocol.Failed(requestID, "git", "Git operation failed.", true)
}
