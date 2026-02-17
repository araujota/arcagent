package main

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const maxSessions = 4
const sessionIdleTimeout = 30 * time.Minute
const sessionReapInterval = 1 * time.Minute
const defaultSessionRows = 24
const defaultSessionCols = 80

// delimiterPrefix is the record separator byte used in PROMPT_COMMAND output.
// Format: \x1e__ARC_DONE__%d__%s__\x1e\n where %d=exit code, %s=cwd.
const delimiterPrefix = "\x1e__ARC_DONE__"
const delimiterSuffix = "__\x1e"

// ---------------------------------------------------------------------------
// Session type
// ---------------------------------------------------------------------------

// ptySession represents a persistent bash PTY session.
type ptySession struct {
	id         string
	ptmx       *os.File
	cmd        *exec.Cmd
	lastActive time.Time
	mu         sync.Mutex
}

var (
	sessionsMu sync.Mutex
	sessions   = make(map[string]*ptySession)
)

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// handleSessionCreate creates a new persistent PTY shell session.
func handleSessionCreate(req *Request) *Response {
	sessionsMu.Lock()
	activeCount := len(sessions)
	sessionsMu.Unlock()

	if activeCount >= maxSessions {
		return errorResponse(fmt.Sprintf("max sessions reached (%d)", maxSessions))
	}

	sessionID := req.SessionID
	if sessionID == "" {
		sessionID = fmt.Sprintf("sess-%d", time.Now().UnixNano())
	}

	sessionsMu.Lock()
	if _, exists := sessions[sessionID]; exists {
		sessionsMu.Unlock()
		return errorResponse("session already exists: " + sessionID)
	}
	sessionsMu.Unlock()

	shell := req.Shell
	if shell == "" {
		shell = "/bin/bash"
	}

	rows := req.Rows
	if rows <= 0 {
		rows = defaultSessionRows
	}
	cols := req.Cols
	if cols <= 0 {
		cols = defaultSessionCols
	}

	// Build the command.
	cmd := exec.Command(shell)
	cmd.SysProcAttr = commandCredentials(defaultUser)
	cmd.Dir = workspaceRoot

	// Build environment.
	env := []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=/home/" + defaultUser,
		"USER=" + defaultUser,
		"LANG=en_US.UTF-8",
		"TERM=xterm-256color",
		"SHELL=" + shell,
	}

	// Inject PROMPT_COMMAND to emit the delimiter after each command.
	// This lets us detect when a command has finished and extract exit code + cwd.
	promptCmd := `PROMPT_COMMAND='printf "\x1e__ARC_DONE__%d__%s__\x1e\n" "$?" "$PWD"'`
	env = append(env, promptCmd)

	// Add any custom environment variables from the request.
	for k, v := range req.Env {
		env = append(env, k+"="+v)
	}

	cmd.Env = env

	// Start the command with a PTY.
	winSize := &pty.Winsize{
		Rows: uint16(rows),
		Cols: uint16(cols),
	}

	ptmx, err := pty.StartWithSize(cmd, winSize)
	if err != nil {
		return errorResponse("failed to start PTY: " + err.Error())
	}

	sess := &ptySession{
		id:         sessionID,
		ptmx:       ptmx,
		cmd:        cmd,
		lastActive: time.Now(),
	}

	sessionsMu.Lock()
	sessions[sessionID] = sess
	sessionsMu.Unlock()

	// Read and discard the initial prompt/PROMPT_COMMAND output.
	// Give the shell a moment to initialize.
	time.Sleep(100 * time.Millisecond)
	discardAvailable(ptmx)

	log.Printf("session created: %s (shell=%s, rows=%d, cols=%d)", sessionID, shell, rows, cols)

	return &Response{
		Type:      "session_result",
		SessionID: sessionID,
	}
}

