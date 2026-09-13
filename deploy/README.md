# Running `book.teddessert.com` on the LattePanda

The LattePanda 3 Delta (Intel N5105, 8 GB RAM, 64 GB eMMC, amd64) **pulls and
runs** the image; it never builds it. GitHub Actions
(`.github/workflows/build-image.yml`) builds on every push to `main` that
touches `app/**` and pushes `ghcr.io/modestapproach/teddessert-booking:latest`
(plus a `:<sha>` tag). Public traffic arrives through a Cloudflare Tunnel, so
the Panda needs **no port forwarding, no public IP, no inbound firewall rule**.

```
Internet ──► Cloudflare edge ──► cloudflared (on the Panda) ──► 127.0.0.1:3000 ──► container
```

Everything below is copy-pasteable on a fresh Debian 12 / Ubuntu 24.04 install.
Run it as a normal user with sudo. `$USER` is assumed to be that user.

---

## 1. Install Docker + the compose plugin

Debian's `docker.io` package has no compose plugin — use Docker's own repo.

```bash
sudo apt-get update
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

## 2. Move Docker's data-root to an external SSD

**Do this before the first pull.** The image is several GB and every update
rewrites layers; the 64 GB eMMC is soldered on and will wear out. Plug in a USB
3.0 / M.2 SSD first.

```bash
# Find the SSD (look for the right size, e.g. /dev/sda1)
lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT
```

Format it **only if it is a blank disk** — this erases everything on it:

```bash
sudo mkfs.ext4 -L dockerssd /dev/sda1     # ← check the device name first!
```

Mount it at boot and point Docker at it:

```bash
sudo mkdir -p /mnt/ssd
echo 'LABEL=dockerssd /mnt/ssd ext4 defaults,noatime,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a
df -h /mnt/ssd

sudo systemctl stop docker docker.socket
sudo mkdir -p /mnt/ssd/docker /etc/docker
sudo rsync -aP /var/lib/docker/ /mnt/ssd/docker/     # no-op on a fresh install

# Merge into daemon.json (this overwrites it — fine on a fresh box)
sudo tee /etc/docker/daemon.json > /dev/null <<'JSON'
{
  "data-root": "/mnt/ssd/docker",
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON

sudo systemctl start docker
docker info | grep "Docker Root Dir"     # → /mnt/ssd/docker

# Only once the line above is correct:
sudo rm -rf /var/lib/docker.bak && sudo mv /var/lib/docker /var/lib/docker.bak
```

## 3. Put the deploy files on the box

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

> `deploy/.env` is gitignored. Keep it off GitHub.

## 4. GHCR authentication — not needed today

The package is **public** (it inherits the repository's visibility, and
`modestapproach/teddessert-booking` is public), so the Panda can pull anonymously.
Verified: an unauthenticated manifest fetch of
`ghcr.io/modestapproach/teddessert-booking:latest` returns 200. Skip to step 5.

It only becomes an issue if the repo (or just the package) is ever made
private. Then log in once on the Panda with a **classic** personal access token
carrying the `read:packages` scope (github.com → Settings → Developer settings →
Tokens):

```bash
echo "<YOUR_PAT>" | docker login ghcr.io -u <your-github-username> --password-stdin
```

Nothing secret is baked into the image — the `NEXT_PUBLIC_*` build args are the
public URLs — but the app source is inside it, which is the thing to weigh if
you are deciding on visibility.

## 5. Pull and start

```bash
cd ~/teddessert-booking/deploy
docker compose pull             # ~175 MiB compressed, a minute or two
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

Also confirm it is **not** on the LAN — from another machine,
`curl --max-time 5 http://<panda-lan-ip>:3000/` must fail to connect.

## 6. Cloudflare Tunnel

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

This prints a URL and waits. **On a headless Panda no browser opens** — copy
the printed `https://dash.cloudflare.com/argotunnel?...` URL into a browser on
your laptop, sign in, and pick the **teddessert.com** zone. The command then
writes `~/.cloudflared/cert.pem` and exits.

### Create the tunnel and its DNS record

```bash
cloudflared tunnel create book
# → "Created tunnel book with id 6f9a...  Credentials written to
#    /home/<user>/.cloudflared/6f9a....json"   ← note that UUID

cloudflared tunnel route dns book book.teddessert.com
```

That creates the proxied CNAME `book.teddessert.com → <UUID>.cfargotunnel.com`.
If a record for `book` already exists (e.g. from the old Cloudflare Containers
route), delete it in the dashboard first or add `--overwrite-dns`.

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
`OWNER_PASSWORD`, and connect Google Calendar from the dashboard.

## 7. How to update

Push to `main` (touching `app/**`) or run the **Build booking image (GHCR)**
workflow by hand; wait for it to go green, then on the Panda:

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

To pin or roll back to a specific build, set the image tag to a commit SHA:

```bash
docker compose pull && docker compose up -d          # latest
# or, for a rollback:
IMAGE_SHA=<sha> docker run --rm --env-file .env -p 127.0.0.1:3000:3000 \
  ghcr.io/modestapproach/teddessert-booking:$IMAGE_SHA
```

(For a lasting pin, edit the `image:` line in `docker-compose.yml` to
`:<sha>` and `docker compose up -d`.)

## Troubleshooting

| symptom | check |
| --- | --- |
| `docker compose pull` → `denied` | the package went private — GHCR login (step 4) |
| container restarts in a loop | `docker compose logs --tail=200`; usually a missing var in `.env` |
| 502 from Cloudflare | container down, or cloudflared pointing at the wrong port: `curl -sI localhost:3000/owner-login` |
| tunnel connects but 404 | hostname in `/etc/cloudflared/config.yml` does not match the DNS record |
| eMMC filling up | `docker info \| grep "Docker Root Dir"` — should be on the SSD (step 2) |
| OOM during startup | 8 GB is enough for the runtime; make sure nothing else large runs on the box |

Nothing in this directory holds state: bookings, event types, availability and
Google tokens all live in the Convex deployment
(`effervescent-dinosaur-191`). The Panda is disposable — reimage it, redo these
steps, and everything is back.
