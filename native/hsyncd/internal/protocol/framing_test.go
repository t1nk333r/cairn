package protocol

import (
	"bytes"
	"encoding/binary"
	"errors"
	"strings"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	want := Request{ProtocolVersion: Version, RequestID: "req-1", Command: CommandHello}
	var framed bytes.Buffer
	if err := NewWriter(&framed).Write(want); err != nil {
		t.Fatal(err)
	}
	var got Request
	if err := NewReader(&framed).Read(&got); err != nil {
		t.Fatal(err)
	}
	if got.ProtocolVersion != want.ProtocolVersion || got.RequestID != want.RequestID || got.Command != want.Command {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestReaderRejectsOversizedFrameBeforeAllocation(t *testing.T) {
	var framed bytes.Buffer
	if err := binary.Write(&framed, binary.NativeEndian, uint32(MaxMessageSize+1)); err != nil {
		t.Fatal(err)
	}
	var request Request
	err := NewReader(&framed).Read(&request)
	if !errors.Is(err, ErrMessageTooLarge) {
		t.Fatalf("got %v, want ErrMessageTooLarge", err)
	}
}

func TestWriterRejectsOversizedResponse(t *testing.T) {
	err := NewWriter(&bytes.Buffer{}).Write(strings.Repeat("x", MaxMessageSize))
	if !errors.Is(err, ErrMessageTooLarge) {
		t.Fatalf("got %v, want ErrMessageTooLarge", err)
	}
}
