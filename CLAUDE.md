# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- **Install dependencies**: `bun install`
- **Run the bot**: `bun run index.js` (must run under **Bun** — see the `bun:sqlite` note below; there is no `index.ts` despite the `module` field in `package.json`)
- **Deploy slash commands**: `bun deploy-commands.js` (registers guild commands with Discord; run after changing any command's `data`)
- **Run tests**: `bun test`
- **Run one test file**: `bun test tests/corpusLearning.test.js` — or by name: `bun test -t "ignores everyone and roles"`
- **Local usage dashboard** (dev only): `bun run dashboard` — reads the `stats_events` table; `dashboard/` is gitignored and not part of the deployed bot
- **Lint**: `eslint` is a devDependency but no flat config (`eslint.config.js`) is committed, so linting is effectively unconfigured — don't rely on it as a gate.

Configuration is resolved by `utils/config.js` from **environment variables first, then `config.json`** (gitignored). See `.env.example`. Required: `token`/`DISCORD_TOKEN`, `clientId`, `guildId`, `APIkey`/`LLM_API_KEY`. `API_BASE_URL` and `MODEL_NAME` are normally filled in by the provider preset.

## Architecture

A Discord bot (discord.js v14) running on **Bun**, talking to any **OpenAI-compatible** LLM endpoint (OpenRouter by default) via `client.llm`.

### The learning layer is the point of this bot

`utils/corpus.js` + `utils/prompt.js` are what make the bot sound like the server it lives in, and most changes will touch them. The design brief was GenAi, a Markov-chain bot: its voice comes from only ever emitting word sequences the server has used. This reproduces that voice through a language model instead, so **there is deliberately no separate Markov mode** — one path, always.

Every reply's system prompt is assembled fresh by **`buildReplyContext`** (in `utils/prompt.js`), which returns `{ systemPrompt, profile }` — callers need the profile too, for the output-side filter and sampling. `buildSystemPrompt` is a thin wrapper for callers that only want the string.

1. **`BASE_SYSTEM_PROMPT`** — persona. Static. Overridable via `SYSTEM_PROMPT`.
2. **Dialect profile** — the server's distinctive vocabulary, catchphrases, emoji and typing habits. Computed by counting everything in the corpus and **subtracting `utils/commonWords.js`**; whatever survives is server-specific. Cached in `corpus_profiles`, recomputed when stale (30 min) or after 40 new messages — the message threshold is what makes adaptation feel fast.
3. **Exemplars** (`styleExemplars`) — bare server messages near the typical length, one per author, shown with no author prefix. These teach *form*; precedent teaches *content*. Keep the two distinct.
4. **Precedent** — real server messages retrieved for the current topic via **SQLite FTS5** (`corpus_fts`, external-content table kept in sync by triggers). Falls back to recent messages when nothing matches.

`retrieveSimilar` (`utils/corpus.js`) does more than a bare FTS5 query, because plain BM25 has a real failure mode: an OR query across up to 8 terms lets a message sharing only the single rarest word outrank one that's actually about the whole question (BM25 rewards rarity, not coverage). It pulls a wider pool (`limit * poolMultiplier`), **re-ranks by distinct query-term overlap first, BM25 only as the tiebreaker**, then collapses near-identical reposts of the same catchphrase so limited precedent slots aren't spent twice on one line. A hit that's short or opens on a pronoun (`needsPrecedingContext`) carries the message it followed — the same "what is this reacting to" pattern `utils/media.js` uses for GIFs — so "he never opens correctly" doesn't get quoted floating with no antecedent. `renderPrecedent` (`utils/prompt.js`) tags each line with its age (`relativeAge`) so the model can resolve two lines that disagree, and flags when every retrieved hit traces back to one person (`distinctSources`) — one account, not the server's corroborated view.

Retrieval queries the last few conversation turns, not just the triggering message (`conversationText`, shared by `mention.js`/`autoresponce.js`/media-garnish selection) — a pronoun-only question like "what does he think" carries no retrievable signal on its own.

### The prompt asks; `utils/voice.js` enforces

A prompt is a request. A model obeys "type in lowercase, keep it short" for a sentence or two and then drifts back to its trained register — which is exactly the drift a Markov chain cannot have. `applyServerVoice` closes that gap deterministically on the way out, using the same measured profile:

- Strips assistant tics (openers like "Sure! Great question.", closers like "Let me know if…", AI disclaimers).
- Strips the bot signing its own name, and cuts role-play where the model starts writing other people's lines.
- **Applies measured habits only.** Lowercasing fires only at `lowercaseRatio >= 0.85`; full stops are stripped only at `punctuationRatio <= 0.25`. A formal server is left completely untouched — never hardcode a "casual" assumption here.
- `samplingParamsFor` derives `max_tokens` from the server's average message length, with warm temperature and presence/frequency penalties for variety.

Two traps in this file, both regression-tested:
- **Masking placeholders must not be digits or control characters.** Digits collide with numbers in the message ("i have 3 apples" loses the 3); control bytes corrupt the source file. The sentinel is lowercase ASCII so it survives `toLowerCase()`.
- **A speaker label is at most two words.** Matching any short run before a colon also eats real sentences ("we do the thing: win the round").

Call it on the *final* content only, not per animation frame, and store the voiced text in `client.memory` so the bot's own prior turns stay in voice.

Key invariants:
- **Thresholds scale with corpus size** (`thresholdsFor`). A small corpus accepts weaker evidence so a new in-joke lands within an evening; a large one demands corroboration from ≥2 users so one person's tic doesn't become "server slang".
- **Everything degrades to the base persona.** A missing db, an empty corpus, or a thrown query costs the dialect, never the reply — `buildSystemPrompt` catches and returns `base`.
- **User text reaching FTS5 must be escaped.** `buildMatchQuery` quotes every term; unquoted input makes FTS5 parse `OR`/`NEAR`/`*` as syntax and throw.
- **Never trust `result.changes` on `corpus_messages`.** Bun's `stmt.run().changes` is a delta of SQLite's `total_changes()`, not `sqlite3_changes()` — so it counts rows written by triggers. `corpus_messages` has FTS sync triggers whose shadow-table writes inflate it badly: deleting 1 message reports 7, deleting 5 reports 19. (`stats_events` has no triggers, so `utils/stats.js` using `.changes` is fine.) `pruneCorpus`/`forgetGuild` measure with `COUNT(*)` instead — those numbers are shown to users.

`utils/backfill.js` reads a channel's Discord history into the corpus when `/channels add` runs, so the bot has a dialect immediately rather than after weeks of listening.

### Reaction GIFs (`utils/media.js`)
Same thesis applied to media, with its own schema (`corpus_media` + `corpus_media_fts`, initialised from `utils/db.js`). **It never calls Tenor** — a generic GIF is not the server's in-joke.

- One row per `(guild_id, url)` with a `uses` counter, not one per post: a GIF posted twenty times is one reaction used a lot.
- **Context is mostly the *preceding* message.** A reaction GIF typically has no text of its own, so what it replies to is the only thing that makes it searchable. `events/messageStore.js` passes the previous memory entry in.
- `pickGarnishGif` gates in cheapest-first order: per-channel cooldown → dice (`GARNISH_CHANCE`) → FTS topical match → `uses >= MIN_USES_TO_REUSE`. **The cooldown is only consumed when a GIF is actually posted**, so a miss doesn't suppress the next real match — regression-tested.
- The URL is appended on its own line by `withGarnish` (`utils/streamingReply.js`), which truncates the *text* to make room rather than the URL — a half-URL renders as broken text. The GIF is deliberately **not** stored in `client.memory`, or the model starts inventing URLs by imitation.

Custom emoji are stored as the full `<:name:id>` form, never the bare `:name:` — Discord only renders the former, and the profile feeds the model directly.

### State lives on the client, backed by SQLite
`index.js` attaches several stores to the `client` and injects `client.llm` + `client.db` + `client.config`:
- `client.memory`: conversation history per `channelId` → `[{ role, content }]`. `content` is either a string or an array of `{type:'text'|'image_url', ...}` parts. Capped at the last 20 entries. This is *short-term context*, distinct from the corpus (permanent, and what learning is built from).
- `client.messageCounts`: non-bot message count per channel; every _N_ messages triggers an auto-response.
- `client.autoResponseRates`: per-channel override for _N_ (default 20).
- `client.allowedChannels`: opt-in allowlist (`channelId -> guildId`) for **ambient auto-responses and ambient learning**. Empty = the bot listens nowhere. Direct address is **not** gated by this.

These four are **`PersistentMap`** instances (`utils/db.js`) — `Map` subclasses that write-through every `.set()`/`.delete()` to `data.sqlite` (Bun's built-in `bun:sqlite`) and reload on startup. **Consequence: mutating a stored value in place does not persist it — you must call `.set()` again.** `bun:sqlite` is why the bot must run under Bun, not Node. `data.sqlite*` is gitignored.

### Two MessageCreate listeners, deliberately coordinated
Both fire on every message; they divide ownership via `utils/triggers.js` to avoid double-processing:
- `events/mention.js` owns **directly-addressed** messages — `isDirectlyAddressed()` is true for an @mention, a reply to the bot, *or* the bot's name used as a whole word (plus `BOT_ALIASES`). Fires in **any** channel regardless of the allowlist. `@everyone`/`@here` deliberately do not count.
- `events/messageStore.js` handles everything else: it **skips** directly-addressed messages, ignores non-allowlisted channels entirely, stores to memory *and* the corpus, and triggers `events/autoresponce.js` when the per-channel counter hits the rate.

Both listeners must agree on `isDirectlyAddressed`, or you get a double reply or silence.

`events/autoResponseState.js` and `events/channelSettings.js` are **helper modules that live in `events/` but export no `name`/`execute`** — `index.js` skips them during event registration, and `tests/repoStructure.test.js` has a hardcoded allowlist of them. **Prefer putting new shared logic in `utils/`** rather than adding to that list.

### Module layout & the require cycle to avoid
`utils/log.js` (secret-scrubbing `safeLog`/`safeError`/`debugLog`) is the base of the dependency graph — it depends only on `utils/config.js`. `utils/llm.js` and `utils/corpus.js` import from it directly.

**`utils/parseimgs.js` re-exports `safeLog`, `safeError` and `createChatCompletionWithFallback` for back-compat, so anything imported by `parseimgs.js` must never import `parseimgs.js` back.** Importing `./parseimgs` from `llm.js` yields `undefined` helpers at runtime — a cycle that type-checks fine and fails only when the code path executes.

### The LLM/image pipeline (`utils/parseimgs.js`)
- **`safeLog` / `safeError`**: deep-scrub `token` and `APIkey` (resolved from env *or* config) out of all output including Error stacks. **Always use these, never raw `console.*`.** Use **`debugLog`** for verbose payload/memory dumps — gated behind `DEBUG_PAYLOADS=1`, off by default so a shared VM's journal isn't a copy of everyone's chat.
- **`parseimgs`**: normalizes messages, extracts image URLs from text + attachments, and **merges consecutive same-role messages** into one turn. Prepends the author's display name to user text (`"Name: ..."`) so the model can distinguish speakers — but only for real Discord messages (which carry `author`), and never on empty/image-only text.
- **`resolveImageUrlsToBase64` + `downloadImageAsBase64`**: right before the API call, image URLs are fetched and inlined as base64 data URIs. **SSRF-guarded**: only `cdn.discordapp.com` / `media.discordapp.net` (host allowlist), plus a DNS-resolution private/loopback/link-local IP block, a 10s timeout, and a 10 MB size cap. Disallowed URLs pass through unresolved.

### Privacy is enforced per-request, not just documented (`utils/llm.js`)
Every request sent to OpenRouter carries `provider: { data_collection: 'deny', zdr: true }`, applied once inside `requestChatCompletion` (both the streaming attempt and the non-streaming fallback) rather than at each of the three call sites — passing `{ config }` through is the only thing a caller has to remember. `privacyProviderOptions(config)` builds it, returns `undefined` for any non-OpenRouter provider (they don't understand the field), and never overwrites a caller-supplied `payload.provider`. Both flags default **true** (`utils/config.js` — `PRIVACY_BOOLEAN_KEYS`, `parseBooleanFlag`): opt-out via `LLM_DENY_TRAINING=0` / `LLM_ZDR=0`, not opt-in. This narrows which backing hosts OpenRouter can route to (a real host, e.g. DeepSeek's weights served by a third party) and can in principle leave zero eligible hosts for a given model — that surfaces as a normal request error, not silent failure. This is belt-and-suspenders with, not a replacement for, the account-level privacy toggle on openrouter.ai.

### LLM access (`utils/llm.js`)
- **`pickModel(config, messages)`**: the bot configures **two** models. `MODEL_NAME` is text-only and chosen for speed/price; `VISION_MODEL` is swapped in per request, and only when `messagesContainImages` finds an actual `image_url` part. Don't collapse these — a text-only everyday model is the point, and paying multimodal rates on every one-liner is what it avoids. Providers that are natively multimodal set both preset fields to the same ID.
- **`createLlmClient(config)`**: builds the `OpenAI` client. Adds OpenRouter's `HTTP-Referer`/`X-Title` attribution headers only for that provider. SDK retries are disabled in favour of the wrapper's own.
- **`requestChatCompletion`**: retries 429/5xx/network errors with `Retry-After`-aware backoff, and falls back to non-streaming on 404/405/streaming errors. Returns `{isStream, stream}` or `{isStream:false, response}` — callers branch on `isStream`. `createChatCompletionWithFallback` is the old name, kept as a shim.
- **`describeLlmError`**: turns a provider error into one user-facing sentence. Reply paths show this instead of raw `error.message` (which is often a wall of JSON). The OpenRouter 429 case names the free-tier daily cap, because that is what it almost always is.

### Streaming reply convention
`mention.js`, `autoresponce.js`, and `commands/utilities/gene.js` share the same streaming UX: a `setInterval` (every 1.5s) edits the reply message as tokens arrive (decoupled from the stream to dodge Discord rate limits), animated loading phrases until content exists, `<think>…</think>` and `[n]` citations stripped, and output truncated at 2000 chars. **The interval must be cleared in a `finally`** so a mid-stream error can't leak a runaway timer.

### Resilience (`index.js`)
Boot starts with fail-fast config validation (`utils/config.js` — `assertRequiredConfig`) so a missing key exits with one clear message naming it. Then: process-level `unhandledRejection` (log & continue) and `uncaughtException` (log, graceful shutdown, exit 1) guards; a graceful `shutdown()` on `SIGINT`/`SIGTERM` that destroys the gateway and WAL-checkpoints + closes SQLite; and `client.login(...).catch(...)` that shuts down and exits non-zero on a bad token.

### Usage stats (`utils/stats.js`)
`recordEvent(client, type, meta)` appends to the `stats_events` table (best-effort — failures are swallowed, never break the bot). Consumed only by the local `dashboard/`. Rows older than `STATS_RETENTION_DAYS` (90) are pruned at startup and daily.

## Deployment
`Dockerfile` (multi-arch, builds on aarch64) + `docker-compose.yml` + `deploy/limmygrok.service`. The guide is `docs/DEPLOY-ORACLE.md` (Oracle Cloud Always Free). The SQLite database must live on a mounted volume (`DATA_DIR`) or every redeploy wipes the bot's memory *and everything it has learned*.

Note `.gitignore` ignores `*.md` with explicit negations for `README.md`, `CLAUDE.md` and `docs/*.md` — a new doc elsewhere will be silently ignored.

## Command & Event Conventions
- **Commands** (`commands/<subdir>/*.js`): auto-discovered; each exports `data` (a `SlashCommandBuilder`) and an async `execute(interaction)`. A global 3s cooldown (overridable via `command.cooldown`) and unified error handling live in `events/interactionCreate.js`. A command that does slow work must `deferReply()` — Discord's interaction window is 3s (see `/channels add`, which backfills).
- **Events** (`events/*.js`): export `name` + async `execute`; `index.js` wires them to the gateway (helper modules without `name`/`execute` are skipped).
- Admin-only commands (e.g. `/channels`, `/dialect forget`) gate with `setDefaultMemberPermissions(ManageGuild)` **and** re-check `interaction.memberPermissions` inside `execute` (the default can be overridden server-side).
