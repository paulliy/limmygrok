# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- **Install Dependencies**: `bun install`
- **Run Bot**: `bun run index.ts`
- **Deploy Slash Commands**: `node deploy-commands.js` (or `bun deploy-commands.js`)
- **Lint**: `eslint .` (Check `package.json` for specific configs)

## Architecture & Structure

This is a Discord bot built using **Node.js**, **discord.js**, and **Bun**, integrated with an **OpenWebUI** LLM provider.

### Core Components
- **Client Extensions**:
    - `client.commands`: Collection of all registered commands.
    - `client.memory`: Stores conversation history (last 20 messages) per `channelId`. Structure: `channelId -> [{ role: 'user' | 'assistant', content: string }]`.
    - `client.messageCounts`: Tracks non-bot message counts per `channelId`. Triggers an auto-response generation every 20 messages.
    - `client.autoResponseRates`: Per-channel overrides for the auto-response cadence.
    - `client.allowedChannels`: Opt-in allowlist (`channelId -> guildId`) of channels where **ambient auto-responses** are active. Empty = the bot auto-responds nowhere. Managed via `events/channelSettings.js` and the `/channels` command. Direct @mentions are **not** gated by this.
    - `client.cooldowns`: Handles rate limiting for commands.
    - `client.openWebUI`: An instance of the `OpenAI` class used for interacting with the LLM.
- **Persistence** (`utils/db.js`): `client.memory`, `client.messageCounts`, `client.autoResponseRates`, and `client.allowedChannels` are `PersistentMap` instances — Map subclasses that write-through every `set`/`delete` to a SQLite database (`data.sqlite`, via Bun's built-in `bun:sqlite`) and reload it on startup, so state survives restarts. Handlers use the plain Map interface; **mutating a stored value in place without calling `.set()` will not persist it.** `data.sqlite*` is gitignored. Note: `bun:sqlite` means `index.js` must run under Bun, not Node.
- **Resilience** (`index.js`): process-level `unhandledRejection` (log & continue) and `uncaughtException` (log, graceful shutdown, exit 1) guards, plus a graceful `shutdown()` on `SIGINT`/`SIGTERM` that destroys the gateway and WAL-checkpoints + closes SQLite.

### Command & Event Patterns
- **Commands**: Located in the `commands/` directory.
    - Auto-discovered via subdirectories.
    - Each file must export:
        - `data`: A `SlashCommandBuilder` instance.
        - `execute`: An `async` function receiving the `interaction` object.
    - **Cooldowns**: A global cooldown (default 3s) is handled in `events/interactionCreate.js`, unless overridden in command data.
- **Events**: Located in the `events/` directory.
    - Modularized files exporting a `name` and `execute` function.
    - `interactionCreate.js` acts as the primary dispatcher for slash commands, handling unified error handling and response deferral.

### LLM & Features
- **Channel visibility**: Ambient auto-responses are opt-in per channel (`client.allowedChannels`). `events/messageStore.js` ignores messages in non-allowlisted channels; admins enable channels with `/channels add`. `events/guildCreate.js` posts onboarding instructions when the bot joins a server. Direct @mentions (`events/mention.js`) always reply, regardless of the allowlist.
- **Auto-Responses**: Triggered automatically by `events/autoresponce.js` every 20 messages (only in allowlisted channels).
- **Streaming Responses**: 
    - Implemented with a 1.5-second interval for `editReply` calls to prevent Discord rate limits.
    - Filters out `<think>` tags (DeepSeek-R1 style) and other specific regex patterns.
    - Truncates responses at 2000 characters.
- **OpenWebUI Integration**: Standardized via the `client.openWebUI` property.

## Key Files
- `config.json`: Contains sensitive keys and `API_BASE_URL`.
- `deploy-commands.js`: Script to register slash commands.
- `index.js`: Main entry point for client initialization and dependency injection.
- `events/autoresponce.js`: Logic for automated responses.
- `commands/utilities/gene.js`: Example of a sophisticated streaming LLM command.