// handleSessionExec executes a command in an existing PTY session.
func handleSessionExec(req *Request) *Response {
	if req.SessionID == "" {
		return errorResponse("missing sessionId")
	}
	if req.Command == "" {
		return errorResponse("missing command")
	}

	if isBlockedCommand(req.Command) {
		return errorResponse("command blocked by security policy")
	}

	sessionsMu.Lock()
	sess, exists := sessions[req.SessionID]
	sessionsMu.Unlock()

	if !exists {
		return errorResponse("session not found: " + req.SessionID)
	}

	sess.mu.Lock()
	defer sess.mu.Unlock()

	sess.lastActive = time.Now()

	timeoutMs := req.TimeoutMs
	if timeoutMs <= 0 {
		timeoutMs = defaultExecTimeoutMs
	}

	// Discard any leftover output from previous commands.
	discardAvailable(sess.ptmx)

	// Write the command followed by newline to the PTY.
	_, err := sess.ptmx.Write([]byte(req.Command + "\n"))
	if err != nil {
		return errorResponse("failed to write to PTY: " + err.Error())
	}

	// Read PTY output until we see the delimiter.
	output, exitCode, cwd, err := readUntilDelimiter(sess.ptmx, time.Duration(timeoutMs)*time.Millisecond)
	if err != nil {
		return &Response{
			Type:     "exec_result",
			Stdout:   strPtr(stripANSI(output)),
			ExitCode: intPtr(1),
			Error:    err.Error(),
		}
	}

	// Strip the echoed command from the beginning of output.
	// The PTY echoes the input, so the first line is typically the command itself.
	cleaned := stripEchoedCommand(output, req.Command)

	// Strip ANSI escape sequences.
	cleaned = stripANSI(cleaned)

	return &Response{
		Type:     "exec_result",
		Stdout:   strPtr(cleaned),
		ExitCode: intPtr(exitCode),
		Cwd:      cwd,
	}
}

// handleSessionResize resizes a PTY session.
func handleSessionResize(req *Request) *Response {
	if req.SessionID == "" {
		return errorResponse("missing sessionId")
	}

	sessionsMu.Lock()
	sess, exists := sessions[req.SessionID]
	sessionsMu.Unlock()

	if !exists {
		return errorResponse("session not found: " + req.SessionID)
	}

	sess.mu.Lock()
	defer sess.mu.Unlock()

	rows := req.Rows
	if rows <= 0 {
		rows = defaultSessionRows
	}
	cols := req.Cols
	if cols <= 0 {
		cols = defaultSessionCols
	}

	winSize := &pty.Winsize{
		Rows: uint16(rows),
		Cols: uint16(cols),
	}

	if err := pty.Setsize(sess.ptmx, winSize); err != nil {
		return errorResponse("resize failed: " + err.Error())
	}

	sess.lastActive = time.Now()

	return &Response{
		Type: "session_result",
		OK:   boolPtr(true),
	}
}

// handleSessionDestroy destroys a PTY session.
func handleSessionDestroy(req *Request) *Response {
	if req.SessionID == "" {
		return errorResponse("missing sessionId")
	}

	sessionsMu.Lock()
	sess, exists := sessions[req.SessionID]
	if exists {
		delete(sessions, req.SessionID)
	}
	sessionsMu.Unlock()

	if !exists {
		return errorResponse("session not found: " + req.SessionID)
	}

	destroySession(sess)

	return &Response{
		Type: "session_result",
		OK:   boolPtr(true),
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// readUntilDelimiter reads from the PTY until the ARC_DONE delimiter is found.
// Returns the output (without the delimiter), the exit code, and the cwd.
func readUntilDelimiter(ptmx *os.File, timeout time.Duration) (string, int, string, error) {
	deadline := time.Now().Add(timeout)
	var buf bytes.Buffer
	readBuf := make([]byte, 4096)

	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return buf.String(), 1, "", fmt.Errorf("timeout waiting for command completion")
		}

		// Set read deadline on the PTY fd.
		_ = ptmx.SetReadDeadline(time.Now().Add(min(remaining, 500*time.Millisecond)))

		n, err := ptmx.Read(readBuf)
		if n > 0 {
			buf.Write(readBuf[:n])

			// Check if the accumulated output contains the delimiter.
			content := buf.String()
			exitCode, cwd, output, found := parseDelimiter(content)
			if found {
				return output, exitCode, cwd, nil
			}
		}

		if err != nil {
			if isTimeout(err) {
				continue
			}
			if err == io.EOF {
				return buf.String(), 1, "", fmt.Errorf("PTY closed unexpectedly")
			}
			// Treat other read errors as non-fatal -- the process might still be running.
			continue
		}
	}
}

