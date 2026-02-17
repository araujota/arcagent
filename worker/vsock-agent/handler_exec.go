package main

import (
	"bytes"
	"context"
	"log"
	"os/exec"
	"strings"
	"time"
)

const defaultExecTimeoutMs = 120_000

// handleExec handles "exec" requests: execute a shell command.
func handleExec(req *Request) *Response {
	if req.Command == "" {
		return errorResponse("missing command")
	}

	if isBlockedCommand(req.Command) {
		return errorResponse("command blocked by security policy")
	}

	user := req.User
	if user == "" {
		user = defaultUser
	}

	timeoutMs := req.TimeoutMs
	if timeoutMs <= 0 {
		timeoutMs = defaultExecTimeoutMs
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	cmd := buildCommand(req.Command, user)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := runCommandWithContext(ctx, cmd)

	exitCode := 0
	if err != nil {
		exitCode = exitCodeFromError(err)
	}

	stdoutStr := stdout.String()
	stderrStr := stderr.String()

	return &Response{
		Type:     "exec_result",
		Stdout:   strPtr(stdoutStr),
		Stderr:   strPtr(stderrStr),
		ExitCode: intPtr(exitCode),
	}
}

// handleExecWithStdin handles "exec_with_stdin" requests: execute with stdin piped.
func handleExecWithStdin(req *Request) *Response {
	if req.Command == "" {
		return errorResponse("missing command")
	}

	if isBlockedCommand(req.Command) {
		return errorResponse("command blocked by security policy")
	}

	user := req.User
	if user == "" {
		user = defaultUser
	}

	timeoutMs := req.TimeoutMs
	if timeoutMs <= 0 {
		timeoutMs = defaultExecTimeoutMs
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	cmd := buildCommand(req.Command, user)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.Stdin = strings.NewReader(req.Stdin)

	err := runCommandWithContext(ctx, cmd)

	exitCode := 0
	if err != nil {
		exitCode = exitCodeFromError(err)
	}

	stdoutStr := stdout.String()
	stderrStr := stderr.String()

	return &Response{
		Type:     "exec_result",
		Stdout:   strPtr(stdoutStr),
		Stderr:   strPtr(stderrStr),
		ExitCode: intPtr(exitCode),
	}
}

// runCommandWithContext starts a command and waits for it to complete or the
// context to expire. On timeout, it sends SIGKILL to the process.
func runCommandWithContext(ctx context.Context, cmd *exec.Cmd) error {
	if err := cmd.Start(); err != nil {
		return err
	}

	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		// Timeout: kill the process.
		if cmd.Process != nil {
			log.Printf("killing timed-out process pid=%d", cmd.Process.Pid)
			_ = cmd.Process.Kill()
		}
		// Wait to avoid zombie.
		<-done
		return ctx.Err()
	}
}

// exitCodeFromError extracts an exit code from an exec error.
func exitCodeFromError(err error) int {
	if err == nil {
		return 0
	}
	if err == context.DeadlineExceeded {
		return 124 // standard timeout exit code
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		return exitErr.ExitCode()
	}
	return 1
}
