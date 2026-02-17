.PHONY: build clean

build:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o ../rootfs/vsock-agent ./

clean:
	rm -f ../rootfs/vsock-agent
