package host

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/t1nk333r/hsync/native/hsyncd/internal/gittransport"
	"github.com/t1nk333r/hsync/native/hsyncd/internal/protocol"
	"github.com/t1nk333r/hsync/native/hsyncd/internal/secrets"
)

func exchange(t *testing.T, request protocol.Request) protocol.Response {
	t.Helper()
	var input bytes.Buffer
	if err := protocol.NewWriter(&input).Write(request); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := New("0.1.0-test").Run(&input, &output); err != nil {
		t.Fatal(err)
	}
	var response protocol.Response
	if err := protocol.NewReader(&output).Read(&response); err != nil {
		t.Fatal(err)
	}
	return response
}

type fakeGitTransport struct {
	tested gittransport.Config
}

type fakeSecretStore struct {
	remoteURL string
	username  string
	token     string
}

func (s *fakeSecretStore) Set(remoteURL, username, token string) error {
	s.remoteURL, s.username, s.token = remoteURL, username, token
	return nil
}
func (*fakeSecretStore) Get(string) (*secrets.Credential, error) { return nil, nil }
func (*fakeSecretStore) Delete(string) error                     { return nil }

func (f *fakeGitTransport) TestConnection(_ context.Context, config gittransport.Config) error {
	f.tested = config
	return nil
}

func (*fakeGitTransport) Read(context.Context, gittransport.Config) (*gittransport.ReadResult, error) {
	return nil, nil
}

func (*fakeGitTransport) Write(context.Context, gittransport.WriteInput) (*gittransport.WriteResult, error) {
	return &gittransport.WriteResult{Version: "revision"}, nil
}

func exchangeWithHost(t *testing.T, instance *Host, request protocol.Request) protocol.Response {
	t.Helper()
	var input bytes.Buffer
	if err := protocol.NewWriter(&input).Write(request); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := instance.Run(&input, &output); err != nil {
		t.Fatal(err)
	}
	var response protocol.Response
	if err := protocol.NewReader(&output).Read(&response); err != nil {
		t.Fatal(err)
	}
	return response
}

func TestHelloNegotiatesCapabilities(t *testing.T) {
	response := exchange(t, protocol.Request{
		ProtocolVersion: protocol.Version,
		RequestID:       "req-hello",
		Command:         protocol.CommandHello,
	})
	if response.Event != "completed" || response.RequestID != "req-hello" {
		t.Fatalf("unexpected response: %#v", response)
	}
	result, ok := response.Result.(map[string]any)
	capabilities, capabilitiesOK := result["capabilities"].([]any)
	if !ok || result["hostVersion"] != "0.1.0-test" || !capabilitiesOK || len(capabilities) != 6 {
		t.Fatalf("unexpected hello result: %#v", response.Result)
	}
}

func TestUnsupportedProtocolFailsClosed(t *testing.T) {
	response := exchange(t, protocol.Request{
		ProtocolVersion: 99,
		RequestID:       "req-version",
		Command:         protocol.CommandHello,
	})
	if response.Error == nil || response.Error.Code != "unsupported_protocol" {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func TestOversizedRequestIDIsRejected(t *testing.T) {
	response := exchange(t, protocol.Request{
		ProtocolVersion: protocol.Version,
		RequestID:       strings.Repeat("x", 129),
		Command:         protocol.CommandHello,
	})
	if response.Error == nil || response.Error.Code != "invalid_request" {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func TestUnimplementedCommandIsNotAdvertisedAsWorking(t *testing.T) {
	response := exchange(t, protocol.Request{
		ProtocolVersion: protocol.Version,
		RequestID:       "req-sync",
		Command:         protocol.CommandSync,
	})
	if response.Error == nil || response.Error.Code != "unsupported_command" {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func TestConnectionCommandUsesStrictTypedPayload(t *testing.T) {
	transport := &fakeGitTransport{}
	payload, err := json.Marshal(gittransport.Config{
		RemoteURL: "https://git.example.test/alice/sync.git",
		Branch:    "main",
		FilePath:  "hsync.json",
	})
	if err != nil {
		t.Fatal(err)
	}
	response := exchangeWithHost(t, NewWithGitTransport("test", transport), protocol.Request{
		ProtocolVersion: protocol.Version,
		RequestID:       "req-test",
		Command:         protocol.CommandTestConnection,
		Payload:         payload,
	})
	if response.Event != "completed" || transport.tested.Branch != "main" {
		t.Fatalf("unexpected response or payload: %#v %#v", response, transport.tested)
	}
}

func TestConnectionCommandRejectsUnknownPayloadFields(t *testing.T) {
	response := exchangeWithHost(t, NewWithGitTransport("test", &fakeGitTransport{}), protocol.Request{
		ProtocolVersion: protocol.Version,
		RequestID:       "req-test",
		Command:         protocol.CommandTestConnection,
		Payload:         json.RawMessage(`{"remoteUrl":"https://git.example.test/repo.git","branch":"main","filePath":"hsync.json","secret":"no"}`),
	})
	if response.Error == nil || response.Error.Code != "invalid_request" {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func TestSetSecretStoresCredentialWithoutReturningIt(t *testing.T) {
	store := &fakeSecretStore{}
	response := exchangeWithHost(t, NewWithDependencies("test", &fakeGitTransport{}, store), protocol.Request{
		ProtocolVersion: protocol.Version,
		RequestID:       "req-secret",
		Command:         protocol.CommandSetSecret,
		Payload:         json.RawMessage(`{"remoteUrl":"https://git.example.test/repo.git","username":"alice","token":"sensitive"}`),
	})
	if response.Event != "completed" || store.token != "sensitive" || store.username != "alice" {
		t.Fatalf("unexpected response or store: %#v %#v", response, store)
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte("sensitive")) {
		t.Fatal("secret was echoed in the native response")
	}
}
