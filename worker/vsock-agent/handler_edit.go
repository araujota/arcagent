package main

import (
	"os"
	"strings"
)

func fileResultError(message string) *Response {
	return &Response{
		Type:  "file_result",
		Error: message,
	}
}

func fileResultWithReplacementsError(message string) *Response {
	return &Response{
		Type:         "file_result",
		Error:        message,
		Replacements: intPtr(0),
	}
}

func replaceAllInFile(path, original, oldString, newString string) *Response {
	count := strings.Count(original, oldString)
	if count == 0 {
		return fileResultWithReplacementsError("not_found")
	}

	result := strings.ReplaceAll(original, oldString, newString)
	if err := os.WriteFile(path, []byte(result), 0); err != nil {
		return fileResultError("write failed: " + err.Error())
	}

	return &Response{
		Type:         "file_result",
		Replacements: intPtr(count),
	}
}

func replaceSingleInFile(path, original, oldString, newString string) *Response {
	count := strings.Count(original, oldString)
	if count == 0 {
		return fileResultWithReplacementsError("not_found")
	}
	if count > 1 {
		return fileResultWithReplacementsError("ambiguous")
	}

	result := strings.Replace(original, oldString, newString, 1)
	info, err := os.Stat(path)
	if err != nil {
		return fileResultError("stat failed: " + err.Error())
	}
	if err := os.WriteFile(path, []byte(result), info.Mode()); err != nil {
		return fileResultError("write failed: " + err.Error())
	}

	return &Response{
		Type:         "file_result",
		Replacements: intPtr(1),
	}
}

// handleFileEdit handles "file_edit" requests: surgical string replacement.
func handleFileEdit(req *Request) *Response {
	if req.Path == "" {
		return errorResponse("missing path")
	}
	if req.OldString == "" {
		return fileResultError("missing oldString")
	}
	if req.OldString == req.NewString {
		return fileResultError("oldString and newString are identical")
	}

	safePath, err := validatePath(req.Path)
	if err != nil {
		return fileResultError(err.Error())
	}

	content, err := os.ReadFile(safePath)
	if err != nil {
		if os.IsNotExist(err) {
			return fileResultError("not_found")
		}
		return fileResultError("read failed: " + err.Error())
	}

	original := string(content)
	if req.ReplaceAll {
		return replaceAllInFile(safePath, original, req.OldString, req.NewString)
	}
	return replaceSingleInFile(safePath, original, req.OldString, req.NewString)
}
