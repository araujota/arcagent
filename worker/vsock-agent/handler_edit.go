package main

import (
	"os"
	"strings"
)

// handleFileEdit handles "file_edit" requests: surgical string replacement.
func handleFileEdit(req *Request) *Response {
	if req.Path == "" {
		return errorResponse("missing path")
	}
	if req.OldString == "" {
		return &Response{
			Type:  "file_result",
			Error: "missing oldString",
		}
	}
	if req.OldString == req.NewString {
		return &Response{
			Type:  "file_result",
			Error: "oldString and newString are identical",
		}
	}

	safePath, err := validatePath(req.Path)
	if err != nil {
		return &Response{
			Type:  "file_result",
			Error: err.Error(),
		}
	}

	content, err := os.ReadFile(safePath)
	if err != nil {
		if os.IsNotExist(err) {
			return &Response{
				Type:  "file_result",
				Error: "not_found",
			}
		}
		return &Response{
			Type:  "file_result",
			Error: "read failed: " + err.Error(),
		}
	}

	original := string(content)

	if req.ReplaceAll {
		// Replace all occurrences.
		count := strings.Count(original, req.OldString)
		if count == 0 {
			return &Response{
				Type:         "file_result",
				Error:        "not_found",
				Replacements: intPtr(0),
			}
		}

		result := strings.ReplaceAll(original, req.OldString, req.NewString)

		if err := os.WriteFile(safePath, []byte(result), 0); err != nil {
			return &Response{
				Type:  "file_result",
				Error: "write failed: " + err.Error(),
			}
		}

		return &Response{
			Type:         "file_result",
			Replacements: intPtr(count),
		}
	}

	// Single replacement: oldString must be unique in the file.
	count := strings.Count(original, req.OldString)
	if count == 0 {
		return &Response{
			Type:         "file_result",
			Error:        "not_found",
			Replacements: intPtr(0),
		}
	}
	if count > 1 {
		return &Response{
			Type:         "file_result",
			Error:        "ambiguous",
			Replacements: intPtr(0),
		}
	}

	// Exactly one match: replace it.
	result := strings.Replace(original, req.OldString, req.NewString, 1)

	// Preserve original file permissions.
	info, err := os.Stat(safePath)
	if err != nil {
		return &Response{
			Type:  "file_result",
			Error: "stat failed: " + err.Error(),
		}
	}

	if err := os.WriteFile(safePath, []byte(result), info.Mode()); err != nil {
		return &Response{
			Type:  "file_result",
			Error: "write failed: " + err.Error(),
		}
	}

	return &Response{
		Type:         "file_result",
		Replacements: intPtr(1),
	}
}
