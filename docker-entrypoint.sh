#!/bin/sh
set -e

# Explicit args override the default startup entirely,
# e.g. `docker run ... limmygrok bun deploy-commands.js`
if [ "$#" -gt 0 ]; then
    exec "$@"
fi

# Register slash commands with Discord before starting the bot, so a new
# deploy picks up command changes without a separate manual step. Guild
# command deploys are idempotent and fast. A missing/invalid config exits
# non-zero here (fail fast); a transient Discord API error is logged by
# deploy-commands.js without killing startup. Opt out with
# DEPLOY_COMMANDS_ON_START=0.
if [ "${DEPLOY_COMMANDS_ON_START:-1}" != "0" ]; then
    echo "[entrypoint] deploying slash commands..."
    bun deploy-commands.js
fi

# exec replaces this shell so bun runs as PID 1 and receives SIGTERM/SIGINT
# directly (index.js handles them: gateway destroy + SQLite checkpoint).
exec bun index.js
