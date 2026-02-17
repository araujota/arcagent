package main

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

const workspaceRoot = "/workspace"

// validatePath checks that the given path resolves to somewhere within
// /workspace/ after following symlinks. Returns the cleaned absolute path
// or an error.
func validatePath(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("empty path")
	}

	// Clean and make absolute (relative paths are resolved from /workspace).
	cleaned := path
	if !filepath.IsAbs(cleaned) {
		cleaned = filepath.Join(workspaceRoot, cleaned)
	}
	cleaned = filepath.Clean(cleaned)

	// Resolve symlinks to get the real path.
	resolved, err := filepath.EvalSymlinks(cleaned)
	if err != nil {
		// If the file doesn't exist yet (e.g., for writes), evaluate the parent.
		dir := filepath.Dir(cleaned)
		resolvedDir, dirErr := filepath.EvalSymlinks(dir)
		if dirErr != nil {
			return "", fmt.Errorf("path validation failed: %w", dirErr)
		}
		resolved = filepath.Join(resolvedDir, filepath.Base(cleaned))
	}

	// Ensure the resolved path is within /workspace/.
	if !strings.HasPrefix(resolved, workspaceRoot+"/") && resolved != workspaceRoot {
		return "", fmt.Errorf("path %q resolves outside workspace to %q", path, resolved)
	}

	return resolved, nil
}

// ---------------------------------------------------------------------------
// Command blocking
// ---------------------------------------------------------------------------

// blockedCommands is the set of exact commands or patterns that are never allowed.
var blockedCommands = []string{
	"poweroff",
	"shutdown",
	"reboot",
	"halt",
	"init",
}

// blockedPatterns are regex patterns for dangerous commands.
var blockedPatterns = []*regexp.Regexp{
	regexp.MustCompile(`\brm\s+-rf\s+/\s*$`),
	regexp.MustCompile(`\brm\s+-rf\s+/\b`),
	regexp.MustCompile(`\bdd\s+if=.*\s+of=/dev/`),
}

// isBlockedCommand returns true if the command matches any blocked command or pattern.
func isBlockedCommand(command string) bool {
	trimmed := strings.TrimSpace(command)

	// Check exact match against blocked commands.
	for _, blocked := range blockedCommands {
		if trimmed == blocked {
			return true
		}
		// Also check if the command starts with the blocked command followed by a space or flags.
		if strings.HasPrefix(trimmed, blocked+" ") || strings.HasPrefix(trimmed, blocked+"\t") {
			return true
		}
	}

	// Check regex patterns.
	for _, pat := range blockedPatterns {
		if pat.MatchString(trimmed) {
			return true
		}
	}

	return false
}

// ---------------------------------------------------------------------------
// User switching
// ---------------------------------------------------------------------------

const defaultUser = "agent"
const defaultUID = 1000
const defaultGID = 1000

// commandCredentials returns the *syscall.SysProcAttr for running a command
// as the specified user. Only "root" bypasses the default agent user.
func commandCredentials(user string) *syscall.SysProcAttr {
	if user == "root" {
		return &syscall.SysProcAttr{
			Credential: &syscall.Credential{
				Uid: 0,
				Gid: 0,
			},
		}
	}
	// Default: run as agent (uid 1000, gid 1000).
	return &syscall.SysProcAttr{
		Credential: &syscall.Credential{
			Uid: uint32(defaultUID),
			Gid: uint32(defaultGID),
		},
	}
}

// buildCommand creates an *exec.Cmd that runs a shell command as the specified user.
func buildCommand(command, user string) *exec.Cmd {
	cmd := exec.Command("/bin/sh", "-c", command)
	cmd.SysProcAttr = commandCredentials(user)
	cmd.Dir = workspaceRoot

	// Set basic environment.
	effectiveUser := user
	if effectiveUser == "" {
		effectiveUser = defaultUser
	}
	homeDir := "/home/" + effectiveUser
	if effectiveUser == "root" {
		homeDir = "/root"
	}

	cmd.Env = []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=" + homeDir,
		"USER=" + effectiveUser,
		"LANG=en_US.UTF-8",
		"TERM=xterm-256color",
	}

	return cmd
}

// ---------------------------------------------------------------------------
// ANSI stripping
// ---------------------------------------------------------------------------

// ansiRegexp matches ANSI escape sequences (CSI, OSC, etc.).
var ansiRegexp = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b\(B|\x1b\[[0-9;]*m`)

// stripANSI removes ANSI escape sequences from the given string.
func stripANSI(s string) string {
	return ansiRegexp.ReplaceAllString(s, "")
}
