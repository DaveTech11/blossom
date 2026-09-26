import "dotenv/config";
import path from "node:path";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

const root = process.cwd();
const adminIds = (process.env.ADMIN_IDS || process.env.ADMIN_ID || "")
  .split(",").map(v => v.trim()).filter(Boolean);

export const config = {
  admin: {
    ids: adminIds
  },
  telegram: {
    token: required("TELEGRAM_BOT_TOKEN"),
    // No longer required — channels are added entirely through the bot's
    // ➕ Add Channel flow. This stays only as a legacy fallback for anyone
    // who still wants one fixed channel configured outside the bot.
    channelId: process.env.TELEGRAM_CHANNEL_ID?.trim() || ""
  },
  pinterest: {
    provider: (process.env.PINTEREST_PROVIDER || "rebix").toLowerCase(),
    accessToken: process.env.PINTEREST_ACCESS_TOKEN?.trim() || "",
    countryCode: process.env.PINTEREST_COUNTRY_CODE || "NG",
    locale: process.env.PINTEREST_LOCALE || "en-US",
    baseUrl: "https://api.pinterest.com/v5",
    endpoint: process.env.PINTEREST_ENDPOINT || "https://api-rebix.zone.id/api/pinterest"
  },
  schedule: {
    intervalSeconds: Math.max(60, intEnv("POST_INTERVAL", 3600)),
    runOnStart: boolEnv("RUN_ON_START", false)
  },
  content: {
    imagesPerPost: Math.min(Math.max(intEnv("IMAGES_PER_POST", 1), 1), 10),
    searchResultsPerQuery: Math.min(Math.max(intEnv("SEARCH_RESULTS_PER_QUERY", 20), 1), 50),
    minWidth: intEnv("MIN_IMAGE_WIDTH", 300),
    minHeight: intEnv("MIN_IMAGE_HEIGHT", 300),
    maxDownloadBytes: intEnv("MAX_DOWNLOAD_BYTES", 15_000_000),
    maxTelegramBytes: intEnv("MAX_TELEGRAM_IMAGE_BYTES", 9_500_000),
    // Telegram bot uploads cap out at 50MB — stay a little under that.
    maxVideoBytes: intEnv("MAX_DOWNLOAD_VIDEO_BYTES", 45_000_000),
    videoResultsPerQuery: Math.min(Math.max(intEnv("VIDEO_RESULTS_PER_QUERY", 6), 1), 10),
    maxRetries: Math.min(Math.max(intEnv("MAX_RETRIES", 3), 1), 8),
    requireSourceLink: boolEnv("REQUIRE_SOURCE_LINK", true),
    skipSponsored: boolEnv("SKIP_SPONSORED", true),
    licensedDomains: (process.env.LICENSED_SOURCE_DOMAINS || "")
      .split(",").map(v => v.trim().toLowerCase()).filter(Boolean),
    classifierEnabled: boolEnv("ENABLE_CLASSIFIER", true)
  },
  storage: {
    databasePath: path.resolve(root, process.env.DATABASE_PATH || "./data/bot.db"),
    downloadDir: path.resolve(root, process.env.DOWNLOAD_DIR || "./downloads")
  },
  logLevel: process.env.LOG_LEVEL || "info"
};

// ── Force Join (hard-coded) ──────────────────────────────────────
// Per project policy this is intentionally NOT admin/database managed —
// there is no in-bot UI to add/remove/enable these. To change which
// channels are required, edit the values below and redeploy.
//
// chatId   — the channel's @username (preferred) or numeric chat id.
//             Used for the getChatMember membership check.
// inviteUrl — the link shown on the "🌸 Join …" button.
// name      — display name used in bot messages/buttons.
export const FORCE_JOIN_ENABLED = true;

export const FORCE_JOIN_CHANNELS = [
  // {
  //   chatId: "@ChannelOne",
  //   inviteUrl: "https://t.me/missariapapers",
  //   name: "Channel One"
  // },
  // {
  //   chatId: "@ChannelTwo",
  //   inviteUrl: "https://t.me/linkbydave",
  //   name: "Channel Two"
  // }
];
