package main

import (
	"time"
)

// handleHeartbeat handles "heartbeat" requests: liveness check.
func handleHeartbeat() *Response {
	uptimeMs := time.Since(startTime).Milliseconds()
	sessionCount := getSessionCount()

	return &Response{
		Type:         "heartbeat_result",
		UptimeMs:     int64Ptr(uptimeMs),
		SessionCount: intPtr(sessionCount),
	}
}
