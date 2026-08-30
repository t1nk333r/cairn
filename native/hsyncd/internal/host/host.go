package host

import (
	"errors"
	"fmt"
	"io"
	"unicode/utf8"

	"github.com/t1nk333r/hsync/native/hsyncd/internal/protocol"
)

const Name = "dev.t1nk333r.hsync"

type Host struct {
	version string
}

func New(version string) *Host {
	return &Host{version: version}
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
	if request.Command != protocol.CommandHello {
		return protocol.Failed(
			request.RequestID,
			"unsupported_command",
			fmt.Sprintf("command %q is not implemented in this companion build", request.Command),
			false,
		)
	}
	return protocol.Completed(request.RequestID, protocol.HelloResult{
		HostName:         Name,
		HostVersion:      h.version,
		ProtocolVersions: []int{protocol.Version},
		Capabilities:     []protocol.Command{protocol.CommandHello},
	})
}
