# 𓂃⊹ 𝐁𝐋𝐎𝐎𝐌 ⟡ 𝐏𝐄𝐓𝐀𝐋 — Pinterest Telegram Bot

A modular Node.js bot that searches Pinterest through the **official Pinterest API**, filters candidates, processes images, generates aesthetic captions, prevents duplicates, and publishes to a Telegram channel on a schedule.

## Multi-user channels

You never edit a channel ID in `.env`. Every Telegram user who opens the bot connects their own channel(s) entirely through chat:

1. `/start` → **➕ Add Channel**
2. Send the channel's `@username` (or forward a message from it)
3. Add the bot as an *admin* in that channel with **Post Messages** permission
4. Tap **✅ Verify Admin** — the bot checks this via `getChatMember` and saves the channel against that user's Telegram ID
5. **📡 My Channels** lets a user switch their active (⭐) channel or remove one
6. If a user has more than one channel, Search & Post / Bulk / Post Now ask which channel to use before starting

The unattended hourly job is automatic too: it broadcasts each post to **every channel anyone has connected** through ➕ Add Channel — there's no fixed channel to configure. As soon as someone adds and verifies a channel, it starts receiving the scheduled posts on the next run.

## Important Pinterest/API note

This project deliberately does **not** scrape Pinterest HTML, automate a browser against Pinterest, bypass CAPTCHAs, evade rate limits, or use stolen cookies/session data.

The Pinterest integration targets the official API endpoint:

`GET /v5/search/partner/pins`

Access to that endpoint is subject to Pinterest's current developer approval/access model. If your Pinterest app does not have the required endpoint access, the search layer will fail cleanly instead of switching to an unofficial scraper.

## Video Search

🎥 Video Search lets a user search Pinterest for video pins, preview the returned thumbnails, **download a selected video directly into the Telegram chat**, or post that selected video to their connected channel. It searches, shows up to `VIDEO_RESULTS_PER_QUERY` results (default 6) as a pick-one list. Each result has separate **📥 Download** and **📤 Post to Channel** controls, plus an **🔗 Open Pin** link when a source URL is available. Nothing downloads for results you do not select. Only pins with a direct, progressive video file are eligible; HLS-only (`.m3u8`) pins are skipped since Telegram needs an actual video file, not a stream manifest.

## Rights/copyright

A Pinterest Pin is not automatically licensed for redistribution.

By default the bot requires a source link. You are responsible for only publishing content you have the necessary rights/permission to repost.

For a stricter setup, populate:

`LICENSED_SOURCE_DOMAINS=example.com,another-site.com`

Then only Pins whose source URL belongs to one of those domains are accepted.

## Requirements

- Node.js 20+
- A Telegram bot token from @BotFather
- Each user adds the bot as an administrator to their own channel via chat (no manual setup needed)
- A Pinterest developer app with an appropriate API access token and access to the required search endpoint

## Install

```bash
git clone <your-repository-url>
cd bloom-petal-bot
npm install
copy .env.example .env
```

On PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env`.

## Telegram setup

1. Open Telegram and talk to `@BotFather`.
2. Create a bot with `/newbot`.
3. Copy the bot token.
4. Set:

```env
TELEGRAM_BOT_TOKEN=123456:ABC...
```

That's it — no channel ID to add here. Once the bot is running, message it and use `/start → ➕ Add Channel` to connect a channel (see "Multi-user channels" above).

## Pinterest setup

1. Create/sign in to your Pinterest developer application.
2. Complete the app setup/approval required by Pinterest.
3. Obtain an OAuth access token with the scopes/access required by the search endpoint.
4. Put the token in:

```env
PINTEREST_ACCESS_TOKEN=...
```

Do not commit `.env`.

## Run locally

```bash
npm install
npm start
```

For development:

```bash
npm run dev
```

The default schedule is once every hour.

The bot will log messages similar to:

```text
Pinterest search
20 candidates received
candidate filtering
image processing
caption generation
Telegram upload
database update
cleanup
```

## Test immediately

Set:

```env
RUN_ON_START=true
```

Then:

```bash
npm start
```

The bot performs one publishing cycle immediately and then continues on the normal schedule.

Set it back to:

```env
RUN_ON_START=false
```

after testing.

## Change posting interval

Default:

```env
POST_INTERVAL=3600
```

3600 seconds = 1 hour.

Examples:

```env
POST_INTERVAL=1800
```

30 minutes.

```env
POST_INTERVAL=7200
```

2 hours.

The scheduler accepts whole-minute intervals.

## Change images per post

```env
IMAGES_PER_POST=1
```

For albums:

```env
IMAGES_PER_POST=3
```

Telegram media groups support albums, and the bot automatically switches to an album when more than one image survives filtering.

Keep this at 1 if you want one clean post every hour.

## Change categories/searches

Edit:

`src/pinterest/queries.js`

Example:

```js
wallpapers: [
  "pink iphone wallpaper",
  "soft flower wallpaper",
  "dreamy night wallpaper"
]
```

The scheduler randomly chooses a category and query while avoiding the immediately previous category/query where possible.

## Caption style

Edit:

`src/captions/generator.js`

Each category has its own caption bank.

Categories currently include:

- wallpaper
- pfp
- couple
- movie
- sad
- nostalgic
- quote
- default

Captions use occasional symbols such as:

`♡ ୨୧ ✧ ⟡ 𓂃 ☾ ⋆`

without forcing the same branding line onto every post.

## Duplicate detection

SQLite stores:

- Pinterest Pin ID
- SHA-256 image hash
- source URL
- category
- search query
- generated caption
- Telegram message ID
- posting status
- timestamp

The bot skips a Pin ID that has already been posted.

It also calculates a SHA-256 hash after processing to catch exact duplicate files.

## Image processing

Images are:

1. downloaded with a size limit
2. validated with Sharp
3. checked for minimum dimensions
4. rotated according to EXIF orientation
5. resized without enlargement
6. converted to JPEG
7. metadata-stripped by default
8. compressed if necessary
9. uploaded
10. deleted from the temporary downloads directory

## Failure handling

A failed hour does not stop the scheduler.

The worker catches errors from:

- Pinterest
- HTTP downloads
- invalid image data
- image processing
- duplicate detection
- Telegram
- rate limiting

Retryable network/API errors use exponential backoff.

If Pinterest returns no usable candidates, the bot logs the result and waits for the next scheduled run.

## Deployment with Docker

Build:

```bash
docker build -t bloom-petal-bot .
```

Run:

```bash
docker run -d \
  --name bloom-petal \
  --restart unless-stopped \
  --env-file .env \
  -v bloom-petal-data:/app/data \
  bloom-petal-bot
```

The persistent volume keeps the SQLite database when the container is recreated.

## VPS deployment

On Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y git
```

Install Node.js 20+ using your preferred supported Node installation method.

Then:

```bash
git clone <your-repository-url>
cd bloom-petal-bot
npm ci --omit=dev
cp .env.example .env
nano .env
npm start
```

For a long-running VPS process, use systemd, Docker, or another process supervisor.

### systemd example

Create:

```text
/etc/systemd/system/bloom-petal.service
```

with:

```ini
[Unit]
Description=BLOOM & PETAL Telegram Pinterest Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/bloom-petal-bot
ExecStart=/usr/bin/node /opt/bloom-petal-bot/src/main.js
Restart=always
RestartSec=10
EnvironmentFile=/opt/bloom-petal-bot/.env

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable bloom-petal
sudo systemctl start bloom-petal
sudo systemctl status bloom-petal
```

View logs:

```bash
journalctl -u bloom-petal -f
```

## Security

Never commit:

```text
.env
Pinterest access tokens
Telegram bot tokens
database files
```

The included `.gitignore` protects these by default.

If a Telegram bot token or Pinterest token is accidentally exposed, rotate/revoke it immediately.

## Architecture

```text
Scheduler
   │
   ▼
Query rotation
   │
   ▼
Official Pinterest API
   │
   ▼
Candidate filtering
   │
   ├── source/right check
   ├── sponsored check
   ├── duplicate Pin check
   └── image URL check
   │
   ▼
Download
   │
   ▼
Sharp validation/processing
   │
   ├── dimensions
   ├── format normalization
   ├── resize
   └── compression
   │
   ▼
SHA-256 duplicate check
   │
   ▼
Caption generator
   │
   ▼
Telegram
   │
   ├── sendPhoto
   └── sendMediaGroup
   │
   ▼
SQLite history
   │
   ▼
Cleanup
```

