# Running `book.teddessert.com` on a small VPS

A small amd64 VPS **pulls and runs** the image; it never builds it. GitHub
Actions (`.github/workflows/build-image.yml`) builds on every push to `main`
that touches `app/**` and pushes `ghcr.io/modestapproach/teddessert-booking:latest`
(plus a `:<sha>` tag). Public traffic arrives through a Cloudflare Tunnel, so
the VPS has **no open inbound ports except SSH** — no 80/443, no reverse proxy,
no certificates to manage.

```
Internet ──► Cloudflare edge ──► cloudflared (on the VPS) ──► 127.0.0.1:3000 ──► container
```

**Why a VPS and not the LattePanda at home:** the Panda is for things whose
downtime hurts only you (Twenty, personal tooling). A public booking page fails
*silently* — when a home link or the power blips, the person who didn't manage
to book never tells you. ~$5/mo in a datacenter is the right trade for that.

Everything below is copy-pasteable on a fresh Debian 12 / Ubuntu 24.04 VPS.

---

## 0. Provision the box

Any provider. Requirements:

- **amd64** (x86-64). The image is single-arch; an ARM box will not run it.
- **4 GB RAM** recommended, 2 GB is the floor. The Next.js server idles around
  1 GB and spikes on cold routes. Hetzner's smallest x86 plan (~€4/mo, 4 GB)
  is the reference point; a 2 GB box from any provider works with the swap
  file below.
- 20 GB disk is plenty (image is ~175 MiB compressed, ~600 MiB unpacked).

First login is usually `root`. Create a user and lock things down:

```bash
adduser ted
usermod -aG sudo ted
# Copy your SSH key across, then log back in as ted before continuing
rsync --archive --chown=ted:ted ~/.ssh /home/ted
```

As `ted`:

```bash
sudo apt-get update && sudo apt-get install -y ufw unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades   # answer Yes

# Firewall: SSH in, nothing else. The tunnel is outbound-only.
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw --force enable
sudo ufw status
```

> Docker publishes ports by writing iptables rules **ahead of** ufw, so ufw
> would not protect a container bound to `0.0.0.0`. That is why
> `docker-compose.yml` binds `127.0.0.1:3000` explicitly — the loopback bind is
> the actual protection, the firewall is belt-and-braces.

On a 2 GB box, add swap so a memory spike degrades instead of OOM-killing:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

## 1. Install Docker + the compose plugin

Debian's `docker.io` package has no compose plugin — use Docker's own repo.

```bash
sudo apt-get install -y ca-certificates curl gnupg

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") \
$(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

# Run docker without sudo (log out and back in, or `newgrp docker`, to apply)
sudo usermod -aG docker "$USER"
newgrp docker

docker --version && docker compose version
```

## 2. Put the deploy files on the box

```bash
sudo apt-get install -y git
git clone https://github.com/modestapproach/teddessert-booking.git ~/teddessert-booking
cd ~/teddessert-booking/deploy

cp .env.example .env
# Generate the two random values and paste them in, then fill in the OWNER_* ones
openssl rand -hex 32   # → NEXTAUTH_SECRET
openssl rand -hex 16   # → CALENDSO_ENCRYPTION_KEY
nano .env
chmod 600 .env
```

`OWNER_PASSWORD` is the password you will type at `/owner-login`.
`OWNER_USERNAME` becomes the public path: `book.teddessert.com/<username>/<slug>`.

Fresh secrets are fine — nothing durable is encrypted with them. Bookings,
event types, availability and Google tokens all live in Convex.

> `deploy/.env` is gitignored. Keep it off GitHub.

## 3. GHCR authentication — not needed today

The package is **public** (it inherits the repository's visibility, and
`modestapproach/teddessert-booking` is public), so the box pulls anonymously.
Verified: an unauthenticated manifest fetch of
`ghcr.io/modestapproach/teddessert-booking:latest` returns 200.

It only becomes an issue if the repo (or just the package) is ever made
private. Then log in once with a **classic** personal access token carrying
the `read:packages` scope (github.com → Settings → Developer settings → Tokens):

```bash
echo "<YOUR_PAT>" | docker login ghcr.io -u <your-github-username> --password-stdin
```

## 4. Pull and start

```bash
cd ~/teddessert-booking/deploy
docker compose pull             # ~175 MiB compressed, well under a minute
docker compose up -d
docker compose logs -f          # Ctrl-C once you see the Next.js "Ready" line
```

