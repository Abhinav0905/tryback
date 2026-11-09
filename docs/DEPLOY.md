# Deploying TryBack

TryBack runs as **one Node.js server with a persistent disk**. The JSON store, shopper photos and the render cache live in `TRYBACK_DATA_DIR` (`/data` in the container), and renders finish in `after()` callbacks after the HTTP response. So:

- **One machine, never more.** A second instance would have its own store and lose or race data.
- **Never auto-stop it.** A stopped machine drops in-flight renders, and a cold start resets the in-memory rate limits.
- **No serverless.** Each request could land on a fresh filesystem.

The repo ships a `Dockerfile` (multi-stage, Next.js `output: "standalone"`), a `fly.toml` and a `render.yaml`. Fly.io is the recommended path. Render and a plain VPS are the alternatives.

Nothing here has been deployed yet: no account, app or volume exists. Every step below is yours to run.

## Contents

1. [Before you deploy](#1-before-you-deploy)
2. [Environment variables](#2-environment-variables)
3. [Fly.io (alternative; needs a card after the 7-day trial)](#3-flyio-alternative-needs-a-card-after-the-7-day-trial)
4. [Render (free plan, no card; hosts the live demo)](#4-render-free-plan-no-card-hosts-the-live-demo)
5. [Any VPS with Docker (alternative)](#5-any-vps-with-docker-alternative)
6. [Post-deploy check](#6-post-deploy-check)
7. [Judges: replay link or code-gated live renders](#7-judges-replay-link-or-code-gated-live-renders)
8. [Pre-warm the render cache for judges](#8-pre-warm-the-render-cache-for-judges)
9. [Rotate the access code (or the admin token)](#9-rotate-the-access-code-or-the-admin-token)
10. [Retention, reset and other admin tasks](#10-retention-reset-and-other-admin-tasks)
11. [What is hardened for a public URL](#11-what-is-hardened-for-a-public-url)
12. [Costs](#12-costs)
13. [Troubleshooting](#13-troubleshooting)

## 1. Before you deploy

- Settle the product images in `public/catalog/` first (README, Product photos: five AI-generated families, three licensed photos). The render cache key includes the product image's bytes, so **pre-warm only after the final images are in** (section 8).
- Check that the build is green locally: `npm test`, `npm run typecheck`, `npm run build`.
- Generate two secrets and keep them in a password manager:

  ```bash
  openssl rand -hex 24                          # ADMIN_TOKEN: admin wipe, retention, pins
  printf 'tryback-%s\n' "$(openssl rand -hex 4)" # LIVE_ACCESS_CODE: short enough for judges to type
  ```

## 2. Environment variables

| Variable | Where | Notes |
|---|---|---|
| `CLOTHSY_API_KEY` | secret | Live try-on. Without it every render is the labelled dev double. |
| `LIVE_ACCESS_CODE` | secret | Only browsers that unlocked with this code can spend credits. Everyone else replays. **Set it on any public deployment that has a Clothsy key.** |
| `ADMIN_TOKEN` | secret | Full demo wipe, `/api/admin/retention`, pins. Without it those are disabled. |
| `ANTHROPIC_API_KEY` | secret, optional | LLM diagnosis of the form text. Without it, keyword rules handle the text. |
| `TRYON_MODE` | env | `auto` (default in `fly.toml`/`render.yaml`), `replay` (0 credits), `dev`, `live`. |
| `DAILY_LIVE_RENDER_CAP` | env | Live renders per UTC day before the labelled dev double takes over. `fly.toml` and `render.yaml` set **5** (the judges' pre-warm). Keep it at or below the credits you have left; `npm run doctor` shows the balance and fails while the cap is higher. The code default (40) is only for a missing variable. |
| `MAX_RENDERS_PER_RETURN` | env | Credit cap per return, default 5. |
| `CLIENT_IP_HEADER` | env, optional | Which header names the caller for the rate limits. Leave unset on Fly (`fly-client-ip`) and Render (`true-client-ip`, set by Cloudflare in front of Render); elsewhere the default is the **last** `X-Forwarded-For` hop. See section 11. |
| `PHOTO_RETENTION_HOURS`, `RENDER_RETENTION_DAYS` | env | Default **and maximum** 24 h and 14 days, as promised in the consent copy. Values above the maximum are clamped (and logged). |
| `ALLOW_PUBLIC_LIVE` | env | Leave unset. See the fail-safe below. |
| `CREDIT_USD` | env | Your real price per credit, for the dashboard. |
| `TRYBACK_DATA_DIR`, `PORT`, `HOSTNAME`, `NODE_ENV` | set by the image | `/data`, `3000`, `0.0.0.0`, `production`. |

**Fail-safe:** on a production server (`NODE_ENV=production`) with a Clothsy key but **no** `LIVE_ACCESS_CODE`, nobody gets live renders: every visitor is treated as replay, and the boot log says so. This keeps the 20 free credits from being drained by anyone who finds the URL. To open live renders to everyone anyway, set `ALLOW_PUBLIC_LIVE=1`. Live renders stay bounded by `DAILY_LIVE_RENDER_CAP`. `npm run dev` on your laptop is unaffected.

Secrets are runtime-only. `.dockerignore` keeps every `.env*` file out of the build context, and nothing secret is baked into the image.

## 3. Fly.io (alternative; needs a card after the 7-day trial)

`fly.toml` sets up one always-on `shared-cpu-1x` machine with 1 GB of RAM in Singapore (`sin`, the closest Fly region to India now that Mumbai is gone), a volume mounted at `/data`, forced HTTPS, a health check on `/api/status`, `auto_stop_machines = "off"`, `min_machines_running = 1`, and a 120 s `kill_timeout` so in-flight renders can finish on deploys.

1. **Install flyctl and sign in.**

   ```bash
   brew install flyctl            # or: curl -L https://fly.io/install.sh | sh
   fly auth login                 # first time: fly auth signup
   ```

2. **Create the app from the repo's config.** Pick a globally unique name. It becomes `https://<name>.fly.dev`.

   ```bash
   fly launch --no-deploy --copy-config --name tryback-<yourname>
   ```

   Answer **no** to any offer of Postgres, Redis or Tigris. Check that `app = "tryback-<yourname>"` is now in `fly.toml`.

3. **Create the volume.** Use exactly one volume, in the same region as the app.

   ```bash
   fly volumes create tryback_data --size 1 --region sin
   ```

   Fly warns that one volume means no high availability. That is intended: confirm. Fly also takes scheduled volume snapshots, which hold copies of deleted photos until the snapshots expire. To keep the "deleted after 24 hours" promise tight, set the snapshot retention to its minimum or turn scheduled snapshots off; run `fly volumes create --help` / `fly volumes update --help` for the flags in your flyctl version.

4. **Set the secrets.**

   ```bash
   fly secrets set \
     CLOTHSY_API_KEY='<your key>' \
     LIVE_ACCESS_CODE='<access code>' \
     ADMIN_TOKEN='<admin token>' \
     ANTHROPIC_API_KEY='<optional>'
   ```

   Check `DAILY_LIVE_RENDER_CAP` in `fly.toml` (`[env]`, default **5**): keep it at or below the credits you have left (`npm run doctor` shows the balance). After the pre-warm, lower it or set `TRYON_MODE = "replay"` and `fly deploy` again.

5. **Deploy.** Fly builds the image on its remote builder, so you don't need Docker locally, and a corporate proxy's CA doesn't matter there.

   ```bash
   fly deploy
   ```

   **Behind a corporate proxy?** If `fly deploy` fails with `x509: certificate signed by unknown authority` (Depot builder) or a WebSocket `526` / `unable to upgrade to h2c` (Fly builder), your network is intercepting TLS. Deploy from GitHub's network instead with `.github/workflows/fly-deploy.yml`: store a deploy token once with `fly tokens create deploy --app <app> --name github-actions --expiry 2160h | gh secret set FLY_API_TOKEN --repo <owner>/<repo>`, then push to `main` or run `gh workflow run fly-deploy.yml`.

6. **Check it.**

   ```bash
   fly status                       # exactly ONE machine, state "started"
   fly logs                         # look for: [tryback] data dir /data · TRYON_MODE=auto
   npm run smoke -- --base https://tryback-<yourname>.fly.dev --admin-token '<admin token>'
   ```

   If `fly status` shows two machines, run `fly scale count 1`.

Later changes: `fly deploy` after code changes; `fly secrets set ...` after secret changes (this restarts the machine); edit `[env]` in `fly.toml` and `fly deploy` for non-secret settings such as `TRYON_MODE`.

## 4. Render (free plan, no card; hosts the live demo)

`render.yaml` is a Blueprint for one Docker web service on Render's **free** plan in `singapore` (the closest region to India), with a health check on `/api/status` and auto-deploy on every push to `main`. The free plan needs no payment method, but it has **no persistent disk**: the JSON store, photos and render cache are wiped whenever the service spins down (after 15 minutes without traffic) or redeploys, and a cold start takes about a minute. TryBack copes with that:

- The judges' pre-warmed Clothsy renders are committed in `seed/render-cache/` (5 renders of the AI-generated shopper in `public/judge-photo.jpg`), baked into the image, and restored and pinned on every start (`lib/seedCache.ts`; the boot log says `seed renders: 5 available`).
- Returns, photos and the daily live-render counter start fresh after each spin-down. The Clothsy account balance is the real ceiling on credits.

Steps:

1. In the Render dashboard, go to **New → Blueprint**, connect GitHub if asked, and pick the repo. Render reads `render.yaml`.
2. Fill in the secret variables it asks for (`CLOTHSY_API_KEY` from `.env.local`; `LIVE_ACCESS_CODE` and `ADMIN_TOKEN` from `.env.deploy.local`), then **Apply**.
3. When the deploy is live, run `npm run smoke -- --base https://<service>.onrender.com --admin-token <token>`.

For a persistent setup, switch to `plan: starter` (paid) and add `disk: { name: tryback-data, mountPath: /data, sizeGB: 1 }`; a service with a disk always runs as one instance, which is what TryBack needs.

## 5. Any VPS with Docker (alternative)

```bash
docker build -t tryback .
# Behind a TLS-inspecting proxy, give the build a CA bundle with the public roots AND your
# company root. It is mounted only for npm ci / next build and never stored in a layer:
#   docker build --secret id=ca,src=/path/to/ca-bundle.pem -t tryback .

docker volume create tryback_data
cat > ~/tryback.env <<'EOF'   # outside the repo, never committed
TRYON_MODE=auto
CLOTHSY_API_KEY=<your key>
LIVE_ACCESS_CODE=<access code>
ADMIN_TOKEN=<admin token>
EOF
chmod 600 ~/tryback.env
docker run -d --name tryback --restart unless-stopped \
  -p 127.0.0.1:3000:3000 -v tryback_data:/data --env-file ~/tryback.env \
  --stop-timeout 120 tryback
```

Put HTTPS in front of it. The shopper camera only works on `https://`. For example, with [Caddy](https://caddyserver.com):

```bash
caddy reverse-proxy --from tryback.example.com --to localhost:3000
```

Caddy replaces any `X-Forwarded-For` a client sends with the address it saw, and TryBack reads the last hop of that header by default, so rate limits work without extra settings. With nginx, use `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` (or set `X-Real-IP $remote_addr` and `CLIENT_IP_HEADER=x-real-ip`). Never expose port 3000 directly: without a proxy, every client could pick its own rate-limit identity. Add `DAILY_LIVE_RENDER_CAP=5` (at most your credits left) to `~/tryback.env`.

`--stop-timeout 120` gives in-flight renders time to finish on `docker stop`. The container starts as root only long enough to hand `/data` to the unprivileged `node` user, then runs the server as `node`. The image has a `HEALTHCHECK` on `/api/status`.

## 6. Post-deploy check

```bash
npm run smoke -- --base https://<your-url> [--admin-token '<admin token>'] [--check-rate-limit]
```

The smoke test first reads `/api/status`. **It aborts (exit code 2) before creating anything if a render from this client would use the live Clothsy API**, unless you pass `--allow-credits`. A replay deployment, or a code-gated one where you haven't unlocked the code, reports the dev double for an anonymous client, so the default run costs 0 credits.

It then checks:

- `/api/status`, the security headers on a page and an API route, and that `X-Powered-By` is absent
- the pages `/`, `/r`, `/merchant`, `/bench`, `/demo` and `/r/<id>`
- static chunks, the MediaPipe WASM, the pose model and a catalogue image (`.next/static` and `public/` are in the image)
- order lookup, return, reason, a **synthetic drawn photo** (never a person), renders, form, gate, exchange, metrics and `/bench` visibility
- the 413 for an oversized upload
- that "Reset demo" only clears this client's returns, and that wrong admin tokens get a 401

Everything it creates is reset at the end. `--check-rate-limit` also confirms a 429, but blocks new returns from your IP for about 10 minutes, so run it last. To smoke the live path on purpose, pass `--access-code <code> --allow-credits` (up to 5 credits).

## 7. Judges: replay link or code-gated live renders

**Option A, zero credits.** Set `TRYON_MODE = "replay"` in `fly.toml` (or the Render env) and redeploy. Cached renders replay for the same photo. Anything else uses the dev double, labelled "Simulated preview". Set `LIVE_ACCESS_CODE` anyway if you want the team's all-returns view on `/bench`.

**Option B, live renders for judges only.** Set `TRYON_MODE = "auto"` with `CLOTHSY_API_KEY` and `LIVE_ACCESS_CODE`. Visitors without the code replay. A judge unlocks live renders on the landing page with **"Have a judge access code? Unlock live try-on"**: the mode pill switches to "Live · Clothsy try-on", and the httpOnly cookie lasts 7 days. Put the code in the Devpost testing instructions, not in the README. Every live render still counts against `MAX_RENDERS_PER_RETURN` and `DAILY_LIVE_RENDER_CAP`.

## 8. Pre-warm the render cache for judges

Goal: judges see real AI renders even when no credits are left, by replaying renders you made earlier from the same photo.

1. **The photo.** Use a photo of a consenting adult team member who agreed to its use for judging. Make it a JPEG of at most 1600 px with no metadata. Such a file is uploaded byte-for-byte, so its cache key is the same from every browser. Using the project's own `sharp`, which strips metadata by default:

   ```bash
   node -e "require('sharp')(process.argv[1]).rotate().resize(1600,1600,{fit:'inside',withoutEnlargement:true}).jpeg({quality:90}).toFile(process.argv[2]).then(i=>console.log(i))" original.jpg judge-photo.jpg
   ```

2. **Render it live once.** On the deployed site, unlock the access code, then run the exact path you will give the judges: order **1042**, *Wrap Dress — Mustard*, **Style or colour didn't work**, upload `judge-photo.jpg`, pick the chips **Colour isn't me** and **Too clingy**, leave the note empty, and submit. The two speculative renders depend only on the order line. The post-form renders depend on the chips and note, so the judges' instructions must name the same chips and say "leave the note empty". This costs up to 5 credits. Optionally do the size beat too (order 1043, **Preview on me**).

   Ranking after the form also uses two numbers the browser measures from the photo (ease and hem length), and the LLM diagnosis if `ANTHROPIC_API_KEY` is set. So a judge's browser can occasionally rank a different SKU into the top two. That card then shows a labelled "Simulated preview" (replay) instead of a cached AI render. Say so in the testing instructions.

3. **Pin those renders.** Otherwise retention deletes them after 14 days, before judging ends. Copy the return id from the URL (`/r/<returnId>`), then:

   ```bash
   ADMIN_TOKEN='<admin token>' npm run purge -- --base https://<your-url> --pin <returnId> --note "team photo for judges"
   ```

   The return's photo is still deleted after 24 hours, because judges upload their own copy of the file. Only the renders are kept.

4. **Verify in a private window** (no access code): run the same path with the same file. The cards should say **"AI-generated preview"**, and `npm run purge -- --base <url> --status` should show the pins. You can switch to `TRYON_MODE=replay` now if you like.

5. **Share the file** in the Devpost testing instructions, with the team member's permission, alongside the exact click path from step 2.

6. **After judging**, run `npm run purge -- --base <url> --unpin-all`. The next hourly sweep deletes those renders.

## 9. Rotate the access code (or the admin token)

The `tb_live` cookie holds the code itself and is compared with the current `LIVE_ACCESS_CODE` on every request, so rotating the code locks out every old cookie at once.

- **Fly:** `fly secrets set LIVE_ACCESS_CODE='<new code>'` (restarts the machine).
- **Render:** change the variable in the dashboard; it redeploys.
- **VPS:** edit `~/tryback.env`, then `docker rm -f tryback` and run the same `docker run` again. The volume keeps the data.

Then update the Devpost testing instructions. Rotate `ADMIN_TOKEN` the same way.

## 10. Retention, reset and other admin tasks

**Retention runs by itself.** At boot (`instrumentation.ts`) the server starts an hourly sweep. As a fallback, `GET /api/status`, which the health checks hit, starts one whenever a sweep is overdue. Each sweep:

- deletes shopper photos within 24 hours of upload and clears the return's photo reference (that return's cards fall back to catalogue images). Each sweep deletes whatever would pass its limit before the next sweep, so a photo goes between 23 and 24 hours after upload
- deletes cached renders within 14 days of being made, together with their index entries
- removes photo files that no return points at
- never touches pinned renders or seeded demo history

The consent checkbox and the done screen state exactly this.

```bash
export ADMIN_TOKEN='<admin token>'
npm run purge -- --base https://<your-url> --status        # policy, last sweep, pins, files on disk
npm run purge -- --base https://<your-url> --dry-run       # what a sweep would delete now
npm run purge -- --base https://<your-url>                 # sweep now
npm run purge -- --local --data-dir .data                  # offline, local data (server stopped)
```

**Reset.** The **Reset demo** button on `/demo` (`POST /api/admin/reset` without a token) clears only the returns this browser created (cookie `tb_viewer`), so a public visitor can't wipe anyone else's demo. A full wipe needs the admin token:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<your-url>/api/admin/reset
```

Both keep the render cache, so re-runs with the same photo cost 0 credits until retention removes them.

**Backups.** Everything is in `/data` (`db.json`, `photos/`, `renders/`). On Fly, `fly ssh console -C "ls -la /data"` shows it. Back up with care: a copy of `photos/` is a copy of people's photos, and it falls outside the 24-hour promise.

## 11. What is hardened for a public URL

- **Security headers on every response:**
  - `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'self'`. `/demo` still frames `/r` from the same origin.
  - `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin` (`no-referrer` on photos).
  - `Permissions-Policy: camera=(self), microphone=(), geolocation=(), browsing-topics=()`. The camera works on the page and inside `/demo`'s same-origin iframe.
  - `Strict-Transport-Security`, `X-Robots-Tag: noindex, nofollow`, and no `X-Powered-By`.
- **Rate limits, in memory and per process.** Each limit applies per client and per 10 minutes, with a global cap so forged client addresses can't get around it. Over a limit, the server returns `429` with `Retry-After` and a message the shopper UI shows as is.

  | Endpoint | Per client | Global |
  |---|---|---|
  | New returns | 30 | 600 |
  | Photo uploads | 20 | 200 |
  | Form posts (may call the LLM) | 30 | 300 |
  | Size previews (credit) | 10 | 60 |
  | Gate posts | 240 | 2400 |
  | Gate retries (credit) | 10 | 60 |
  | Wrong admin tokens | 10 | 60 |
  | Wrong access codes (existing) | 10 | 60 |

  The client is identified by **one** header, the one the host's proxy sets, so a client can't pick its own identity by sending a header itself (`CLIENT_IP_HEADER` overrides the choice; the boot log prints it as `client IP from …`):

  | Host | Header | Why |
  |---|---|---|
  | Fly.io (`FLY_APP_NAME` set) | `Fly-Client-IP` | Fly's edge sets it and overwrites a client's copy. |
  | Render (`RENDER` set) | `True-Client-IP` | Render runs behind Cloudflare, which sets it; Render's proxy passes a client's `X-Forwarded-For` through. |
  | VPS behind Caddy or nginx | last `X-Forwarded-For` hop | The proxy appends (nginx) or replaces (Caddy) it with the address it saw. Or `CLIENT_IP_HEADER=x-real-ip` if your proxy sets `X-Real-IP`. |
  | Anything else | `CLIENT_IP_HEADER=none` | Only the global caps apply. |

  IPv6 addresses are grouped by /64. A wrong admin token counts against the failure limits, but the right token is checked first and always gets through, so nobody can lock the operator out by guessing.
- **Upload limits.** Photos are JPEG/PNG of at most 4 MB, and the whole request is capped at 4.5 MB while it streams in (with or without `Content-Length`), so an oversized upload is refused before it is buffered. JSON bodies are capped at 64 KB the same way.
- **Credits.** Live renders need the access code, with the production fail-safe described in section 2. The caps per return and per day still apply.
- **Secrets.** Server-only. A build with sentinel secret values was checked: none of them appear in the client or server output.

## 12. Costs

Approximate list prices at the time of writing. Check the provider's pricing page.

- **Fly.io:** one `shared-cpu-1x` machine with 1 GB of RAM running all month is about US$6, plus about US$0.15/GB-month for the volume. Bandwidth for a demo is negligible.
- **Render:** Starter instance about US$7/month, plus about US$0.25/GB-month for the disk.
- **VPS:** a 2 GB instance from a budget provider costs about US$4–6/month.
- **Clothsy:** 1 credit per finished try-on. Replays, the size lines and the no-photo path cost 0. See the credit plan in the README.

## 13. Troubleshooting

| Symptom | Fix |
|---|---|
| Boot log says `data dir /data is not writable` | The volume isn't mounted, or the container was started with `--user`. Let the entrypoint run as root; it chowns `/data` and drops to `node`. |
| Live renders never happen | Check `/api/status`. The boot log explains it if the production fail-safe is active. Unlock the access code in your browser, and check `DAILY_LIVE_RENDER_CAP`. |
| Data disappears after a deploy | No volume is mounted at `/data` (`fly volumes list`), or more than one machine is running (`fly scale count 1`). |
| Camera doesn't start | The page must be on `https://`. Other sites can't embed TryBack (`X-Frame-Options`), so open the URL directly. |
| `429` while rehearsing | The limits are per IP per 10 minutes. Wait for `Retry-After`, or restart the server to clear them. |
| `npm ci` / Google Fonts fail in `docker build` behind a proxy | Pass `--secret id=ca,src=<bundle with public roots + company root>`. |
