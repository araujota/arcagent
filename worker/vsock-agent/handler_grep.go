package main

import (
	"bufio"
	"encoding/json"
	"os/exec"
	"strconv"
	"strings"
)

const defaultGrepMaxResults = 200

// handleFileGrep handles "file_grep" requests: ripgrep-powered search.
// Shells out to `rg --json` and parses the structured output.
func handleFileGrep(req *Request) *Response {
	if req.Pattern == "" {
		return errorResponse("missing pattern")
	}

	basePath := req.Path
	if basePath == "" {
		basePath = workspaceRoot
	}

	// Validate search path is within /workspace/.
	safePath, err := validatePath(basePath)
	if err != nil {
		return &Response{
			Type:  "file_result",
			Error: err.Error(),
		}
	}

	maxResults := req.MaxResults
	if maxResults <= 0 {
		maxResults = defaultGrepMaxResults
	}

	outputMode := req.OutputMode
	if outputMode == "" {
		outputMode = "content"
	}

	// Build rg command arguments.
	args := []string{"--json"}

	// Case sensitivity: default is case-sensitive.
	if req.CaseSensitive != nil && !*req.CaseSensitive {
		args = append(args, "-i")
	}

	// Context lines.
	if req.ContextLines > 0 {
		args = append(args, "-C", strconv.Itoa(req.ContextLines))
	}

	// File glob filter.
	if req.Glob != "" {
		args = append(args, "--glob", req.Glob)
	}

	// The search pattern and path.
	args = append(args, "--", req.Pattern, safePath)

	cmd := exec.Command("rg", args...)
	cmd.Dir = workspaceRoot

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return &Response{
			Type:  "file_result",
			Error: "failed to start rg: " + err.Error(),
		}
	}

	if err := cmd.Start(); err != nil {
		// rg not installed or not found.
		return &Response{
			Type:  "file_result",
			Error: "rg not available: " + err.Error(),
		}
	}

	// Parse rg --json output line by line.
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // 1MB line buffer

	type rgMessage struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}

	type rgMatch struct {
		Path struct {
			Text string `json:"text"`
		} `json:"path"`
		Lines struct {
			Text string `json:"text"`
		} `json:"lines"`
		LineNumber    int `json:"line_number"`
		AbsoluteOffset int `json:"absolute_offset"`
	}

	type rgContext struct {
		Path struct {
			Text string `json:"text"`
		} `json:"path"`
		Lines struct {
			Text string `json:"text"`
		} `json:"lines"`
		LineNumber int `json:"line_number"`
	}

	type rgSummary struct {
		Stats struct {
			Matched int `json:"matched_lines"`
		} `json:"stats"`
	}

	// For "content" mode, accumulate matches with context.
	// For "files_with_matches", collect unique files.
	// For "count", count matches per file.
	var matches []GrepMatch
	fileMatchCounts := make(map[string]int)
	filesWithMatches := make(map[string]bool)
	totalMatches := 0

	// Context accumulation: group context lines with their match.
	type pendingMatch struct {
		match         GrepMatch
		contextBefore []string
	}
	var pending *pendingMatch
	var lastMatchFile string
	var lastMatchLine int

	flushPending := func() {
		if pending != nil && len(matches) < maxResults {
			matches = append(matches, pending.match)
			pending = nil
		}
	}

	for scanner.Scan() {
		var msg rgMessage
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "match":
			var m rgMatch
			if err := json.Unmarshal(msg.Data, &m); err != nil {
				continue
			}

			totalMatches++
			filePath := m.Path.Text
			filesWithMatches[filePath] = true
			fileMatchCounts[filePath]++

			if outputMode == "content" && len(matches) < maxResults {
				// Flush any previous pending match.
				flushPending()

				lineText := strings.TrimRight(m.Lines.Text, "\n\r")
				pending = &pendingMatch{
					match: GrepMatch{
						File: filePath,
						Line: m.LineNumber,
						Text: lineText,
					},
				}
				lastMatchFile = filePath
				lastMatchLine = m.LineNumber
			}

		case "context":
			if outputMode != "content" || pending == nil {
				continue
			}

			var c rgContext
			if err := json.Unmarshal(msg.Data, &c); err != nil {
				continue
			}

			lineText := strings.TrimRight(c.Lines.Text, "\n\r")

			if c.Path.Text == lastMatchFile {
				if c.LineNumber < lastMatchLine {
					// Before context.
					pending.match.ContextBefore = append(pending.match.ContextBefore, lineText)
				} else {
					// After context.
					pending.match.ContextAfter = append(pending.match.ContextAfter, lineText)
				}
			}

		case "summary":
			// Flush any final pending match.
			flushPending()
		}
	}

	// Flush final pending match if summary wasn't emitted.
	flushPending()

	// Wait for rg to finish (exit code 1 = no matches, which is fine).
	_ = cmd.Wait()

	truncated := totalMatches > maxResults

	switch outputMode {
	case "files_with_matches":
		files := make([]string, 0, len(filesWithMatches))
		for f := range filesWithMatches {
			files = append(files, f)
		}
		return &Response{
			Type:         "file_result",
			Files:        files,
			TotalMatches: intPtr(totalMatches),
			Truncated:    boolPtr(truncated),
		}

	case "count":
		// Return matches as file + count entries.
		countMatches := make([]GrepMatch, 0, len(fileMatchCounts))
		for file, count := range fileMatchCounts {
			countMatches = append(countMatches, GrepMatch{
				File: file,
				Text: strconv.Itoa(count),
			})
		}
		return &Response{
			Type:         "file_result",
			Matches:      countMatches,
			TotalMatches: intPtr(totalMatches),
			Truncated:    boolPtr(truncated),
		}

	default: // "content"
		return &Response{
			Type:         "file_result",
			Matches:      matches,
			TotalMatches: intPtr(totalMatches),
			Truncated:    boolPtr(truncated),
		}
	}
}
