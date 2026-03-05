package main

import (
	"os"
	"path/filepath"
	"sort"

	"github.com/bmatcuk/doublestar/v4"
)

const defaultGlobMaxResults = 500

type globFileEntry struct {
	path    string
	modTime int64
}

func matchToGlobEntry(match string) (globFileEntry, bool) {
	absPath := "/" + match

	// Verify the matched file is within workspace after symlink resolution.
	resolved, err := filepath.EvalSymlinks(absPath)
	if err != nil {
		return globFileEntry{}, false
	}
	if resolved != workspaceRoot && !hasPrefix(resolved, workspaceRoot+"/") {
		return globFileEntry{}, false
	}

	info, err := os.Stat(absPath)
	if err != nil || info.IsDir() {
		return globFileEntry{}, false
	}

	return globFileEntry{
		path:    absPath,
		modTime: info.ModTime().UnixNano(),
	}, true
}

// handleFileGlob handles "file_glob" requests: glob pattern file search.
func handleFileGlob(req *Request) *Response {
	if req.Pattern == "" {
		return errorResponse("missing pattern")
	}

	basePath := req.Path
	if basePath == "" {
		basePath = workspaceRoot
	}

	// Validate the base path is within /workspace/.
	safePath, err := validatePath(basePath)
	if err != nil {
		return &Response{
			Type:  "file_result",
			Error: err.Error(),
		}
	}

	maxResults := req.MaxResults
	if maxResults <= 0 {
		maxResults = defaultGlobMaxResults
	}

	// Build the full glob pattern.
	fullPattern := filepath.Join(safePath, req.Pattern)

	// Use doublestar for recursive glob support (**).
	fsys := os.DirFS("/")
	// doublestar.Glob needs a relative pattern from the filesystem root.
	relPattern := fullPattern[1:] // strip leading "/"

	matches, err := doublestar.Glob(fsys, relPattern)
	if err != nil {
		return &Response{
			Type:  "file_result",
			Error: "glob error: " + err.Error(),
		}
	}

	// Convert back to absolute paths and filter to regular files within workspace.
	var entries []globFileEntry
	for _, match := range matches {
		entry, ok := matchToGlobEntry(match)
		if !ok {
			continue
		}
		entries = append(entries, entry)
	}

	// Sort by modification time descending (most recently modified first).
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].modTime > entries[j].modTime
	})

	totalMatches := len(entries)
	truncated := totalMatches > maxResults
	if truncated {
		entries = entries[:maxResults]
	}

	files := make([]string, len(entries))
	for i, e := range entries {
		files[i] = e.path
	}

	return &Response{
		Type:         "file_result",
		Files:        files,
		TotalMatches: intPtr(totalMatches),
		Truncated:    boolPtr(truncated),
	}
}

// hasPrefix is a simple string prefix check.
func hasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}
