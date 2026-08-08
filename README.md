# limmygrok

A Discord bot that learns how your server talks, and talks back the same way.

It reads the channels you point it at, works out the server's own vocabulary,
catchphrases, emoji and typing habits, and puts all of that in front of a
language model on every reply — along with the messages your server has
actually written about whatever is being discussed. The result is a bot with
your server's voice and your server's knowledge, that can still hold a thought.

---

## Why it works this way

The inspiration was [GenAi](https://top.gg/bot/974297735559806986), which is a
**Markov chain** over a server's messages. That is the whole reason it feels
the way it does: it can only emit word sequences the server has actually used,
so it is instant, it picks up new slang the day it is coined, and it is funny in
a way no general-purpose assistant is. The price is that it cannot be coherent,
answer a question, or stay on topic.

limmygrok keeps the source of that voice and drops the price. There is one
system, not two — no separate "Markov mode". The corpus feeds the model:

| | Markov chain | limmygrok |
| --- | --- | --- |
| Where the voice comes from | the server's messages | the server's messages |
| Picks up new slang | immediately | within ~40 messages |
| Can answer a question | no | yes |
| Stays on topic | no | yes |

Concretely, every reply is built from three layers:

1. **Base persona** — a member of the server, not an assistant.
2. **Dialect profile** — the server's distinctive words, recurring phrases,
   emoji and habits, found by counting everything the server says and
   subtracting ordinary English (`utils/commonWords.js`). This is a Markov
   chain's transition table, compressed into something a model can read.
3. **Precedent** — the real messages this server wrote about the current
   topic, pulled by SQLite full-text search. This is where server *knowledge*
   comes from: who is who, what the in-jokes mean, what happened last week.

With an empty corpus only layer 1 is sent, and the bot behaves like an ordinary
chat model. Nothing breaks; it just has nothing to imitate yet.

## Quick start

```bash
bun install
cp .env.example .env    # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID, LLM_API_KEY
bun deploy-commands.js  # register slash commands
bun index.js
```

Then, in Discord:

```
/channels add     # in each channel it should listen to — also backfills history
/dialect show     # see what it has learned
```

`/channels add` reads back through the channel's existing history, so the bot
sounds like your server straight away instead of weeks later.

Requires **Bun** (not Node — `utils/db.js` uses `bun:sqlite`), and the
**Message Content Intent** enabled in the Discord Developer Portal.

## Deploying

For 24/7 hosting that isn't a machine in your house, see
**[docs/DEPLOY-ORACLE.md](docs/DEPLOY-ORACLE.md)** — a step-by-step guide to
Oracle Cloud's Always Free tier, which is genuinely free and doesn't sleep idle
services the way most free tiers do.

```bash
docker compose up -d
```

A systemd unit for running under Bun without Docker is in
`deploy/limmygrok.service`.

## Configuration

Environment variables first, then `config.json` — see `.env.example` for the
full list. Only four values are strictly required: `DISCORD_TOKEN`,
`DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `LLM_API_KEY`.

**The model provider is config, not code.** The bot speaks OpenAI
chat-completions, so switching providers is a base URL and a model name:

| `LLM_PROVIDER` | Notes |
| --- | --- |
| `openrouter` *(default)* | One key, many models. Free models are capped at 20 req/min and 50 req/day until you buy $10 of credit once. |
| `groq` | Fastest tokens/sec; generous free tier. |
| `gemini` | Large free tier, strong vision. |
| `cerebras` | High daily token allowance. |
| `openai` | Paid. |

Anything else OpenAI-compatible works too — set `LLM_BASE_URL` and `LLM_MODEL`
directly.

## Commands

| Command | What it does |
| --- | --- |
| `/channels add\|remove\|list\|clear` | Which channels the bot listens and auto-responds in. `add` backfills history. *(Manage Server)* |
| `/dialect show` | The slang, catchphrases, emoji and habits it has learned here. |
| `/dialect refresh` | Recompute the profile now instead of waiting. |
| `/dialect forget` | Delete everything learned from this server. *(Manage Server)* |
| `/setautoresponcerate` | How often it chimes in unprompted (default: every 20 messages). |
| `/autoresponseinfo` | How many messages until the next one. |
| `/generatestring` | One-off generation. Legacy — just talk to it instead. |

The bot replies whenever it is **@mentioned**, **replied to**, or **called by
name** — in any channel, allowlist or not. Ambient auto-responses are opt-in per
channel via `/channels add`.

## Privacy

The bot only stores messages from channels an admin has explicitly added with
`/channels add`, plus messages addressed to it directly. Everything lives in a
local SQLite file — nothing is sent anywhere except the model provider, and
`/dialect forget` deletes a server's data outright. Secrets are scrubbed from
every log line (`utils/log.js`), and full payload logging is off unless you set
`DEBUG_PAYLOADS=1`.

## Development

```bash
bun test                          # 148 tests
bun test tests/corpusLearning.test.js
bun run dashboard                 # local usage dashboard (dev only)
```

Architecture notes for contributors — and for Claude Code — are in
[CLAUDE.md](CLAUDE.md).
