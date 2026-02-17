package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
)

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

// Request is the top-level JSON envelope received from the host.
type Request struct {
	Type string `json:"type"`

	// exec / exec_with_stdin
	Command   string `json:"command,omitempty"`
	User      string `json:"user,omitempty"`
	TimeoutMs int    `json:"timeoutMs,omitempty"`
	Stdin     string `json:"stdin,omitempty"`

	// file_write / file_read / file_edit
	Path          string `json:"path,omitempty"`
	ContentBase64 string `json:"contentBase64,omitempty"`
	Mode          string `json:"mode,omitempty"`
	Owner         string `json:"owner,omitempty"`

	// file_edit
	OldString  string `json:"oldString,omitempty"`
	NewString  string `json:"newString,omitempty"`
	ReplaceAll bool   `json:"replaceAll,omitempty"`

	// file_glob
	Pattern    string `json:"pattern,omitempty"`
	MaxResults int    `json:"maxResults,omitempty"`

	// file_grep
	Glob          string `json:"glob,omitempty"`
	CaseSensitive *bool  `json:"caseSensitive,omitempty"`
	ContextLines  int    `json:"contextLines,omitempty"`
	OutputMode    string `json:"outputMode,omitempty"`

	// session_create
	SessionID string            `json:"sessionId,omitempty"`
	Shell     string            `json:"shell,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	Rows      int               `json:"rows,omitempty"`
	Cols      int               `json:"cols,omitempty"`
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

// Response is the top-level JSON envelope sent back to the host.
type Response struct {
	Type string `json:"type"`

	// exec_result
	Stdout   *string `json:"stdout,omitempty"`
	Stderr   *string `json:"stderr,omitempty"`
	ExitCode *int    `json:"exitCode,omitempty"`

	// file_result
	ContentBase64 string `json:"contentBase64,omitempty"`

	// file_edit result
	Replacements *int `json:"replacements,omitempty"`

	// file_glob result
	Files        []string `json:"files,omitempty"`
	TotalMatches *int     `json:"totalMatches,omitempty"`
	Truncated    *bool    `json:"truncated,omitempty"`

	// file_grep result
	Matches []GrepMatch `json:"matches,omitempty"`

	// session results
	SessionID string `json:"sessionId,omitempty"`
	Cwd       string `json:"cwd,omitempty"`
	OK        *bool  `json:"ok,omitempty"`

	// heartbeat
	UptimeMs     *int64 `json:"uptime_ms,omitempty"`
	SessionCount *int   `json:"session_count,omitempty"`

	// error
	Error string `json:"error,omitempty"`
}

// GrepMatch represents a single search hit from file_grep.
type GrepMatch struct {
	File          string   `json:"file"`
	Line          int      `json:"line,omitempty"`
	Text          string   `json:"text,omitempty"`
	ContextBefore []string `json:"contextBefore,omitempty"`
	ContextAfter  []string `json:"contextAfter,omitempty"`
}

// ---------------------------------------------------------------------------
// Helpers for pointer fields
// ---------------------------------------------------------------------------

func strPtr(s string) *string { return &s }
func intPtr(i int) *int       { return &i }
func int64Ptr(i int64) *int64 { return &i }
func boolPtr(b bool) *bool    { return &b }

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

// readRequest reads a length-prefixed JSON request from conn.
func readRequest(conn net.Conn) (*Request, error) {
	// Read 4-byte big-endian length header.
	var lenBuf [4]byte
	if _, err := io.ReadFull(conn, lenBuf[:]); err != nil {
		return nil, fmt.Errorf("read length header: %w", err)
	}
	payloadLen := binary.BigEndian.Uint32(lenBuf[:])

	// Sanity limit: 16 MiB.
	if payloadLen > 16*1024*1024 {
		return nil, fmt.Errorf("payload too large: %d bytes", payloadLen)
	}

	payload := make([]byte, payloadLen)
	if _, err := io.ReadFull(conn, payload); err != nil {
		return nil, fmt.Errorf("read payload: %w", err)
	}

	var req Request
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, fmt.Errorf("unmarshal request: %w", err)
	}
	return &req, nil
}

// writeResponse writes a length-prefixed JSON response to conn.
func writeResponse(conn net.Conn, resp *Response) error {
	payload, err := json.Marshal(resp)
	if err != nil {
		return fmt.Errorf("marshal response: %w", err)
	}

	var lenBuf [4]byte
	binary.BigEndian.PutUint32(lenBuf[:], uint32(len(payload)))

	if _, err := conn.Write(lenBuf[:]); err != nil {
		return fmt.Errorf("write length header: %w", err)
	}
	if _, err := conn.Write(payload); err != nil {
		return fmt.Errorf("write payload: %w", err)
	}
	return nil
}

// errorResponse creates a Response with type "error".
func errorResponse(msg string) *Response {
	return &Response{
		Type:  "error",
		Error: msg,
	}
}
