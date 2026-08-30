package host

import (
	"bytes"
	"strings"
	"testing"

	"github.com/t1nk333r/hsync/native/hsyncd/internal/protocol"
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
	if !ok || result["hostVersion"] != "0.1.0-test" || !capabilitiesOK || len(capabilities) != 1 {
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
