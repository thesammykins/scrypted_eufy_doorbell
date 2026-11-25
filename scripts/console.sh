#!/bin/sh
# Print the buffered console of the plugin (or a device id/name) on the Scrypted server.
# usage: SCRYPTED_HOST=<server> scripts/console.sh [device-id-or-name] [host]
TARGET="${1:-@thesammykins/scrypted-eufy-doorbell}"
HOST="${2:-${SCRYPTED_HOST:?set SCRYPTED_HOST or pass a host}}"
NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_NO_WARNINGS=1 npx -y scrypted@latest console -t 5 "$TARGET@$HOST"
