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

Concretely, every reply is built from four layers:

1. **Base persona** — a member of the server, not an assistant.
2. **Dialect profile** — the server's distinctive words, recurring phrases,
   emoji and habits, found by counting everything the server says and
   subtracting ordinary English (`utils/commonWords.js`). This is a Markov
   chain's transition table, compressed into something a model can read.
3. **Exemplars** — real server messages of typical length, shown as shapes to
   copy.
4. **Precedent** — the real messages this server wrote about the current
   topic, pulled by SQLite full-text search. This is where server *knowledge*
   comes from: who is who, what the in-jokes mean, what happened last week.

With an empty corpus only layer 1 is sent, and the bot behaves like an ordinary
chat model. Nothing breaks; it just has nothing to imitate yet.

Retrieval is more than a bare keyword search: it re-ranks results by how many
distinct words of the question a message actually matches (not just relevance
to a single rare word), collapses near-identical reposts, tags each result
with its age so the model can tell which of two disagreeing lines is current,
and carries the message a short or pronoun-led reply ("he never opens
correctly") was following — otherwise a quoted fragment can misattribute who
it was actually about.

### Asking isn't enough

A prompt is a request. A model will follow "type in lowercase, keep it short"
for a sentence or two and then drift back to sounding like a model — the drift a
Markov chain can't have. So the same measured profile is applied again on the
way *out* (`utils/voice.js`):

```
model says : "Sure! Great question. Bawberry is definitely one of the weaker
              players — he consistently whiffs the opening duel. Let me know
              if you want more detail!"
server gets: "bawberry is definitely one of the weaker players — he
              consistently whiffs the opening duel"
```

It strips service-desk openers and closers, AI disclaimers, the bot signing its
own name, and role-play where the model starts writing other people's lines.
Casing and punctuation are only changed when the server's own habits are
measurably strong — **a server that writes in full sentences is left completely
alone.** Reply length is budgeted from the server's average message length
rather than a fixed number.

### Reaction GIFs

The same idea applied to media: the bot records every GIF and image link posted
in its channels, along with **the message it was reacting to** — a GIF-only post
has no text of its own, so what it replies to is the only thing that gives it
meaning. When a reply lands on a matching topic it occasionally posts the GIF
your server already uses for exactly that.

It never searches Tenor. A generic "confused" GIF is not your in-joke; the clip
your server posts every single time someone whiffs is. Only links posted twice
or more are reused, there is a per-channel cooldown, and it fires on a minority
of replies — a reaction GIF is funny because it is occasional.

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

**Two models, routed per request.** The everyday model is text-only, so the bot
automatically swaps to a vision model for the requests that actually carry an
image:

| | Model | Cost |
| --- | --- | --- |
| Everyday chat | `deepseek/deepseek-v4-flash-0731` | $0.09/M in, $0.18/M out |
| Messages with images | `qwen/qwen3.7-flash` | $0.03/M in, $0.13/M out |

Both have 1M context. Override either with `LLM_MODEL` / `LLM_VISION_MODEL`.
Providers whose main model is already multimodal (Gemini, OpenAI) set both to
the same ID, making the routing a no-op.

## Commands

| Command | What it does |
| --- | --- |
| `/channels add\|remove\|list\|clear` | Which channels the bot listens and auto-responds in. `add` backfills history. *(Manage Server)* |
| `/dialect show` | The slang, catchphrases, emoji and habits it has learned here. |
| `/dialect refresh` | Recompute the profile now instead of waiting. |
| `/dialect forget` | Delete everything learned from this server, GIFs included. *(Manage Server)* |
| `/setautoresponcerate` | How often it chimes in unprompted (default: every 20 messages). |
| `/autoresponseinfo` | How many messages until the next one. |
| `/generatestring` | One-off generation. Legacy — just talk to it instead. |

The bot replies whenever it is **@mentioned**, **replied to**, or **called by
name** — in any channel, allowlist or not. Ambient auto-responses are opt-in per
channel via `/channels add`.

## Privacy

**What stays local.** The bot only stores messages from channels an admin has
explicitly added with `/channels add`, plus messages addressed to it directly.
Everything lives in a local SQLite file on whatever machine or VM you run the
bot on — nothing is sent anywhere except the model provider on each reply, and
`/dialect forget` deletes a server's data outright. GIFs are stored as links
only; no image is ever re-uploaded or copied. Secrets are scrubbed from every
log line (`utils/log.js`), and full payload logging is off unless you set
`DEBUG_PAYLOADS=1`.

**What goes to the model provider, and what happens to it there.** Every
reply sends real server messages (the dialect, the precedent, the
conversation) to whichever provider you've configured. On OpenRouter that
message can be served by any of several backing companies hosting the same
model — for the default text model that could be DeepSeek's own infrastructure
or a third party serving the same open weights. By default, **every request
this bot sends carries `provider: { data_collection: "deny", zdr: true }`**
— OpenRouter reads this before routing and only sends the request to a
backing host that neither trains on it nor retains it at all. This is
per-request and on by default (`LLM_DENY_TRAINING`, `LLM_ZDR` in
`.env.example` — set either to `0` only if a specific model has no compliant
host and you'd rather it work than fail closed).

This is enforcement, not just a promise: it's a field sent with every API
call, not a setting you have to remember to check. It's also not a
replacement for your **OpenRouter account's own privacy settings**
(dashboard → Settings → Privacy) — that page has its own toggle for whether
free-model prompts can be used for training, on some accounts by default.
Turn that off too; the two are belt-and-suspenders, not either/or.

If you switch providers, the same reasoning applies but the mechanism is
different — Groq, Gemini, and OpenAI don't understand OpenRouter's
`provider` field (this bot only sends it to OpenRouter), so check that
provider's own dashboard/API for a training opt-out or retention setting.

## Development

```bash
bun test                          # 228 tests
bun test tests/corpusLearning.test.js
bun run dashboard                 # local usage dashboard (dev only)
```

Architecture notes for contributors — and for Claude Code — are in
[CLAUDE.md](CLAUDE.md).
