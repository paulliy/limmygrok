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

### A word on OpenRouter's free tier

Models whose IDs end in `:free` cost nothing but are capped at **20
requests/minute and 50 requests/day** on an account that has never purchased
credit. That is fine for testing and too small for a live server — the bot will
start replying with a rate-limit message partway through the evening.

Two ways out, both cheap:

- A **one-time $10 credit purchase** raises the free-model cap to 1,000
  requests/day, permanently.
- Or use a **paid model** — the default `meta-llama/llama-3.3-70b-instruct`
  bills per token at a fraction of a cent per reply, with no daily cap.

The bot tells you which of these you have hit: a 429 produces a plain-English
message in Discord rather than a wall of provider JSON.

## 4. Start it

```bash
docker compose up -d
docker compose logs -f
```

You should see the provider line, the slash-command deploy, and then the login:

```
[BOOT] LLM provider: OpenRouter — model meta-llama/llama-3.3-70b-instruct
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
| `[FATAL] config.json is missing required key(s)` | A variable is unset or blank in `.env`. The message names which. |
| Bot online but never replies to ambient chat | The channel is not on the allowlist — run `/channels add`. |
| Bot ignores everything, even @mentions | **Message Content Intent** is off in the Developer Portal. |
| `Rate limited by OpenRouter` | The free-tier daily cap. See §3. |
| `/dialect show` says nothing learned | No channel added yet, or the bot lacks **Read Message History** for the backfill. |
| Slash commands missing | `DISCORD_GUILD_ID` is wrong, or the bot was invited without the `applications.commands` scope. |
