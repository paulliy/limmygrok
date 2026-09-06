# Running limmygrok 24/7 on Oracle Cloud (Always Free)

The goal: the bot stays online whether or not the machine at home is on, and
costs nothing per month.

Oracle Cloud's Always Free tier includes an **Ampere A1 (aarch64) instance with
up to 4 CPUs and 24 GB RAM**, permanently — not a trial. That is enormously
more than this bot needs, and it is the only mainstream free tier that does not
sleep idle services (Render's free tier does, which knocks a Discord gateway
client offline).

Total time: about 30 minutes, most of it waiting on Oracle's console.

---

## 1. Create the instance

1. Sign up at [cloud.oracle.com](https://cloud.oracle.com). A card is required
   for identity verification; the Always Free resources are not billed.
2. **Compute → Instances → Create instance.**
3. Change the image and shape:
   - **Image:** Canonical Ubuntu 24.04
   - **Shape:** *Ampere* → `VM.Standard.A1.Flex` → **1 OCPU, 6 GB RAM**
     (well within the free allowance, and plenty here — take more if you want
     to run other things on the same box.)
   - Confirm the shape is labelled **Always Free eligible**.
4. Under **Add SSH keys**, either paste your public key or let Oracle generate
   one and download it. You cannot log in without this.
5. Create, and wait for the instance to reach **Running**. Note the **public IP
   address**.

> **If you get "Out of capacity"** — a common and infuriating Ampere error —
> try a different availability domain, or a different home region. Upgrading
> the account to Pay As You Go (which still keeps Always Free resources free)
> materially improves capacity access.

## 2. Log in and install Docker

```bash
ssh ubuntu@<your-public-ip>
```

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker    # or just log out and back in
```

No firewall or open ports are needed. The bot is a Discord *client*: it holds
an outbound websocket and never accepts inbound connections. Leave Oracle's
security list closed.

## 3. Get the code and configure it

```bash
sudo apt install -y git
git clone https://github.com/paulliy/limmygrok.git
cd limmygrok
cp .env.example .env
nano .env
```

Fill in, at minimum:

| Variable | Where it comes from |
| --- | --- |
| `DISCORD_TOKEN` | [Developer Portal](https://discord.com/developers/applications) → your app → **Bot** → Reset Token |
| `DISCORD_CLIENT_ID` | Same app → **General Information** → Application ID |
| `DISCORD_GUILD_ID` | Right-click your server in Discord → Copy Server ID (needs Developer Mode) |
| `LLM_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) |

**Check the bot's Discord settings** while you are in the portal — under
**Bot → Privileged Gateway Intents**, enable **Message Content Intent**. The
bot cannot read messages (and therefore cannot learn anything) without it.

### Inviting the bot to your server

Still in the Developer Portal, go to **OAuth2 → URL Generator**:

- **Scopes:** `bot` *and* `applications.commands` (without the second, the
  slash commands register but never appear)
- **Bot Permissions:** Send Messages, Read Message History, Embed Links,
  Use External Emojis, Attach Files

Open the generated URL and pick your server. **Read Message History** is the
one people miss — `/channels add` uses it to backfill, and without it the bot
starts from nothing.

### A word on OpenRouter's free tier

Models whose IDs end in `:free` cost nothing but are capped at **20
requests/minute and 50 requests/day** on an account that has never purchased
credit. That is fine for testing and too small for a live server — the bot will
start replying with a rate-limit message partway through the evening.

Two ways out, both cheap:

- A **one-time $10 credit purchase** raises the free-model cap to 1,000
  requests/day, permanently.
- Or use a **paid model** — the defaults below bill per token at a fraction of
  a cent per reply, with no daily cap.

The bot tells you which of these you have hit: a 429 produces a plain-English
message in Discord rather than a wall of provider JSON.

### Models and privacy — both defaulted, neither needs setting

The bot uses **two** models and picks per request. The everyday one is
text-only; the vision one is swapped in only when a message actually contains
an image, so ordinary chat never pays multimodal rates:

