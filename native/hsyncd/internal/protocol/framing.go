package protocol

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const MaxMessageSize = 1024 * 1024

var ErrMessageTooLarge = errors.New("native message exceeds size limit")

type Reader struct {
	source io.Reader
}

func NewReader(source io.Reader) *Reader {
	return &Reader{source: source}
}

func (r *Reader) Read(value any) error {
	var size uint32
	if err := binary.Read(r.source, binary.NativeEndian, &size); err != nil {
		return err
	}
	if size == 0 {
		return errors.New("native message cannot be empty")
	}
	if size > MaxMessageSize {
		return fmt.Errorf("%w: %d bytes", ErrMessageTooLarge, size)
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(r.source, payload); err != nil {
		return err
	}
	if err := json.Unmarshal(payload, value); err != nil {
		return fmt.Errorf("decode native message: %w", err)
	}
	return nil
}

type Writer struct {
	destination io.Writer
}

func NewWriter(destination io.Writer) *Writer {
	return &Writer{destination: destination}
}

func (w *Writer) Write(value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode native message: %w", err)
	}
	if len(payload) > MaxMessageSize {
		return fmt.Errorf("%w: %d bytes", ErrMessageTooLarge, len(payload))
	}
	if err := binary.Write(w.destination, binary.NativeEndian, uint32(len(payload))); err != nil {
		return err
	}
	if _, err := w.destination.Write(payload); err != nil {
		return err
	}
	return nil
}
