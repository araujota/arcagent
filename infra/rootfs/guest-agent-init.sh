#!/bin/sh
### BEGIN INIT INFO
# Provides:          guest-agent
# Required-Start:    $local_fs
# Default-Start:     2 3 4 5
# Short-Description: ArcAgent guest vsock agent
### END INIT INFO
case "$1" in
  start)
    /usr/local/bin/vsock-agent &
    ;;
  stop)
    killall vsock-agent 2>/dev/null
    ;;
esac