| | Model | Cost |
| --- | --- | --- |
| Everyday chat | `deepseek/deepseek-v4-flash-0731` | $0.09/M in, $0.18/M out |
| Messages with images | `qwen/qwen3.7-flash` | $0.03/M in, $0.13/M out |

Override either with `LLM_MODEL` / `LLM_VISION_MODEL` if one gets retired — the
"Model not found" error names whichever is configured.

Every request also carries `data_collection: deny` and `zdr: true`, so
OpenRouter only routes it to a backing provider that neither trains on your
server's messages nor retains them. That is on by default; `LLM_DENY_TRAINING=0`
and `LLM_ZDR=0` relax it if a model you want has no compliant host.

**This does not cover your OpenRouter account settings.** Go to
[openrouter.ai/settings/privacy](https://openrouter.ai/settings/privacy) and
check the training toggle there too — some accounts allow training on
free-model prompts by default. The two are belt-and-braces, not either/or.

## 4. Start it

```bash
docker compose up -d
docker compose logs -f
```

You should see the provider line, the slash-command deploy, and then the login:

```
[BOOT] LLM provider: OpenRouter — model deepseek/deepseek-v4-flash-0731
[entrypoint] deploying slash commands...
Successfully reloaded 5 application (/) commands.
```

`restart: unless-stopped` means the bot comes back by itself after a crash and
after a VM reboot. Nothing else to configure.

## 5. Switch on learning

In Discord, in each channel the bot should listen to:

```
/channels add
```

This does two things: it enables ambient auto-responses there, and it reads
back through that channel's recent history so the bot learns how the server
talks **immediately** rather than over the following weeks.

Then check what it picked up:

```
/dialect show
```

You should see the server's own vocabulary, its catchphrases, its emoji, and
its typing habits. If that list looks like your server, the bot will sound like
your server.

---

## Day-to-day

```bash
cd ~/limmygrok

docker compose logs -f            # watch it
docker compose restart            # restart
docker compose down               # stop

git pull && docker compose up -d --build    # deploy a new version
```

The SQLite database — conversation memory, channel settings, and everything
learned about the server — lives in the `limmygrok-data` Docker volume, so it
survives rebuilds and redeploys. To back it up:

```bash
docker run --rm -v limmygrok_limmygrok-data:/data -v $(pwd):/backup \
  alpine tar czf /backup/limmygrok-backup.tar.gz -C /data .
```

## Keeping the instance

Oracle reclaims **idle** Always Free compute instances after a period of very
low utilisation. In practice a running Discord bot is enough activity to keep
it, but if you want certainty, upgrading the account to **Pay As You Go**
exempts you from idle reclamation entirely while leaving Always Free resources
free of charge.

## Running without Docker

If you would rather run Bun directly under systemd:

```bash
curl -fsSL https://bun.sh/install | bash
sudo cp deploy/limmygrok.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now limmygrok
journalctl -u limmygrok -f
```

Read `deploy/limmygrok.service` first — it assumes the repo is at
`/home/ubuntu/limmygrok` and the `.env` file sits alongside it.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `[FATAL] Configuration is missing required key(s)` | A variable is unset or blank in `.env`. The message names which. |
| Bot online but never replies to ambient chat | The channel is not on the allowlist — run `/channels add`. |
| Bot ignores everything, even @mentions | **Message Content Intent** is off in the Developer Portal. |
| `Rate limited by OpenRouter` | The free-tier daily cap. See §3. |
| `/dialect show` says nothing learned | No channel added yet, or the bot lacks **Read Message History** for the backfill. |
| Slash commands missing | `DISCORD_GUILD_ID` is wrong, or the bot was invited without the `applications.commands` scope. |
| `Model not found on this provider` | An OpenRouter model ID was retired. Set a current one via `LLM_MODEL` / `LLM_VISION_MODEL`. |
| Replies read like a generic chatbot | The corpus is still empty — check `/dialect show`. The voice comes from learned messages, so it needs some first. |
