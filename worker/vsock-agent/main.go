package main

import (
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mdlayher/vsock"
)

// startTime is set at startup for heartbeat uptime reporting.
var startTime time.Time

func main() {
	startTime = time.Now()

	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)
	log.Println("vsock-agent starting")

	// Start the session idle reaper.
	go sessionReaper()

	// Listen on vsock port 5000, CID = any (VMADDR_CID_ANY).
	listener, err := vsock.Listen(5000, nil)
	if err != nil {
		log.Fatalf("failed to listen on vsock port 5000: %v", err)
	}
	defer listener.Close()

	log.Println("vsock-agent listening on port 5000")

	// Handle graceful shutdown.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		sig := <-sigCh
		log.Printf("received signal %v, shutting down", sig)
		listener.Close()
		destroyAllSessions()
		os.Exit(0)
	}()

	// Accept loop.
	for {
		conn, err := listener.Accept()
		if err != nil {
			// Listener was closed (shutdown).
			log.Printf("accept error (shutting down?): %v", err)
			return
		}
		go handleConnection(conn)
	}
}

// handleConnection processes a single vsock connection.
func handleConnection(conn net.Conn) {
	defer conn.Close()

	req, err := readRequest(conn)
	if err != nil {
		log.Printf("error reading request: %v", err)
		_ = writeResponse(conn, errorResponse("failed to read request: "+err.Error()))
		return
	}

	var resp *Response

	switch req.Type {
	case "exec":
		resp = handleExec(req)
	case "exec_with_stdin":
		resp = handleExecWithStdin(req)
	case "file_write":
		resp = handleFileWrite(req)
	case "file_read":
		resp = handleFileRead(req)
	case "file_edit":
		resp = handleFileEdit(req)
	case "file_glob":
		resp = handleFileGlob(req)
	case "file_grep":
		resp = handleFileGrep(req)
	case "session_create":
		resp = handleSessionCreate(req)
	case "session_exec":
		resp = handleSessionExec(req)
	case "session_resize":
		resp = handleSessionResize(req)
	case "session_destroy":
		resp = handleSessionDestroy(req)
	case "heartbeat":
		resp = handleHeartbeat()
	default:
		resp = errorResponse("unknown request type: " + req.Type)
	}

	if err := writeResponse(conn, resp); err != nil {
		log.Printf("error writing response for %s: %v", req.Type, err)
	}
}
