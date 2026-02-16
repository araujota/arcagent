// guest-agent is a minimal binary that runs inside Firecracker microVMs.
// It listens on vsock port 5000 and handles exec, file_read, and file_write
// requests from the host via length-prefixed JSON framing.
package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// VsockRequest is the JSON payload received from the host.
type VsockRequest struct {
	Type          string `json:"type"`
	Command       string `json:"command,omitempty"`
	User          string `json:"user,omitempty"`
	TimeoutMs     int    `json:"timeoutMs,omitempty"`
	Stdin         string `json:"stdin,omitempty"`
	Path          string `json:"path,omitempty"`
	ContentBase64 string `json:"contentBase64,omitempty"`
	Mode          string `json:"mode,omitempty"`
	Owner         string `json:"owner,omitempty"`
}

// VsockResponse is the JSON payload sent back to the host.
type VsockResponse struct {
	Type          string `json:"type"`
	Stdout        string `json:"stdout,omitempty"`
	Stderr        string `json:"stderr,omitempty"`
	ExitCode      int    `json:"exitCode,omitempty"`
	ContentBase64 string `json:"contentBase64,omitempty"`
	Error         string `json:"error,omitempty"`
}

const (
	vsockPort   = 5000
	maxPayload  = 50 * 1024 * 1024 // 50 MiB max request size
	defaultUser = ""               // empty = run as current user (root)
)

func main() {
	log.SetPrefix("[vsock-agent] ")
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)

	// Listen on vsock VMADDR_CID_ANY (accept connections from any CID)
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM, 0)
	if err != nil {
		log.Fatalf("Failed to create vsock socket: %v", err)
	}

	sa := &unix.SockaddrVM{
		CID:  unix.VMADDR_CID_ANY,
		Port: vsockPort,
	}

	if err := unix.Bind(fd, sa); err != nil {
		log.Fatalf("Failed to bind vsock: %v", err)
	}

	if err := unix.Listen(fd, 16); err != nil {
		log.Fatalf("Failed to listen on vsock: %v", err)
	}

	// Wrap in a net.Listener via os.File
	file := os.NewFile(uintptr(fd), "vsock-listener")
	listener, err := net.FileListener(file)
	if err != nil {
		log.Fatalf("Failed to create listener: %v", err)
	}
	file.Close() // FileListener dups the fd

	log.Printf("Listening on vsock port %d", vsockPort)

	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Printf("Accept error: %v", err)
			continue
		}
		go handleConnection(conn)
	}
}

func handleConnection(conn net.Conn) {
	defer conn.Close()

	// Read length-prefixed request
	req, err := readRequest(conn)
	if err != nil {
		sendError(conn, fmt.Sprintf("Failed to read request: %v", err))
		return
	}

	// Dispatch to handler
	var resp VsockResponse
	switch req.Type {
	case "exec":
		resp = handleExec(req)
	case "exec_with_stdin":
		resp = handleExecWithStdin(req)
	case "file_write":
		resp = handleFileWrite(req)
	case "file_read":
		resp = handleFileRead(req)
	default:
		resp = VsockResponse{Type: "error", Error: fmt.Sprintf("Unknown request type: %s", req.Type)}
	}

	writeResponse(conn, resp)
}

func readRequest(conn net.Conn) (*VsockRequest, error) {
	// Read 4-byte length header (big-endian)
	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}

	length := binary.BigEndian.Uint32(header)
	if length > maxPayload {
		return nil, fmt.Errorf("payload too large: %d bytes", length)
	}

	// Read JSON payload
	payload := make([]byte, length)
	if _, err := io.ReadFull(conn, payload); err != nil {
		return nil, fmt.Errorf("read payload: %w", err)
	}

	var req VsockRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, fmt.Errorf("unmarshal: %w", err)
	}

	return &req, nil
}

func writeResponse(conn net.Conn, resp VsockResponse) {
	payload, err := json.Marshal(resp)
	if err != nil {
		log.Printf("Failed to marshal response: %v", err)
		return
	}

	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(payload)))

	conn.Write(header)
	conn.Write(payload)
}

func sendError(conn net.Conn, msg string) {
	writeResponse(conn, VsockResponse{Type: "error", Error: msg})
}