### Verify it is serving locally

```bash
curl -sI localhost:3000/owner-login
```

Expect `HTTP/1.1 200 OK`. A `307` to `https://book.teddessert.com/...` is also
fine (the app canonicalises to `NEXT_PUBLIC_WEBAPP_URL`) — what matters is that
something answers. Connection refused means the container is not up: check
`docker compose ps` and `docker compose logs --tail=100`.

Also confirm it is **not** reachable from the internet — from your laptop,
`curl --max-time 5 http://<vps-public-ip>:3000/` must fail to connect.

## 5. Cloudflare Tunnel

### Install cloudflared

```bash
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
https://pkg.cloudflare.com/cloudflared any main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list > /dev/null
sudo apt-get update && sudo apt-get install -y cloudflared
cloudflared --version
```

### Log in

```bash
cloudflared tunnel login
```

This prints a URL and waits. **There is no browser on a VPS** — copy the
printed `https://dash.cloudflare.com/argotunnel?...` URL into a browser on your
laptop, sign in, and pick the **teddessert.com** zone. The command then writes
`~/.cloudflared/cert.pem` and exits.

### Create the tunnel and its DNS record

```bash
cloudflared tunnel create book
# → "Created tunnel book with id 6f9a...  Credentials written to
#    /home/ted/.cloudflared/6f9a....json"   ← note that UUID

cloudflared tunnel route dns book book.teddessert.com
```

That creates the proxied CNAME `book.teddessert.com → <UUID>.cfargotunnel.com`.
If a record for `book` already exists (left over from the old Cloudflare
Containers route), delete it in the dashboard first or add `--overwrite-dns`.

### Install the config

```bash
TUNNEL_ID=<paste-the-uuid>

sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/"$TUNNEL_ID".json /etc/cloudflared/
sudo cp ~/teddessert-booking/deploy/cloudflared-config.yml /etc/cloudflared/config.yml
sudo sed -i "s/<TUNNEL-UUID>/$TUNNEL_ID/g" /etc/cloudflared/config.yml
sudo chmod 600 /etc/cloudflared/"$TUNNEL_ID".json

cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate
```

### Run it as a systemd service

```bash
sudo cloudflared --config /etc/cloudflared/config.yml service install
sudo systemctl enable --now cloudflared
systemctl status cloudflared --no-pager
sudo journalctl -u cloudflared -f      # look for "Registered tunnel connection"
```

`service install` reads `/etc/cloudflared/config.yml`, so the unit picks up the
tunnel and credentials above.

### End-to-end check

```bash
curl -sI https://book.teddessert.com/owner-login
```

Then open `https://book.teddessert.com/owner-login` in a browser, sign in with
`OWNER_PASSWORD`, and connect Google Calendar from the dashboard. That last
step is the one to actually do: the OAuth return leg is
`effervescent-dinosaur-191.convex.site/calendar/oauth/callback`, which none of
this changed, but it is the piece most worth confirming end to end.

## 6. How to update

Push to `main` (touching `app/**`) or run the **Build booking image (GHCR)**
workflow by hand; wait for it to go green, then on the VPS:

```bash
cd ~/teddessert-booking/deploy
docker compose pull
docker compose up -d
```

Compose recreates the container only if the pulled digest changed. Reclaim the
old layers now and then:

```bash
docker image prune -f
```

To roll back, pin the image to a commit SHA in `docker-compose.yml`
(`image: ghcr.io/modestapproach/teddessert-booking:<sha>`) and
`docker compose up -d`. Every green build on `main` has one.

## Troubleshooting

| symptom | check |
| --- | --- |
| `docker compose pull` → `denied` | the package went private — GHCR login (step 3) |
| container restarts in a loop | `docker compose logs --tail=200`; usually a missing var in `.env` |
| container killed, `exit 137` | OOM — add the swap file (step 0) or move to a 4 GB box |
| 502 from Cloudflare | container down, or cloudflared pointing at the wrong port: `curl -sI localhost:3000/owner-login` |
| tunnel connects but 404 | hostname in `/etc/cloudflared/config.yml` does not match the DNS record |
| disk filling up | `docker system df`, then `docker image prune -f` — old `:<sha>` layers |

Nothing on the box holds state: bookings, event types, availability and Google
tokens all live in the Convex deployment (`effervescent-dinosaur-191`). The VPS
is disposable — destroy it, provision another, redo these steps, and everything
is back.