// parseDelimiter looks for the ARC_DONE delimiter in the output.
// Format: \x1e__ARC_DONE__%d__%s__\x1e\n
// Returns exitCode, cwd, the output before the delimiter, and whether it was found.
func parseDelimiter(content string) (int, string, string, bool) {
	idx := strings.Index(content, delimiterPrefix)
	if idx == -1 {
		return 0, "", "", false
	}

	// Find the end of the delimiter.
	afterPrefix := content[idx+len(delimiterPrefix):]
	endIdx := strings.Index(afterPrefix, delimiterSuffix)
	if endIdx == -1 {
		return 0, "", "", false
	}

	// Parse the delimiter payload: exitCode__cwd
	payload := afterPrefix[:endIdx]
	parts := strings.SplitN(payload, "__", 2)
	if len(parts) != 2 {
		return 0, "", "", false
	}

	exitCode, err := strconv.Atoi(parts[0])
	if err != nil {
		exitCode = 1
	}
	cwd := parts[1]

	// Output is everything before the delimiter line.
	output := content[:idx]

	// Also trim any trailing newline before the delimiter.
	output = strings.TrimRight(output, "\r\n")

	return exitCode, cwd, output, true
}

// stripEchoedCommand removes the echoed command from the beginning of PTY output.
// PTYs echo input by default, so the first line(s) will be the typed command.
func stripEchoedCommand(output, command string) string {
	lines := strings.SplitN(output, "\n", 2)
	if len(lines) == 0 {
		return output
	}

	// The echoed line may contain the command (possibly with \r).
	firstLine := strings.TrimRight(lines[0], "\r")
	if strings.Contains(firstLine, command) || strings.TrimSpace(firstLine) == strings.TrimSpace(command) {
		if len(lines) > 1 {
			return lines[1]
		}
		return ""
	}

	return output
}

// discardAvailable reads and discards any immediately available data from the PTY.
func discardAvailable(ptmx *os.File) {
	buf := make([]byte, 4096)
	for {
		_ = ptmx.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
		n, err := ptmx.Read(buf)
		if n == 0 || err != nil {
			break
		}
	}
	// Reset deadline.
	_ = ptmx.SetReadDeadline(time.Time{})
}

// destroySession closes a PTY session and kills the underlying process.
func destroySession(sess *ptySession) {
	sess.mu.Lock()
	defer sess.mu.Unlock()

	if sess.ptmx != nil {
		_ = sess.ptmx.Close()
	}
	if sess.cmd != nil && sess.cmd.Process != nil {
		_ = sess.cmd.Process.Kill()
		_ = sess.cmd.Wait()
	}

	log.Printf("session destroyed: %s", sess.id)
}

// destroyAllSessions destroys all active PTY sessions. Called on shutdown.
func destroyAllSessions() {
	sessionsMu.Lock()
	toDestroy := make([]*ptySession, 0, len(sessions))
	for _, sess := range sessions {
		toDestroy = append(toDestroy, sess)
	}
	sessions = make(map[string]*ptySession)
	sessionsMu.Unlock()

	for _, sess := range toDestroy {
		destroySession(sess)
	}
}

// sessionReaper periodically checks for idle sessions and destroys them.
func sessionReaper() {
	ticker := time.NewTicker(sessionReapInterval)
	defer ticker.Stop()

	for range ticker.C {
		now := time.Now()

		sessionsMu.Lock()
		var toDestroy []*ptySession
		for id, sess := range sessions {
			sess.mu.Lock()
			idle := now.Sub(sess.lastActive)
			sess.mu.Unlock()

			if idle > sessionIdleTimeout {
				log.Printf("reaping idle session %s (idle %v)", id, idle)
				toDestroy = append(toDestroy, sess)
				delete(sessions, id)
			}
		}
		sessionsMu.Unlock()

		for _, sess := range toDestroy {
			destroySession(sess)
		}
	}
}

// isTimeout checks if an error is a timeout error.
func isTimeout(err error) bool {
	if err == nil {
		return false
	}
	type timeouter interface {
		Timeout() bool
	}
	if te, ok := err.(timeouter); ok {
		return te.Timeout()
	}
	return strings.Contains(err.Error(), "i/o timeout")
}

// min returns the smaller of two durations.
func min(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

// getSessionCount returns the number of active sessions.
func getSessionCount() int {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()
	return len(sessions)
}
