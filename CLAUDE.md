# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- **Install dependencies**: `bun install`
- **Run the bot**: `bun run index.js` (must run under **Bun** — see the `bun:sqlite` note below; there is no `index.ts` despite the `module` field in `package.json`)
- **Deploy slash commands**: `bun deploy-commands.js` (registers guild commands with Discord; run after changing any command's `data`)
- **Run tests**: `bun test`
- **Run one test file**: `bun test tests/adversarial.test.js` — or by name: `bun test -t "ignores everyone and roles"`
- **Local usage dashboard** (dev only): `bun run dashboard` — reads the `stats_events` table; `dashboard/` is gitignored and not part of the deployed bot
- **Lint**: `eslint` is a devDependency but no flat config (`eslint.config.js`) is committed, so linting is effectively unconfigured — don't rely on it as a gate.

`config.json` (gitignored) holds all secrets and runtime config: `token`, `clientId`, `guildId`, `APIkey`, `API_BASE_URL`, `MODEL_NAME`, and optionally `SYSTEM_PROMPT`.

## Architecture

A Discord bot (discord.js v14) running on **Bun**, talking to an **OpenWebUI**/OpenAI-compatible LLM endpoint via `client.openWebUI`.

### State lives on the client, backed by SQLite
`index.js` attaches several stores to the `client` and injects `client.openWebUI` + `client.db`:
- `client.memory`: conversation history per `channelId` → `[{ role, content }]`. `content` is either a string or an array of `{type:'text'|'image_url', ...}` parts. Capped at the last 20 entries.
- `client.messageCounts`: non-bot message count per channel; every _N_ messages triggers an auto-response.
- `client.autoResponseRates`: per-channel override for _N_ (default 20).
- `client.allowedChannels`: opt-in allowlist (`channelId -> guildId`) for **ambient auto-responses**. Empty = bot auto-responds nowhere. Direct @mentions are **not** gated by this.

`client.memory`, `client.messageCounts`, `client.autoResponseRates`, and `client.allowedChannels` are **`PersistentMap`** instances (`utils/db.js`) — `Map` subclasses that write-through every `.set()`/`.delete()` to `data.sqlite` (Bun's built-in `bun:sqlite`) and reload on startup. **Consequence: mutating a stored value in place does not persist it — you must call `.set()` again.** `bun:sqlite` is why the bot must run under Bun, not Node. `data.sqlite*` is gitignored.

### Two MessageCreate listeners, deliberately coordinated
Both fire on every message; they divide ownership to avoid double-processing:
- `events/mention.js` owns messages that @mention the bot — it stores the (mention-stripped) user turn and streams a reply. Fires in **any** channel regardless of the allowlist. Mention detection uses `ignoreEveryone`/`ignoreRoles` so `@everyone`/`@here` do **not** trigger it.
- `events/messageStore.js` handles everything else: it **skips** mentioned messages (owned by mention.js), ignores non-allowlisted channels entirely, stores the message to memory, and triggers `events/autoresponce.js` when the per-channel counter hits the rate.

`events/autoResponseState.js` and `events/channelSettings.js` are **helper modules that live in `events/` but export no `name`/`execute`** — `index.js` skips them during event registration. They hold the rate/allowlist logic used by both the listeners and the `/channels`, `/setautoresponcerate` commands.

### The LLM/image pipeline (`utils/parseimgs.js`)
This module is the shared core for turning Discord messages into API payloads. Key behaviors that aren't obvious:
- **`safeLog` / `safeError`**: drop-in `console.log`/`error` replacements that deep-scrub `config.token` and `config.APIkey` out of all output (including Error stacks). **Always use these, never raw `console.*`**, since payloads and errors are logged verbosely.
- **`parseimgs`**: normalizes messages, extracts image URLs from text + attachments, and **merges consecutive same-role messages** into one turn. It also prepends the author's display name to user text (`"Name: ..."`) so the model can distinguish speakers — but only for real Discord messages (which carry `author`), and never on empty/image-only text.
- **`resolveImageUrlsToBase64` + `downloadImageAsBase64`**: right before the API call, image URLs are fetched and inlined as base64 data URIs. This path is **SSRF-guarded**: only `cdn.discordapp.com` / `media.discordapp.net` hosts are fetched (host allowlist), plus a DNS-resolution private/loopback/link-local IP block, a 10s timeout, and a 10 MB size cap. Disallowed URLs are passed through unresolved rather than fetched. Because this is expensive, handlers log the **pre-resolution** payload, not the base64-inlined one.
- **`createChatCompletionWithFallback`**: tries a streaming completion, and on 404/405/streaming errors retries once non-streaming. Returns `{isStream, stream}` or `{isStream:false, response}` — callers branch on `isStream`.
- **`SYSTEM_PROMPT`**: resolved once here as `config.SYSTEM_PROMPT || <default>` and re-exported. Import it from `utils/parseimgs.js`, not `config.json`, so the fallback applies. Used by both the mention and auto-response paths.

### Streaming reply convention
`mention.js`, `autoresponce.js`, and `commands/utilities/gene.js` all share the same streaming UX: a `setInterval` (every 1.5s) edits the reply message as tokens arrive (decoupled from the stream to dodge Discord rate limits), animated loading phrases until content exists, `<think>…</think>` and `[n]` citations stripped, and output truncated at 2000 chars. **The interval must be cleared in a `finally`** so a mid-stream error can't leak a runaway timer.

### Resilience (`index.js`)
Boot starts with fail-fast config validation (`utils/config.js` — `assertRequiredConfig`) so a missing `token`/`APIkey`/`API_BASE_URL`/`MODEL_NAME` exits with one clear message instead of a cryptic downstream error (`deploy-commands.js` does the same for its keys). Then: process-level `unhandledRejection` (log & continue) and `uncaughtException` (log, graceful shutdown, exit 1) guards; a graceful `shutdown()` on `SIGINT`/`SIGTERM` that destroys the gateway and WAL-checkpoints + closes SQLite; and `client.login(...).catch(...)` that shuts down and exits non-zero on a bad token.

### Usage stats (`utils/stats.js`)
`recordEvent(client, type, meta)` appends to the `stats_events` table (best-effort — failures are swallowed, never break the bot). Consumed only by the local `dashboard/`. Nothing in the bot reads it back. Rows older than `STATS_RETENTION_DAYS` (90) are pruned at startup and daily via `pruneStatsEvents(db)`.

## Command & Event Conventions
- **Commands** (`commands/<subdir>/*.js`): auto-discovered; each exports `data` (a `SlashCommandBuilder`) and an async `execute(interaction)`. A global 3s cooldown (overridable via `command.cooldown`) and unified error handling live in `events/interactionCreate.js`.
- **Events** (`events/*.js`): export `name` + async `execute`; `index.js` wires them to the gateway (helper modules without `name`/`execute` are skipped).
- Admin-only commands (e.g. `/channels`) gate with `setDefaultMemberPermissions(ManageGuild)` **and** re-check `interaction.memberPermissions` inside `execute` (the default can be overridden server-side).