func handleExec(req *VsockRequest) VsockResponse {
	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 120 * time.Second
	}

	var cmd *exec.Cmd
	if req.User != "" && req.User != "root" {
		// Run as specified user via su
		cmd = exec.Command("su", "-", req.User, "-c", req.Command)
	} else {
		cmd = exec.Command("bash", "-c", req.Command)
	}

	// Capture output
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	// Start command with timeout
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		return VsockResponse{
			Type:     "exec_result",
			Stdout:   "",
			Stderr:   err.Error(),
			ExitCode: 1,
		}
	}

	go func() {
		done <- cmd.Wait()
	}()

	select {
	case err := <-done:
		exitCode := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			} else {
				exitCode = 1
			}
		}
		return VsockResponse{
			Type:     "exec_result",
			Stdout:   stdout.String(),
			Stderr:   stderr.String(),
			ExitCode: exitCode,
		}
	case <-time.After(timeout):
		cmd.Process.Kill()
		return VsockResponse{
			Type:     "exec_result",
			Stdout:   stdout.String(),
			Stderr:   fmt.Sprintf("Command timed out after %v\n%s", timeout, stderr.String()),
			ExitCode: 124, // standard timeout exit code
		}
	}
}

func handleExecWithStdin(req *VsockRequest) VsockResponse {
	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 120 * time.Second
	}

	var cmd *exec.Cmd
	if req.User != "" && req.User != "root" {
		cmd = exec.Command("su", "-", req.User, "-c", req.Command)
	} else {
		cmd = exec.Command("bash", "-c", req.Command)
	}

	cmd.Stdin = strings.NewReader(req.Stdin)

	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		return VsockResponse{
			Type:     "exec_result",
			Stdout:   "",
			Stderr:   err.Error(),
			ExitCode: 1,
		}
	}

	go func() {
		done <- cmd.Wait()
	}()

	select {
	case err := <-done:
		exitCode := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			} else {
				exitCode = 1
			}
		}
		return VsockResponse{
			Type:     "exec_result",
			Stdout:   stdout.String(),
			Stderr:   stderr.String(),
			ExitCode: exitCode,
		}
	case <-time.After(timeout):
		cmd.Process.Kill()
		return VsockResponse{
			Type:     "exec_result",
			Stdout:   stdout.String(),
			Stderr:   fmt.Sprintf("Command timed out after %v\n%s", timeout, stderr.String()),
			ExitCode: 124,
		}
	}
}

func handleFileWrite(req *VsockRequest) VsockResponse {
	if req.Path == "" {
		return VsockResponse{Type: "error", Error: "Missing path"}
	}

	content, err := base64.StdEncoding.DecodeString(req.ContentBase64)
	if err != nil {
		return VsockResponse{Type: "error", Error: fmt.Sprintf("Invalid base64: %v", err)}
	}

	// Create parent directories
	dir := filepath.Dir(req.Path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return VsockResponse{Type: "error", Error: fmt.Sprintf("Failed to create directory: %v", err)}
	}

	// Write file
	perm := os.FileMode(0644)
	if req.Mode != "" {
		var mode uint32
		fmt.Sscanf(req.Mode, "%o", &mode)
		perm = os.FileMode(mode)
	}

	if err := os.WriteFile(req.Path, content, perm); err != nil {
		return VsockResponse{Type: "error", Error: fmt.Sprintf("Failed to write file: %v", err)}
	}

	// Set owner if specified (e.g. "agent:agent")
	if req.Owner != "" {
		parts := strings.SplitN(req.Owner, ":", 2)
		chownCmd := exec.Command("chown", req.Owner, req.Path)
		if len(parts) == 1 {
			chownCmd = exec.Command("chown", parts[0], req.Path)
		}
		chownCmd.Run() // best-effort
	}

	return VsockResponse{
		Type:     "file_result",
		Stdout:   fmt.Sprintf("Written %d bytes to %s", len(content), req.Path),
		ExitCode: 0,
	}
}

func handleFileRead(req *VsockRequest) VsockResponse {
	if req.Path == "" {
		return VsockResponse{Type: "error", Error: "Missing path"}
	}

	content, err := os.ReadFile(req.Path)
	if err != nil {
		return VsockResponse{Type: "error", Error: fmt.Sprintf("Failed to read file: %v", err)}
	}

	return VsockResponse{
		Type:          "file_result",
		ContentBase64: base64.StdEncoding.EncodeToString(content),
		ExitCode:      0,
	}
}
