#!/bin/sh
# Print the buffered console of the plugin (or a device id/name) on the Scrypted server.
# usage: scripts/console.sh [device-id-or-name] [host]
TARGET="${1:-@thesammykins/scrypted-eufy-doorbell}"
HOST="${2:-192.168.88.220}"
NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_NO_WARNINGS=1 npx -y scrypted@latest console -t 5 "$TARGET@$HOST"
