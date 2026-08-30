package protocol

import "encoding/json"

const Version = 1

type Command string

const (
	CommandHello          Command = "hello"
	CommandTestConnection Command = "testConnection"
	CommandReadInventory  Command = "readInventory"
	CommandWriteInventory Command = "writeInventory"
	CommandSync           Command = "sync"
	CommandGetStatus      Command = "getStatus"
	CommandCancel         Command = "cancel"
	CommandSetSecret      Command = "setSecret"
	CommandDeleteSecret   Command = "deleteSecret"
)

type Request struct {
	ProtocolVersion int             `json:"protocolVersion"`
	RequestID       string          `json:"requestId"`
	Command         Command         `json:"command"`
	Payload         json.RawMessage `json:"payload,omitempty"`
}

type Error struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type Response struct {
	ProtocolVersion int    `json:"protocolVersion"`
	RequestID       string `json:"requestId,omitempty"`
	Event           string `json:"event"`
	Result          any    `json:"result,omitempty"`
	Error           *Error `json:"error,omitempty"`
}

type HelloResult struct {
	HostName         string    `json:"hostName"`
	HostVersion      string    `json:"hostVersion"`
	ProtocolVersions []int     `json:"protocolVersions"`
	Capabilities     []Command `json:"capabilities"`
}

func Completed(requestID string, result any) Response {
	return Response{ProtocolVersion: Version, RequestID: requestID, Event: "completed", Result: result}
}

func Failed(requestID, code, message string, retryable bool) Response {
	return Response{
		ProtocolVersion: Version,
		RequestID:       requestID,
		Event:           "failed",
		Error:           &Error{Code: code, Message: message, Retryable: retryable},
	}
}