## Production notes

This project intentionally avoids an unofficial Pinterest scraper. If Pinterest changes the official API or your application loses access to the partner-search endpoint, update only the Pinterest provider layer instead of replacing the whole application with a scraper.

For higher-quality visual classification, `src/images/classifier.js` can later be replaced with an authorized vision API/provider. The rest of the publishing pipeline does not need to change.

## v2.0 upgrades

This release adds a stronger operator experience without changing the official Pinterest/API-first approach:

- 📊 Per-user statistics plus today / 7-day totals and category breakdowns
- 📋 Persistent schedule list with per-schedule cancellation
- ⚙️ Per-user preferences for notifications, album preference, and automatic-post image cap
- 🛑 Safe task cancellation in addition to pause/resume
- 👤 Search tasks are associated with the requesting Telegram user
- 📌 Posted records now retain target channel/user metadata for better reporting
- 🧹 Safer SQLite migrations for existing v1 databases
- 🔁 Scheduler remains alive when an individual scheduled task fails
- 🚦 Minimum safe posting interval of 60 seconds
- 🌐 Render deployment switched to a Web Service so the health endpoint is available
- 🛡️ Added `.gitignore` and `.dockerignore` to prevent secrets/database/temp files from being committed

### New commands

- `/schedule` — list your pending schedules
- `/settings` — show your personal preferences
- `/cancel` — cancel your active search/post task
- `/stats` — show your personal posting statistics

You can also access these from **✨ More** in the bot menu.


## Admin controls
Set `ADMIN_IDS` to comma-separated Telegram user IDs. Admins can use `/admin` to:
- Enable/disable maintenance mode
- Enable/disable Force Join
- Add/remove required Force-Join channels
- View basic admin status

The bot must be an administrator in every Force-Join channel. Admins bypass maintenance and Force Join so they can always manage the bot.

## Search result publishing modes

After a Pinterest search finishes preparing the images, the bot now lets the user choose:

- **📚 Post as Album** — publishes results in Telegram media groups (up to 10 images per album).
- **🖼️ Normal Posts** — publishes each image as its own Telegram photo message.
- **✍️ Custom Caption** — enter one caption and apply it to every image, then choose Album or Normal Posts.
- **🗑️ Cancel** — cleans up the prepared files without posting them.

Custom captions are limited by Telegram's photo caption limits and are applied to every prepared image.


## 2.1.0 Reliability Upgrade

- Fixed duplicate `batch_*` callback registrations that caused buttons to fire twice or report expired searches.
- Fixed custom-caption input: the bot now waits for the user's actual next text message.
- Removed unsupported inline-button `style` fields that could cause Telegram button errors.
- Added early callback acknowledgement so slow force-join/database checks do not consume Telegram's callback window.
- Album publishing now validates files, applies the custom caption to every image, respects Telegram's 10-item media-group limit, and can fall back to individual photo posts when Telegram rejects an album.
- Hardened temporary-file cleanup and added a backwards-compatible `cleanFile()` helper.
- Added admin statistics and temporary-download cleanup controls.


## v2.2 UI and reliability upgrades

- Uses the supplied couple artwork as the local Bloom ⟡ Petal menu card, so menu rendering no longer depends on an external image host.
- Hardened menu buttons against Telegram's `editMessageText` vs `editMessageCaption` mismatch. A callback can safely originate from either a photo card or a text message.
- Search completion now shows a real image preview card before choosing Album, Normal Posts, or Caption All.
- Search preview includes an Open Source Pin button when a valid HTTP(S) source URL exists.
- Custom caption flow remains text-driven and validates Telegram's 1024-character photo-caption limit.
- Video results now expose separate Download and Post controls.
- Temporary video files are cleaned after a direct download to chat.
- The menu artwork is bundled at `src/assets/menu-card.jpg`, making deployment deterministic.

### Suggested additional features

The architecture is ready for per-user caption presets, favorites, scheduled video posts, richer search filters, download-history cleanup, and admin broadcast tooling without changing the core Pinterest/Telegram pipeline.
