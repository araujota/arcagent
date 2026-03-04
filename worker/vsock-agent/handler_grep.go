package main

import (
	"bufio"
	"encoding/json"
	"os/exec"
	"strconv"
	"strings"
)

const defaultGrepMaxResults = 200
const grepOutputModeContent = "content"

type rgMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type rgMatchData struct {
	Path struct {
		Text string `json:"text"`
	} `json:"path"`
	Lines struct {
		Text string `json:"text"`
	} `json:"lines"`
	LineNumber int `json:"line_number"`
}

type rgContextData struct {
	Path struct {
		Text string `json:"text"`
	} `json:"path"`
	Lines struct {
		Text string `json:"text"`
	} `json:"lines"`
	LineNumber int `json:"line_number"`
}

type grepAccumulator struct {
	outputMode      string
	maxResults      int
	matches         []GrepMatch
	fileMatchCounts map[string]int
	filesWithMatch  map[string]bool
	totalMatches    int
	pending         *GrepMatch
	lastMatchFile   string
	lastMatchLine   int
}

func newGrepAccumulator(outputMode string, maxResults int) *grepAccumulator {
	return &grepAccumulator{
		outputMode:      outputMode,
		maxResults:      maxResults,
		fileMatchCounts: make(map[string]int),
		filesWithMatch:  make(map[string]bool),
	}
}

func normalizeGrepOutputMode(outputMode string) string {
	if outputMode == "" {
		return grepOutputModeContent
	}
	return outputMode
}

func normalizeGrepMaxResults(maxResults int) int {
	if maxResults <= 0 {
		return defaultGrepMaxResults
	}
	return maxResults
}

func buildRipgrepArgs(req *Request, safePath string) []string {
	args := []string{"--json"}
	if req.CaseSensitive != nil && !*req.CaseSensitive {
		args = append(args, "-i")
	}
	if req.ContextLines > 0 {
		args = append(args, "-C", strconv.Itoa(req.ContextLines))
	}
	if req.Glob != "" {
		args = append(args, "--glob", req.Glob)
	}
	return append(args, "--", req.Pattern, safePath)
}

func (acc *grepAccumulator) flushPending() {
	if acc.pending == nil || len(acc.matches) >= acc.maxResults {
		return
	}
	acc.matches = append(acc.matches, *acc.pending)
	acc.pending = nil
}

func (acc *grepAccumulator) shouldCaptureContent() bool {
	return acc.outputMode == grepOutputModeContent && len(acc.matches) < acc.maxResults
}

func (acc *grepAccumulator) handleMatch(m rgMatchData) {
	acc.totalMatches++
	filePath := m.Path.Text
	acc.filesWithMatch[filePath] = true
	acc.fileMatchCounts[filePath]++
	if !acc.shouldCaptureContent() {
		return
	}
	acc.flushPending()
	lineText := strings.TrimRight(m.Lines.Text, "\n\r")
	acc.pending = &GrepMatch{
		File: filePath,
		Line: m.LineNumber,
		Text: lineText,
	}
	acc.lastMatchFile = filePath
	acc.lastMatchLine = m.LineNumber
}

func (acc *grepAccumulator) handleContext(c rgContextData) {
	if acc.outputMode != grepOutputModeContent || acc.pending == nil {
		return
	}
	if c.Path.Text != acc.lastMatchFile {
		return
	}
	lineText := strings.TrimRight(c.Lines.Text, "\n\r")
	if c.LineNumber < acc.lastMatchLine {
		acc.pending.ContextBefore = append(acc.pending.ContextBefore, lineText)
		return
	}
	acc.pending.ContextAfter = append(acc.pending.ContextAfter, lineText)
}

func (acc *grepAccumulator) processMessage(message rgMessage) {
	switch message.Type {
	case "match":
		var match rgMatchData
		if err := json.Unmarshal(message.Data, &match); err == nil {
			acc.handleMatch(match)
		}
	case "context":
		var context rgContextData
		if err := json.Unmarshal(message.Data, &context); err == nil {
			acc.handleContext(context)
		}
	case "summary":
		acc.flushPending()
	}
}

func parseRipgrepOutput(scanner *bufio.Scanner, acc *grepAccumulator) {
	for scanner.Scan() {
		var message rgMessage
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			continue
		}
		acc.processMessage(message)
	}
	acc.flushPending()
}

func buildFilesWithMatchesResponse(acc *grepAccumulator, truncated bool) *Response {
	files := make([]string, 0, len(acc.filesWithMatch))
	for filePath := range acc.filesWithMatch {
		files = append(files, filePath)
	}
	return &Response{
		Type:         "file_result",
		Files:        files,
		TotalMatches: intPtr(acc.totalMatches),
		Truncated:    boolPtr(truncated),
	}
}

func buildCountResponse(acc *grepAccumulator, truncated bool) *Response {
	countMatches := make([]GrepMatch, 0, len(acc.fileMatchCounts))
	for filePath, count := range acc.fileMatchCounts {
		countMatches = append(countMatches, GrepMatch{
			File: filePath,
			Text: strconv.Itoa(count),
		})
	}
	return &Response{
		Type:         "file_result",
		Matches:      countMatches,
		TotalMatches: intPtr(acc.totalMatches),
		Truncated:    boolPtr(truncated),
	}
}

func buildContentResponse(acc *grepAccumulator, truncated bool) *Response {
	return &Response{
		Type:         "file_result",
		Matches:      acc.matches,
		TotalMatches: intPtr(acc.totalMatches),
		Truncated:    boolPtr(truncated),
	}
}

func buildGrepResponse(acc *grepAccumulator) *Response {
	truncated := acc.totalMatches > acc.maxResults
	switch acc.outputMode {
	case "files_with_matches":
		return buildFilesWithMatchesResponse(acc, truncated)
	case "count":
		return buildCountResponse(acc, truncated)
	default:
		return buildContentResponse(acc, truncated)
	}
}

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

	maxResults := normalizeGrepMaxResults(req.MaxResults)
	outputMode := normalizeGrepOutputMode(req.OutputMode)
	args := buildRipgrepArgs(req, safePath)

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

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // 1MB line buffer
	acc := newGrepAccumulator(outputMode, maxResults)
	parseRipgrepOutput(scanner, acc)
	_ = cmd.Wait()
	return buildGrepResponse(acc)
}
