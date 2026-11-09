#!/bin/sh
# Container entrypoint. Hosts mount the persistent volume at $TRYBACK_DATA_DIR (/data) owned by
# root, so while still root we hand it to the unprivileged `node` user, then drop privileges for
# good: the Next.js server itself never runs as root. `exec` keeps node as PID 1, so SIGTERM
# reaches it and in-flight requests and after() renders get to finish.
set -eu

DATA_DIR="${TRYBACK_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Only fix what isn't node's already (fast on a large render cache).
  find "$DATA_DIR" ! -user node -exec chown node:node {} +
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
