#!/usr/bin/env bash
# Placeholder guest agent — replace with compiled binary
# This shell version handles basic exec requests over vsock
echo "guest-agent: starting on vsock port 5000" >&2

# The real guest agent should be a compiled Go/Rust binary that:
# - Listens on vsock CID=3 port 5000
# - Accepts 4-byte BE length-prefixed JSON frames
# - Handles: exec (run shell commands), write_file (write content to path)
# - Returns 4-byte BE length-prefixed JSON responses
# - Supports running commands as different users (su -c)
echo "guest-agent: placeholder — replace with compiled binary" >&2
sleep infinity
