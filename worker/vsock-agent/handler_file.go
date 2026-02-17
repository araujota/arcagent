package main

import (
	"encoding/base64"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// handleFileWrite handles "file_write" requests.
func handleFileWrite(req *Request) *Response {
	if req.Path == "" {
		return errorResponse("missing path")
	}

	safePath, err := validatePath(req.Path)
	if err != nil {
		return &Response{
			Type:  "error",
			Error: err.Error(),
		}
	}

	content, err := base64.StdEncoding.DecodeString(req.ContentBase64)
	if err != nil {
		return &Response{
			Type:  "error",
			Error: "invalid base64 content: " + err.Error(),
		}
	}

	// Ensure parent directory exists.
	dir := safePath[:strings.LastIndex(safePath, "/")]
	if err := os.MkdirAll(dir, 0755); err != nil {
		return &Response{
			Type:  "error",
			Error: "failed to create directory: " + err.Error(),
		}
	}

	// Parse file mode (default 0644).
	fileMode := os.FileMode(0644)
	if req.Mode != "" {
		parsed, err := strconv.ParseUint(req.Mode, 8, 32)
		if err == nil {
			fileMode = os.FileMode(parsed)
		}
	}

	if err := os.WriteFile(safePath, content, fileMode); err != nil {
		return &Response{
			Type:  "error",
			Error: "write failed: " + err.Error(),
		}
	}

	// Set ownership if specified (e.g., "agent:agent" or "root:root").
	if req.Owner != "" {
		if err := setOwnership(safePath, req.Owner); err != nil {
			log.Printf("warning: failed to set ownership on %s: %v", safePath, err)
		}
	}

	return &Response{
		Type: "file_result",
	}
}

// handleFileRead handles "file_read" requests.
func handleFileRead(req *Request) *Response {
	if req.Path == "" {
		return errorResponse("missing path")
	}

	safePath, err := validatePath(req.Path)
	if err != nil {
		return &Response{
			Type:  "error",
			Error: err.Error(),
		}
	}

	content, err := os.ReadFile(safePath)
	if err != nil {
		if os.IsNotExist(err) {
			return &Response{
				Type:  "error",
				Error: "file not found: " + safePath,
			}
		}
		return &Response{
			Type:  "error",
			Error: "read failed: " + err.Error(),
		}
	}

	encoded := base64.StdEncoding.EncodeToString(content)

	return &Response{
		Type:          "file_result",
		ContentBase64: encoded,
	}
}

// setOwnership sets the owner and group of a file. The owner string is in
// the form "user:group" (e.g., "agent:agent").
func setOwnership(path, owner string) error {
	parts := strings.SplitN(owner, ":", 2)
	if len(parts) != 2 {
		return fmt.Errorf("invalid owner format %q, expected user:group", owner)
	}

	// Use chown command since we need to resolve user/group names to UIDs/GIDs.
	cmd := exec.Command("chown", owner, path)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("chown failed: %s: %w", strings.TrimSpace(string(output)), err)
	}
	return nil
}
