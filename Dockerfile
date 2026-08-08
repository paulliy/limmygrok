# Must be a Bun image: the bot uses bun:sqlite (utils/db.js), which only
# exists inside the Bun runtime — a node:* base crashes at require time.
# Pinned to the version the repo was built with (see README.md).
#
# This tag is multi-arch, so the same Dockerfile builds on an x86 laptop and
# on the aarch64 Ampere instance the Oracle free tier gives you
# (docs/DEPLOY-ORACLE.md) with no changes.
FROM oven/bun:1.3.14-slim

WORKDIR /app

# Install production deps first so this layer is cached until the lockfile
# changes. bufferutil ships prebuilt Linux binaries (node-gyp-build), so no
# compiler toolchain is needed. Dev deps (eslint, @types/bun) are skipped.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# .dockerignore keeps config.json, data.sqlite*, dashboard/, tests/, and
# markdown out of the build context, so this copies only the bot source.
COPY . .

# Persistent SQLite state (conversation memory, allowlists, rates, stats).
# index.js reads DATA_DIR to place data.sqlite here; without a volume every
# redeploy would wipe the bot's memory. Owned by the non-root bun user the
# base image ships with.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data

USER bun

# Secrets are NOT baked into the image. Supply them as environment variables
# (the usual path — see .env.example and docker-compose.yml):
#   docker run -d --env-file .env -v limmygrok-data:/data limmygrok
#
# A config.json still works if you prefer a file; bind-mount it read-only:
#   docker run -d -v /path/to/config.json:/app/config.json:ro \
#     -v limmygrok-data:/data limmygrok
#
# The entrypoint deploys slash commands on startup (disable with
# -e DEPLOY_COMMANDS_ON_START=0), then execs the bot so it runs as PID 1
# and receives SIGTERM/SIGINT directly (index.js handles both: gateway
# destroy + SQLite WAL checkpoint — no init/tini needed). Passing a
# command overrides the default startup:
#   docker run --rm --env-file .env limmygrok bun deploy-commands.js
ENTRYPOINT ["/bin/sh", "/app/docker-entrypoint.sh"]
