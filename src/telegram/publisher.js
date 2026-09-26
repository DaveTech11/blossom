import { Telegraf } from "telegraf";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, FORCE_JOIN_ENABLED, FORCE_JOIN_CHANNELS } from "../config.js";
import { withRetry } from "../utils/retry.js";
import { logger } from "../utils/logger.js";
import {
  db,
  getState,
  hasImageHash,
  hasPinterestPin,
  recordPost,
  createScheduledPost,
  getNextScheduledPost,
  addChannel,
  listChannelsForUser,
  getChannelById,
  getChannelForUser,
  getDefaultChannel,
  setDefaultChannel,
  deleteChannel,
  getStats,
  listRecentPosts,
  listScheduledPosts,
  cancelScheduledPost,
  getUserSettings,
  updateUserSetting,
  getMaintenanceMode,
  setMaintenanceMode,
  recordUser,
  countUsers,
  listUsers,
  listAllUserIds,
  markUserBlocked
} from "../database/database.js";
import { QUERY_GROUPS, randomItem } from "../pinterest/queries.js";
import { searchPins } from "../pinterest/client.js";
import { sendRich, sendRichDraft, richPhoto, richHeader, richHeading, richText, richDivider, richTable } from "./rich.js";

export const bot = new Telegraf(config.telegram.token);

function isAdmin(userId) {
  return Boolean(userId && config.admin.ids.includes(String(userId)));
}

const pendingBroadcast = new Map(); // adminChatId -> { started }
const BROADCAST_TIMEOUT_MS = 10 * 60 * 1000;

// answerCbQuery throws a hard "400: query is too old and response timeout
// expired or query ID is invalid" once Telegram's short-lived callback token
// expires. Left unhandled, that throw aborts the rest of the action handler
// (e.g. the actual posting logic never runs). Every call site should go
// through this wrapper so a stale/duplicate tap never breaks the flow below.
async function safeAnswerCbQuery(ctx, ...args) {
  if (!ctx.callbackQuery) return null;
  try {
    return await ctx.answerCbQuery(...args);
  } catch (error) {
    const description = error?.response?.description || error?.description || error?.message || "";
    if (/too old|response timeout|query id is invalid/i.test(description)) {
      logger.debug({ description }, "Ignored stale callback query");
    } else {
      logger.warn({ description }, "answerCbQuery failed");
    }
    return null;
  }
  
}
/**
 * Best-effort cleanup for temporary downloads.
 * Never lets a missing/locked temp file break a Telegram callback.
 */
async function cleanupFiles(...paths) {
  const files = paths.flat(Infinity).filter(Boolean);
  await Promise.allSettled(files.map(async filePath => {
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        logger.debug(
          { filePath, code: error?.code, error: error?.message },
          "Temporary file cleanup skipped"
        );
      }
    }
  }));
}

/**
 * Backwards-compatible alias for older handlers/plugins that called cleanFile.
 */
export async function cleanFile(filePath) {
  return cleanupFiles(filePath);
}

// Membership checks hit Telegram's getChatMember once per force-join channel.
// Doing that sequentially, uncached, on *every* update (including every
// button tap) is what was starving callback queries of their ~few-second
// answer window under any real load, and is the direct cause of the
// "query is too old" errors. Cache per-user results briefly and run the
// per-channel checks in parallel instead of one-by-one.
const forceJoinCache = new Map(); // userId -> { ok, missing, expiresAt }
const FORCE_JOIN_CACHE_MS = 3 * 60 * 1000;

// Statuses that count as "joined" for a channel/group membership check.
// left/kicked/restricted are all treated as NOT joined.
const JOINED_STATUSES = new Set(["creator", "administrator", "member"]);

function forceJoinChannelLabel(channel) {
  return channel?.name || channel?.chatId || "that channel";
}

function forceJoinInviteUrl(channel) {
  if (channel?.inviteUrl) return channel.inviteUrl;
  const handle = String(channel?.chatId || "");
  return handle.startsWith("@") ? `https://t.me/${handle.slice(1)}` : null;
}

// Checks membership against every hard-coded FORCE_JOIN_CHANNELS entry, in
// parallel. A channel the bot cannot verify (bad id, bot lacks access, a
// Telegram API error) is logged server-side and — critically — treated as
// NOT joined rather than silently skipped or assumed passed, so a broken
// config never falsely lets someone through.
async function forceJoinStatus(ctx, { fresh = false } = {}) {
  if (!FORCE_JOIN_ENABLED || !FORCE_JOIN_CHANNELS.length) return { ok: true, missing: [] };

  const userId = ctx.from?.id;
  const cached = !fresh && userId != null ? forceJoinCache.get(userId) : null;
  if (cached && cached.expiresAt > Date.now()) return cached;

  const results = await Promise.all(
    FORCE_JOIN_CHANNELS.map(async channel => {
      try {
        const member = await bot.telegram.getChatMember(channel.chatId, userId);
        return JOINED_STATUSES.has(member.status) ? null : channel;
      } catch (error) {
        logger.error(
          { chatId: channel.chatId, userId, error: error?.message },
          "Force Join membership check failed (invalid channel id, bot not in channel, or missing permissions)"
        );
        return channel;
      }
    })
  );

  const missing = results.filter(Boolean);
  const status = { ok: missing.length === 0, missing, expiresAt: Date.now() + FORCE_JOIN_CACHE_MS };
  if (userId != null) forceJoinCache.set(userId, status);
  return status;
}

function forceJoinKeyboard(missing) {
  const rows = (missing.length ? missing : FORCE_JOIN_CHANNELS).map(channel => {
    const url = forceJoinInviteUrl(channel);
    return [url
      ? { text: `🌸 Join ${forceJoinChannelLabel(channel)}`, url }
      : { text: `🌸 ${forceJoinChannelLabel(channel)}`, callback_data: "force_join_noop" }];
  });
  rows.push([{ text: "✅ JOINED / CHECK", callback_data: "force_join_check" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function forceJoinPromptText() {
  const lines = FORCE_JOIN_CHANNELS.map(c => `🌸 ${forceJoinChannelLabel(c)}`);
  return (
    `🔒 *Join required*\n\n` +
    `Please join the required channel(s) below, then tap *✅ JOINED / CHECK*.\n\n` +
    `${lines.join("\n")}`
  );
}

function forceJoinMissingText(missing) {
  const lines = missing.map(c => `❌ ${forceJoinChannelLabel(c)}`);
  return (
    `🌸 You still need to join:\n\n` +
    `${lines.join("\n")}\n\n` +
    `Join all required channels, then press:\n✅ JOINED / CHECK`
  );
}

// Preserves whatever the user was doing when Force Join interrupted them
// (a Pinterest link, a button tap, a search) so it can be replayed once
// they pass the check — see the force_join_check handler below.
const pendingResumeAfterJoin = new Map(); // userId -> { update, savedAt }
const FORCE_JOIN_RESUME_TIMEOUT_MS = 15 * 60 * 1000;

function adminKeyboard() {
  const maintenance = getMaintenanceMode();
  return { reply_markup: { inline_keyboard: [
    [primary(`${maintenance ? "🟢 Disable" : "🔴 Enable"} Maintenance`, "admin_maintenance")],
    [primary("👥 Users", "admin_users")],
    [success("📢 Broadcast", "admin_broadcast")],
    [primary("📊 Admin Stats", "admin_stats")],
    [primary("🧹 Clean Temp Files", "admin_cleanup")]
  ] } };
}

async function requireAdmin(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    await safeAnswerCbQuery(ctx, "Admin only", { show_alert: true });
    return false;
  }
  return true;
}

// Force Join callback data that must always reach its own handler below,
// even while the user is currently blocked — otherwise "✅ JOINED / CHECK"
// would just be re-blocked by this same middleware and could never perform
// the fresh check that clears it.
const FORCE_JOIN_BYPASS_ACTIONS = new Set(["force_join_check", "force_join_noop"]);

// Global protection. Admins always bypass maintenance/force-join so they can recover the bot.
bot.use(async (ctx, next) => {
  // Track every user who interacts with the bot in DM, regardless of what
  // they do — this is the source of truth for admin_users / broadcast.
  if (ctx.chat?.type === "private" && ctx.from) {
    recordUser({
      id: ctx.from.id,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name
    });
  }

  // Acknowledge callback queries before any network/database work.
  // This prevents Telegram's short callback window from expiring while
  // force-join or maintenance checks are running.
  if (ctx.callbackQuery) await safeAnswerCbQuery(ctx);

  if (!ctx.from || isAdmin(ctx.from.id)) return next();
  if (getMaintenanceMode()) {
    return ctx.reply("🛠️ *Maintenance mode is ON.*\n\nBloom ⟡ Petal is temporarily unavailable. Please try again later.", { parse_mode: "Markdown" });
  }

  if (FORCE_JOIN_BYPASS_ACTIONS.has(ctx.callbackQuery?.data)) return next();

  if (FORCE_JOIN_ENABLED && FORCE_JOIN_CHANNELS.length && ctx.chat?.type === "private") {
    const status = await forceJoinStatus(ctx);
    if (!status.ok) {
      // Remember what triggered this so it can resume automatically once
      // the user passes the check — a Pinterest link, a button tap, etc.
      if (ctx.from?.id != null && ctx.update) {
        pendingResumeAfterJoin.set(ctx.from.id, { update: ctx.update, savedAt: Date.now() });
      }
      return ctx.reply(forceJoinPromptText(), { parse_mode: "Markdown", ...forceJoinKeyboard(status.missing) });
    }
  }
  return next();
});

// ── Broadcast ───────────────────────────────────────────────────
// Registered early so it can intercept ANY message type (text, photo,
// video, document, ...) from an admin who just tapped 📢 Broadcast —
// bot.on("text") further down only ever sees text messages, which isn't
// enough here since a broadcast can be any kind of message. Everything
// that isn't a pending broadcast just falls through via next().
bot.on("message", async (ctx, next) => {
  if (ctx.chat?.type !== "private" || !isAdmin(ctx.from?.id)) return next();

  const pending = pendingBroadcast.get(ctx.chat.id);
  if (!pending) return next();

  pendingBroadcast.delete(ctx.chat.id);

  if (Date.now() - pending.started > BROADCAST_TIMEOUT_MS) {
    await ctx.reply("⌛ Broadcast request expired. Use /admin again.");
    return;
  }
  if (ctx.message.text === "/cancel") {
    await ctx.reply("❌ Broadcast cancelled.", adminKeyboard());
    return;
  }

  await runBroadcast(ctx);
});

async function runBroadcast(ctx) {
  const userIds = listAllUserIds().filter(id => id !== String(ctx.from.id));
  if (!userIds.length) {
    await ctx.reply("📭 No users to broadcast to yet.", adminKeyboard());
    return;
  }

  const status = await ctx.reply(`📢 Broadcasting to ${userIds.length} user(s)…`);
  let sent = 0;
  let failed = 0;
  let blocked = 0;

  for (const userId of userIds) {
    try {
      await ctx.telegram.copyMessage(userId, ctx.chat.id, ctx.message.message_id);
      sent++;
    } catch (error) {
      failed++;
      const description = error?.response?.description || error?.message || "";
      if (/blocked|deactivated|not found|kicked|chat not found/i.test(description)) {
        blocked++;
        markUserBlocked(userId);
      }
      logger.debug({ userId, error: description }, "Broadcast send failed");
    }
    // Stay comfortably under Telegram's ~30 messages/sec global rate limit.
    await new Promise(resolve => setTimeout(resolve, 40));
  }

  await ctx.telegram.editMessageText(
    ctx.chat.id,
    status.message_id,
    undefined,
    `📢 *Broadcast complete*\n\n✅ Delivered: ${sent}\n❌ Failed: ${failed}${blocked ? ` (${blocked} had blocked/removed the bot)` : ""}`,
    { parse_mode: "Markdown" }
  ).catch(() => {});
}


// Change this one constant to rebrand the whole bot.
const BRAND = "𓂃⊹ ˚₊‧ 𝐁𝐋𝐎𝐎𝐌 ⟡ 𝐏𝐄𝐓𝐀𝐋";
const BRAND_SHORT = "Bloom ⟡ Petal";

// Bot user info (id/username), fetched once on launch so channel-admin
// verification and deep links work without an extra API call each time.
let botInfo = null;
export async function primeBotInfo() {
  if (botInfo) return botInfo;
  botInfo = await bot.telegram.getMe();
  return botInfo;
}

// Any Telegram user may open the menu and manage their own channels —
// this is now a multi-user bot, not a single-owner one.

// ── Telegram upload helpers ─────────────────────────────────────
const TELEGRAM_TIMEOUT_MS = Number(process.env.TELEGRAM_TIMEOUT_MS || 60000);

function telegramApiUrl(method) {
  return `https://api.telegram.org/bot${config.telegram.token}/${method}`;
}

async function telegramRequest(method, form) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

  try {
    const response = await fetch(telegramApiUrl(method), {
      method: "POST",
      body: form,
      signal: controller.signal
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { ok: false, description: text }; }

    if (!response.ok || !data.ok) {
      const error = new Error(data.description || `Telegram API HTTP ${response.status}`);
      error.response = { statusCode: response.status, error_code: data.error_code };
      throw error;
    }

    return data.result;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(`Telegram ${method} timed out after ${TELEGRAM_TIMEOUT_MS}ms`);
      timeoutError.code = "ETIMEDOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fileBlob(filePath, mimeType = "image/jpeg") {
  if (!filePath) throw new Error("Missing temporary file path");
  const buffer = await fs.promises.readFile(filePath);
  return new Blob([buffer], { type: mimeType });
}

function normalizeCaption(caption) {
  const value = String(caption || "").trim();
  if (!value) return "";
  // Telegram photo captions are limited to 1024 characters.
  return value.length > 1024 ? value.slice(0, 1024) : value;
}

async function sendSingle(item, chatId) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", await fileBlob(item.filePath), "image.jpg");

  const caption = normalizeCaption(item.caption);
  if (caption) form.append("caption", caption);

  form.append("disable_notification", "true");
  return telegramRequest("sendPhoto", form);
}

async function sendVideoSingle(item, chatId) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("video", await fileBlob(item.filePath, "video/mp4"), "video.mp4");

  const caption = normalizeCaption(item.caption);
  if (caption) form.append("caption", caption);

  form.append("supports_streaming", "true");
  form.append("disable_notification", "true");
  return telegramRequest("sendVideo", form);
}

async function sendAlbum(items, chatId) {
  const validItems = (items || []).filter(item => item?.filePath);
  if (!validItems.length) throw new Error("Album contains no valid images");
  if (validItems.length > 10) {
    throw new Error("Telegram albums support a maximum of 10 images per media group");
  }

  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("disable_notification", "true");

  const media = validItems.map((item, index) => {
    const entry = {
      type: "photo",
      media: `attach://photo${index}`
    };
    const caption = normalizeCaption(item.caption);
    if (caption) entry.caption = caption;
    return entry;
  });

  form.append("media", JSON.stringify(media));

  for (let i = 0; i < validItems.length; i++) {
    form.append(
      `photo${i}`,
      await fileBlob(validItems[i].filePath, "image/jpeg"),
      `image-${i}.jpg`
    );
  }

  return telegramRequest("sendMediaGroup", form);
}

async function publishAlbumWithFallback(items, chatId) {
  try {
    return await sendAlbum(items, chatId);
  } catch (error) {
    const telegramCode = error?.response?.error_code;
    const description = String(error?.message || "");

    // A 400 can be caused by one bad image/file. Retry the batch as normal
    // posts so one broken Pinterest asset cannot kill the whole search.
    if (telegramCode === 400 || /bad request|wrong file|file is too big|invalid/i.test(description)) {
      logger.warn(
        { error: description, count: items.length },
        "Album rejected; falling back to individual photo posts"
      );

      const results = [];
      for (const item of items) {
        try {
          results.push(await sendSingle(item, chatId));
        } catch (itemError) {
          logger.warn(
            { error: itemError?.message, filePath: item.filePath },
            "Fallback individual photo failed"
          );
        }
      }

      if (results.length) return results;
    }

    throw error;
  }
}

/**
 * Publish one or more prepared image items to Telegram.
 *
 * The worker relies on this named export. Telegram media groups accept at
 * most 10 photos, so larger collections are split into safe chunks. Each
 * chunk uses an album when possible and falls back to individual photos when
 * Telegram rejects the media group. The function always resolves to a flat
 * array of Telegram message results so callers can safely record message IDs.
 */
export async function publish(items, targetChatId) {
  const chatId = targetChatId || config.telegram.channelId;
  if (!chatId) {
    throw new Error("No target channel — connect one via ➕ Add Channel first");
  }

  const validItems = (Array.isArray(items) ? items : [items]).filter(
    item => item?.filePath
  );

  if (!validItems.length) {
    throw new Error("Nothing to publish: no valid image files were supplied");
  }

  const results = [];
  const BATCH_SIZE = 10;

  for (let start = 0; start < validItems.length; start += BATCH_SIZE) {
    const batch = validItems.slice(start, start + BATCH_SIZE);

    const batchResults = await withRetry(
      async () => {
        if (batch.length === 1) {
          return [await sendSingle(batch[0], chatId)];
        }

        return await publishAlbumWithFallback(batch, chatId);
      },
      {
        retries: config.content.maxRetries,
        shouldRetry: error => {
          const status = error?.response?.error_code;
          return (
            !status ||
            status === 429 ||
            status >= 500 ||
            [
              "ETIMEDOUT",
              "ECONNRESET",
              "ECONNREFUSED",
              "EPIPE"
            ].includes(error?.code)
          );
        },
        onRetry: async (error, attempt, delay) => {
          logger.warn(
            { attempt, delay, error: error?.message },
            "Telegram image publish retrying"
          );
        }
      }
    );

    if (Array.isArray(batchResults)) {
      results.push(...batchResults);
    } else if (batchResults) {
      results.push(batchResults);
    }

    // Give Telegram a small breather between media groups.
    if (start + BATCH_SIZE < validItems.length) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  return results;
}

// Video Search only ever posts one video at a time (by design — the user
// picks exactly one result from the list), so this is intentionally not a
// batch API like publish() above.
export async function publishVideo(item, targetChatId) {
  const chatId = targetChatId || config.telegram.channelId;
  if (!chatId) throw new Error("No target channel — connect one via ➕ Add Channel first");

  return withRetry(
    async () => sendVideoSingle(item, chatId),
    {
      retries: config.content.maxRetries,
      shouldRetry: error => {
        const status = error?.response?.error_code;
        return !status || status === 429 || status >= 500 || ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE"].includes(error?.code);
      },
      onRetry: async (error, attempt, delay) => {
        logger.warn({ attempt, delay, error: error?.message }, "Telegram video upload retrying");
      }
    }
  );
}

// Publish prepared search results one-by-one, or as an album.
export async function publishNormal(items, targetChatId) {
  let results = [];
  for (const item of items) {
    results.push(await publish([item], targetChatId));
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return results.flat();
}

function applyBatchCaption(items, caption, { album = false } = {}) {
  const value = String(caption || "").trim();
  if (!value) return items;
  return items.map(item => ({
    ...item,
    caption: value
  }));
}

// ── Buttons / image menu ───────────────────────────────────────
const MENU_IMAGE_PATH = path.resolve(fileURLToPath(new URL("../assets/menu-card.jpg", import.meta.url)));

// A Telegram file_id for the menu image, captured the first time we
// successfully upload the local asset (see cacheMenuImageFileId below).
// InputMediaPhoto.media accepts a file_id directly — Telegram serves it
// from its own storage with no outbound fetch at all, so once this is
// warm, rich cards no longer depend on any third-party image host being
// reachable. Falls back to RICH_MENU_IMAGE_URL / a hardcoded URL only
// until the cache is populated (i.e. before the bot's first send).
let cachedMenuImageFileId = null;

function menuImageSource() {
  return cachedMenuImageFileId
    || process.env.RICH_MENU_IMAGE_URL
    || "https://files.catbox.moe/599dfp.jpg";
}

function cacheMenuImageFileId(message) {
  const sizes = message?.photo;
  if (Array.isArray(sizes) && sizes.length) {
    // Telegram returns photo sizes smallest-first; the last one is largest.
    cachedMenuImageFileId = sizes[sizes.length - 1].file_id;
  }
}

async function editMenuCard(ctx, text, keyboard) {
  // Rich messages are immutable in some Telegram clients. Sending a fresh
  // rich card keeps every callback deterministic instead of guessing whether
  // the previous message was a photo, text, or rich message.
  return sendMenuCard(ctx, text, keyboard);
}

async function sendMenuCard(ctx, text, keyboard) {
  const blocks = [
    richPhoto(menuImageSource()),
    richHeader(BRAND_SHORT, 3),
    richDivider(),
    richText(String(text).replace(/^🌸\s*/u, "").replaceAll("*", ""))
  ];

  return sendRich(ctx, { blocks, reply_markup: keyboard?.reply_markup }, async () => {
    const options = { parse_mode: "Markdown", ...keyboard };
    const sent = await ctx.replyWithPhoto({ source: MENU_IMAGE_PATH }, { caption: text, ...options });
    cacheMenuImageFileId(sent);
    return sent;
  });
}

const primary = (text, callback_data) => ({ text, callback_data });
const success = (text, callback_data) => ({ text, callback_data });
const danger = (text, callback_data) => ({ text, callback_data });

// ── Paginated keyboards ───────────────────────────────────────────
// Long single-column lists (channels, schedules, force-join entries)
// are laid out two-per-row and paged, instead of one giant vertical
// stack. `prefix` is the callback_data prefix used for the Prev/Next
// buttons, e.g. "admin_force_channels" -> "admin_force_channels:2".
const PAGE_SIZE = 10;

function paginatedRows(items, page, buttonFn, prefix) {
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const clampedPage = Math.min(Math.max(1, page || 1), totalPages);
  const start = (clampedPage - 1) * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);

  const rows = [];
  for (let i = 0; i < pageItems.length; i += 2) {
    rows.push(pageItems.slice(i, i + 2).map(buttonFn));
  }

  if (totalPages > 1) {
    const nav = [];
    if (clampedPage > 1) nav.push({ text: "⬅️ Prev", callback_data: `${prefix}:${clampedPage - 1}` });
    nav.push({ text: `📄 ${clampedPage}/${totalPages}`, callback_data: "noop" });
    if (clampedPage < totalPages) nav.push({ text: "Next ➡️", callback_data: `${prefix}:${clampedPage + 1}` });
    rows.push(nav);
  }

  return { rows, page: clampedPage, totalPages, pageItems };
}

bot.action("noop", async ctx => safeAnswerCbQuery(ctx));

// The /start screen: three clean choices. Everything else lives under ✨ More.
const MAIN_MENU = {
  reply_markup: {
    inline_keyboard: [
      [success("➕ Add Channel", "add_channel_start")],
      [primary("📡 My Channels", "my_channels")],
      [primary("✨ More", "open_more_menu")]
    ]
  }
};

// The full toolbox — search, scheduling, stats — one tap away via ✨ More.
const MORE_MENU = {
  reply_markup: {
    inline_keyboard: [
      [primary("📅 Schedule", "info_schedule")],
      [primary("📋 My Schedules", "my_schedules")],
      [primary("📊 Stats", "info_stats")],
      [primary("⚙️ Settings", "settings")],
      [primary("📸 Next Post", "info_next")],
      [primary("🔬 Research", "research")],
      [success("🔎 Search & Post Now", "search_postnow")],
      [success("📦 Bulk Search & Post", "bulk_search_post")],
      [success("🎥 Video Search", "video_search")],
      [success("🚀 Post Now", "trigger_postnow")],
      [primary("⏸️ Stop Current Task", "stop_task"), primary("▶️ Continue", "continue_task")],
      [danger("🛑 Cancel Task", "cancel_task")],
      [primary("⬅️ Back", "back_to_main")]
    ]
  }
};

bot.action("open_more_menu", async ctx => {
  await safeAnswerCbQuery(ctx);
  await editMenuCard(ctx, `✨ *${BRAND_SHORT} — More*\n\nEverything else lives here 👇`, MORE_MENU);
});

bot.action("back_to_main", async ctx => {
  await safeAnswerCbQuery(ctx);
  await editMenuCard(ctx, `🌸 *${BRAND}*\n\nWhat would you like to do?`, MAIN_MENU);
});

// ── Channel management ──────────────────────────────────────────
// Each user registers their own channel(s). Flow: send @username →
// bot asks them to add it as admin → tap Verify → bot checks admin
// status via getChatMember and saves it against their Telegram user id.

const pendingAddChannel = new Map(); // chatId -> { step, username, started }
const ADD_CHANNEL_TIMEOUT_MS = 10 * 60 * 1000;

function channelLabel(channel) {
  return channel.title || channel.username || `#${channel.chat_id}`;
}

function myChannelsText(channels) {
  if (!channels.length) {
    return "📡 *My Channels*\n\nYou haven't added a channel yet.\n\nTap ➕ Add Channel to connect one.";
  }
  const lines = channels.map(c =>
    `${c.is_default ? "⭐" : "▫️"} *${channelLabel(c)}*${c.username ? ` (${c.username})` : ""}${c.is_default ? "  _(active)_" : ""}`
  );
  return `📡 *My Channels*\n\n${lines.join("\n")}\n\n⭐ = the channel posts go to by default.\nTap a channel below to manage it.`;
}

function myChannelsKeyboard(channels, page = 1) {
  const { rows } = paginatedRows(
    channels,
    page,
    c => primary(`${c.is_default ? "⭐ " : ""}${channelLabel(c)}`, `channel_manage:${c.id}`),
    "my_channels"
  );
  rows.push([success("➕ Add Channel", "add_channel_start")]);
  rows.push([primary("⬅️ Back", "back_to_main")]);
  return { reply_markup: { inline_keyboard: rows } };
}

function manageChannelKeyboard(channel) {
  const rows = [];
  if (!channel.is_default) {
    rows.push([success("⭐ Set as active", `channel_set_default:${channel.id}`)]);
  }
  rows.push([danger("🗑️ Remove channel", `channel_remove:${channel.id}`)]);
  rows.push([primary("⬅️ Back to My Channels", "my_channels")]);
  return { reply_markup: { inline_keyboard: rows } };
}

async function sendMyChannels(ctx, page = 1) {
  const channels = listChannelsForUser(ctx.from.id);
  const text = myChannelsText(channels);
  const kb = myChannelsKeyboard(channels, page);
  await editMenuCard(ctx, text, kb);
}

bot.action(/^my_channels(?::(\d+))?$/, async ctx => {
  await safeAnswerCbQuery(ctx);
  await sendMyChannels(ctx, Number(ctx.match[1]) || 1);
});

bot.command("channels", async ctx => {
  if (ctx.chat?.type !== "private") return;
  const channels = listChannelsForUser(ctx.from.id);
  await ctx.reply(myChannelsText(channels), { parse_mode: "Markdown", ...myChannelsKeyboard(channels) });
});

bot.action(/^channel_manage:(\d+)$/, async ctx => {
  const id = Number(ctx.match[1]);
  const channel = getChannelForUser(ctx.from.id, id);
  await safeAnswerCbQuery(ctx);
  if (!channel) {
    await ctx.reply("⚠️ That channel is no longer on your list.");
    return sendMyChannels(ctx);
  }
  const text =
    `📡 *${channelLabel(channel)}*\n\n` +
    `${channel.username ? `Username: ${channel.username}\n` : ""}` +
    `Chat ID: \`${channel.chat_id}\`\n` +
    `Status: ${channel.is_default ? "⭐ Active (posts go here)" : "▫️ Saved"}`;
  await editMenuCard(ctx, text, manageChannelKeyboard(channel));
});

bot.action(/^channel_set_default:(\d+)$/, async ctx => {
  const id = Number(ctx.match[1]);
  const channel = getChannelForUser(ctx.from.id, id);
  if (!channel) {
    await safeAnswerCbQuery(ctx, "Channel not found", { show_alert: true });
    return sendMyChannels(ctx);
  }
  setDefaultChannel(ctx.from.id, id);
  await safeAnswerCbQuery(ctx, "⭐ Set as your active channel");
  await sendMyChannels(ctx);
});

bot.action(/^channel_remove:(\d+)$/, async ctx => {
  const id = Number(ctx.match[1]);
  const channel = getChannelForUser(ctx.from.id, id);
  await safeAnswerCbQuery(ctx);
  if (!channel) return sendMyChannels(ctx);
  const text = `🗑️ Remove *${channelLabel(channel)}* from your channel list?\n\nThis only removes it here — the bot stays admin in the channel until you remove it yourself.`;
  const kb = {
    reply_markup: {
      inline_keyboard: [
        [danger("✅ Yes, remove it", `channel_remove_confirm:${id}`), primary("❌ Cancel", `channel_manage:${id}`)]
      ]
    }
  };
  await editMenuCard(ctx, text, kb);
});

bot.action(/^channel_remove_confirm:(\d+)$/, async ctx => {
  const id = Number(ctx.match[1]);
  deleteChannel(ctx.from.id, id);
  await safeAnswerCbQuery(ctx, "Removed");
  await sendMyChannels(ctx);
});

async function askForChannelUsername(ctx) {
  const chatId = ctx.chat?.id;
  if (!chatId || ctx.chat?.type !== "private") return;
  pendingAddChannel.set(chatId, { step: "username", started: Date.now() });
  const text =
    "➕ *Add a Channel*\n\n" +
    "Send me your channel's *username* (like `@myaesthetic`) or forward any message from it.\n\n" +
    "_Tip: the channel must be public, or you can send its numeric ID if it's private._";
  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: { force_reply: true, selective: true } });
}

bot.action("add_channel_start", async ctx => {
  await safeAnswerCbQuery(ctx);
  await askForChannelUsername(ctx);
});

bot.command("addchannel", async ctx => {
  if (ctx.chat?.type !== "private") return;
  await askForChannelUsername(ctx);
});

function normalizeChannelHandle(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  if (/^-?\d+$/.test(value)) return value; // numeric chat id
  const withAt = value.startsWith("@") ? value : `@${value.replace(/^https?:\/\/t\.me\//i, "")}`;
  return withAt.replace(/\s+/g, "");
}

async function askToVerifyAdmin(ctx, handle) {
  const chatId = ctx.chat.id;
  pendingAddChannel.set(chatId, { step: "verify", username: handle, started: Date.now() });

  const me = await primeBotInfo().catch(() => null);
  const botHandle = me?.username ? `@${me.username}` : "this bot";

  const text =
    `📡 Got it — *${handle}*\n\n` +
    `Now add ${botHandle} as an *admin* in that channel:\n\n` +
    `1️⃣ Open the channel → *Administrators*\n` +
    `2️⃣ Tap *Add Admin* → search ${botHandle}\n` +
    `3️⃣ Make sure *Post Messages* permission is ON\n\n` +
    `Once done, tap ✅ Verify Admin below.`;

  const kb = {
    reply_markup: {
      inline_keyboard: [
        [success("✅ Verify Admin", "verify_channel"), danger("❌ Cancel", "cancel_add_channel")]
      ]
    }
  };

  await ctx.reply(text, { parse_mode: "Markdown", ...kb });
}

bot.action("verify_channel", async ctx => {
  const chatId = ctx.chat?.id;
  const pending = pendingAddChannel.get(chatId);
  if (!pending || pending.step !== "verify") {
    await safeAnswerCbQuery(ctx, "Start with ➕ Add Channel first", { show_alert: true });
    return;
  }

  if (Date.now() - pending.started > ADD_CHANNEL_TIMEOUT_MS) {
    pendingAddChannel.delete(chatId);
    await safeAnswerCbQuery(ctx, "Expired", { show_alert: true });
    await ctx.reply("⌛ That request expired. Tap ➕ Add Channel and try again.");
    return;
  }

  await safeAnswerCbQuery(ctx, "Checking admin status…");

  try {
    const me = await primeBotInfo();
    const chat = await ctx.telegram.getChat(pending.username);
    const member = await ctx.telegram.getChatMember(chat.id, me.id);

    const isAdmin = member.status === "administrator" || member.status === "creator";
    const canPost = member.status === "creator" || member.can_post_messages !== false;

    if (!isAdmin || !canPost) {
      await ctx.reply(
        `❌ I'm not an admin with post permission in *${pending.username}* yet.\n\nAdd me as admin with *Post Messages* enabled, then tap ✅ Verify Admin again.`,
        {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[success("✅ Verify Admin", "verify_channel"), danger("❌ Cancel", "cancel_add_channel")]] }
        }
      );
      return;
    }

    pendingAddChannel.delete(chatId);
    const channelId = addChannel({
      userId: ctx.from.id,
      chatId: chat.id,
      username: chat.username ? `@${chat.username}` : null,
      title: chat.title || null
    });
    const channel = getChannelById(channelId);

    await ctx.reply(
      `🎉 *${channelLabel(channel)}* is connected!\n\n` +
      `${channel.is_default ? "⭐ It's set as your active channel — this is where your posts will go." : "It's saved to your channel list."}\n\n` +
      `Use 🔎 Search & Post Now (under ✨ More) whenever you're ready to post.`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    );
  } catch (error) {
    logger.warn({ error: error?.message, username: pending.username }, "Channel admin verification failed");
    await ctx.reply(
      `❌ Couldn't verify that channel: ${error?.description || error?.message || "unknown error"}\n\n` +
      `Double-check the username and that I've been added as admin, then tap ✅ Verify Admin again.`,
      { reply_markup: { inline_keyboard: [[success("✅ Verify Admin", "verify_channel"), danger("❌ Cancel", "cancel_add_channel")]] } }
    );
  }
});

bot.action("cancel_add_channel", async ctx => {
  pendingAddChannel.delete(ctx.chat?.id);
  await safeAnswerCbQuery(ctx, "Cancelled");
  await ctx.reply("❌ Cancelled adding a channel.", MAIN_MENU);
});

// ── Channel picker for posting flows ─────────────────────────────
// Search/Bulk/Post Now all need to know *which* channel to post to.
// With one channel it's automatic; with several, the user is asked.

function channelPickerKeyboard(channels, flow, page = 1) {
  const { rows } = paginatedRows(
    channels,
    page,
    c => success(`${c.is_default ? "⭐ " : ""}${channelLabel(c)}`, `pick_channel:${flow}:${c.id}`),
    `pick_channel_page:${flow}`
  );
  rows.push([primary("❌ Cancel", "back_to_main")]);
  return { reply_markup: { inline_keyboard: rows } };
}

bot.action(/^pick_channel_page:([a-z_]+):(\d+)$/, async ctx => {
  await safeAnswerCbQuery(ctx);
  const [, flow, page] = ctx.match;
  const channels = listChannelsForUser(ctx.from.id);
  await ctx.reply("📡 Which of your channels should this go to?", channelPickerKeyboard(channels, flow, Number(page)));
});

const FLOW_STARTERS = {
  search_postnow: ctx => askForSearch(ctx, takeTargetChannel(ctx.chat.id)),
  bulk_search_post: ctx => askForBulkSearch(ctx, takeTargetChannel(ctx.chat.id)),
  video_search: ctx => askForVideoSearch(ctx, takeTargetChannel(ctx.chat.id)),
  trigger_postnow: ctx => runTriggerPostNow(ctx, takeTargetChannel(ctx.chat.id))
};

// Returns a channel object once one is resolved, or null if the caller
// should stop (because a picker was shown, or there's nothing to post to).
async function resolveTargetChannel(ctx, flow) {
  const channels = listChannelsForUser(ctx.from.id);

  if (!channels.length) {
    await ctx.reply(
      "📡 You don't have a channel connected yet.\n\nTap ➕ Add Channel first so I know where to post.",
      MAIN_MENU
    );
    return null;
  }

  if (channels.length === 1) return channels[0];

  const defaultChannel = channels.find(c => c.is_default);
  if (defaultChannel) return defaultChannel;

  await ctx.reply("📡 Which of your channels should this go to?", channelPickerKeyboard(channels, flow));
  return null;
}

bot.action(/^pick_channel:([a-z_]+):(\d+)$/, async ctx => {
  const [, flow, idRaw] = ctx.match;
  const channel = getChannelForUser(ctx.from.id, Number(idRaw));
  if (!channel) {
    await safeAnswerCbQuery(ctx, "Channel not found", { show_alert: true });
    return;
  }
  await safeAnswerCbQuery(ctx, `Posting to ${channelLabel(channel)}`);
  flowChannelChoice.set(ctx.chat.id, channel);
  const starter = FLOW_STARTERS[flow];
  if (starter) await starter(ctx);
});

// Remembers the channel the user just picked so the next step of a flow
// (asking for the search query, etc.) knows where the post is headed.
const flowChannelChoice = new Map(); // chatId -> channel row

function takeTargetChannel(chatId) {
  const channel = flowChannelChoice.get(chatId);
  flowChannelChoice.delete(chatId);
  return channel || null;
}

// ── Persistent Next Post scheduling ────────────────────────────
const pendingSchedules = new Map();
const pendingResearches = new Map();
const SCHEDULE_TIMEOUT_MS = 15 * 60 * 1000;

function nextPostCategoryKeyboard() {
  const rows = Object.keys(QUERY_GROUPS).map(category => [
    success(`📂 ${category}`, `next_category:${category}`)
  ]);
  rows.push([primary("✍️ Send Custom", "next_custom")]);
  return { reply_markup: { inline_keyboard: rows } };
}

const NEXT_AMOUNT_MENU = {
  reply_markup: {
    inline_keyboard: [
      [success("1 image", "next_amount:1"), success("5 images", "next_amount:5")],
      [success("10 images", "next_amount:10"), success("25 images", "next_amount:25")],
      [success("50 images", "next_amount:50"), success("100 images", "next_amount:100")],
      [primary("✍️ Custom amount", "next_amount_custom")]
    ]
  }
};

function scheduleTimeToIso(text) {
  const value = String(text || "").trim().replace(/T/, " ");
  const match = value.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (hour > 23 || minute > 59) return null;
  const iso = new Date(`${match[1]}T${String(hour).padStart(2, "0")}:${match[3]}:00+01:00`);
  if (Number.isNaN(iso.getTime())) return null;
  return iso;
}

async function askForScheduleTime(ctx) {
  await ctx.reply(
    "🕐 Send the exact time for this next post in Lagos time (WAT).\n\nFormat: YYYY-MM-DD HH:MM\nExample: 2026-09-12 14:30\n\nThis schedule is saved in the database, so it can still run after the bot reconnects."
  );
}

async function savePendingSchedule(ctx, pending) {
  if (Date.now() - pending.started > SCHEDULE_TIMEOUT_MS) {
    pendingSchedules.delete(ctx.chat.id);
    await ctx.reply("⌛ That scheduling request expired. Press 📸 Next Post and try again.");
    return;
  }

  if (!pending.amount) {
    pending.step = "amount";
    await ctx.reply(`📂 Category: ${pending.category}\n🔎 Search: ${pending.query}\n\n🖼️ How many images should this next post send?`, NEXT_AMOUNT_MENU);
    return;
  }

  if (!pending.runAt) {
    pending.step = "time";
    await askForScheduleTime(ctx);
    return;
  }

  const targetChannel = getDefaultChannel(ctx.from?.id);
  if (!targetChannel) {
    pendingSchedules.delete(ctx.chat.id);
    await ctx.reply(
      "📡 You don't have a channel connected yet.\n\nTap ➕ Add Channel first, then schedule your next post.",
      MAIN_MENU
    );
    return;
  }

  const id = createScheduledPost({
    userId: ctx.from?.id || ctx.chat.id,
    category: pending.category,
    query: pending.query,
    amount: pending.amount,
    runAt: pending.runAt.toISOString(),
    targetChatId: targetChannel.chat_id
  });
  pendingSchedules.delete(ctx.chat.id);

  await ctx.reply(
    `✅ Next post scheduled!\n\n📂 Category: ${pending.category}\n🔎 Search: ${pending.query}\n🖼️ Amount: ${pending.amount}\n🕐 Time: ${pending.runAt.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" })} WAT\n📡 Channel: ${channelLabel(targetChannel)}\n🆔 Schedule #${id}\n\nThe bot will post it automatically even if you are offline.`,
    MAIN_MENU
  );
}

bot.action("next_category:wallpapers", async ctx => handleNextCategory(ctx, "wallpapers"));
bot.action("next_category:pfp", async ctx => handleNextCategory(ctx, "pfp"));
bot.action("next_category:lovers", async ctx => handleNextCategory(ctx, "lovers"));
bot.action("next_category:movies", async ctx => handleNextCategory(ctx, "movies"));
bot.action("next_category:moods", async ctx => handleNextCategory(ctx, "moods"));

async function handleNextCategory(ctx, category) {
  const chatId = ctx.chat?.id;
  if (!chatId || ctx.chat?.type !== "private") return;
  const query = randomItem(QUERY_GROUPS[category] || []);
  pendingSchedules.set(chatId, { step: "amount", category, query, started: Date.now() });
  await safeAnswerCbQuery(ctx, `${category} selected`);
  await ctx.reply(`📸 Next Post\n\n📂 Category: ${category}\n🔎 Search: ${query}\n\nChoose the exact amount:`, NEXT_AMOUNT_MENU);
}

bot.action("next_custom", async ctx => {
  const chatId = ctx.chat?.id;
  if (!chatId || ctx.chat?.type !== "private") return;
  pendingSchedules.set(chatId, { step: "query", category: "custom", started: Date.now() });
  await safeAnswerCbQuery(ctx, "Send your custom search");
  await ctx.reply("✍️ Send exactly what you want the next post to search on Pinterest.\n\nExample: dark girl aesthetic pfp");
});

for (const amount of [1, 5, 10, 25, 50, 100]) {
  bot.action(`next_amount:${amount}`, async ctx => {
    const chatId = ctx.chat?.id;
    const pending = pendingSchedules.get(chatId);
    if (!pending) return safeAnswerCbQuery(ctx, "Start Next Post first", { show_alert: true });
    pending.amount = amount;
    pending.step = "time";
    await safeAnswerCbQuery(ctx, `${amount} images selected`);
    await askForScheduleTime(ctx);
  });
}

bot.action("next_amount_custom", async ctx => {
  const chatId = ctx.chat?.id;
  const pending = pendingSchedules.get(chatId);
  if (!pending) return safeAnswerCbQuery(ctx, "Start Next Post first", { show_alert: true });
  pending.step = "amount_custom";
  await safeAnswerCbQuery(ctx, "Send the amount");
  await ctx.reply("🖼️ Send the exact number of images to post.\n\nMaximum: 100");
});

bot.action("info_next", async ctx => {
  const next = getNextScheduledPost();
  if (!next) {
    await editMenuCard(ctx, "📸 Next Post\n\nNo custom next post is scheduled yet.\n\nChoose a category or send your own search, then set the amount and exact time.", nextPostCategoryKeyboard());
    return;
  }
  const when = new Date(next.run_at).toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });
  await editMenuCard(ctx, `📸 Next Post\n\n📂 Category: ${next.category}\n🔎 Search: ${next.query}\n🖼️ Amount: ${next.amount}\n🕐 Time: ${when} WAT\n\nThis schedule is stored persistently and will run after a restart/offline period.`, nextPostCategoryKeyboard());
});

// ── Research ───────────────────────────────────────────────────
bot.action("research", async ctx => {
  const chatId = ctx.chat?.id;
  if (!chatId || ctx.chat?.type !== "private") return;
  pendingResearches.set(chatId, Date.now());
  await safeAnswerCbQuery(ctx, "Send a topic to research");
  await ctx.reply("🔬 Research\n\nSend a topic or Pinterest search phrase. I will research the current Pinterest results and tell you how many usable images are available.\n\nExample: dark aesthetic pfp");
});

// ── Search & Post Now ───────────────────────────────────────────
// Stores one pending search per private chat. The next text message becomes
// the exact Pinterest search query; no random query is substituted.
// ── Search & Post Now ───────────────────────────────────────────

const pendingSearches = new Map();
const SEARCH_TIMEOUT_MS = 5 * 60 * 1000;
const pendingBulkSearches = new Map();

// 🎥 Video Search: query -> a list of pick-one results (no download yet).
const pendingVideoSearches = new Map(); // chatId -> { step: "query", started, channel }
const pendingVideoResults = new Map();  // chatId -> { query, channel, candidates, started }

const pendingConfirmations = new Map();
const pendingBatchPublishes = new Map();

let confirmationSequence = 0;

function confirmationKeyboard(id) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📤 Send",
            callback_data: `confirm_send:${id}`
          },
          {
            text: "🗑️ Leave",
            callback_data: `confirm_leave:${id}`
          }
        ]
      ]
    }
  };
}

async function confirmAndPostToChannel(ctx, item, targetChatId) {
  const chatId = ctx.chat?.id;

  if (!chatId || ctx.chat?.type !== "private") {
    return false;
  }

  const id =
    `${String(chatId).slice(-12)}_` +
    `${Date.now()}_` +
    `${++confirmationSequence}`;

  return new Promise(async (resolve) => {
    pendingConfirmations.set(id, {
      id,
      chatId: String(chatId),
      item,
      targetChatId,
      resolve,
      createdAt: Date.now(),
      handled: false
    });

    try {
      await ctx.telegram.sendPhoto(
        chatId,
        { source: item.filePath },
        {
          caption:
            item.caption ||
            `🔎 Search: ${item.query || "—"}\n\n` +
            `Do you want to post this image to the channel?`,
          ...confirmationKeyboard(id)
        }
      );
    } catch (error) {
      pendingConfirmations.delete(id);

      await cleanupFiles(
        item.filePath,
        item.rawPath
      );

      logger.warn(
        {
          error: error?.message,
          id
        },
        "Could not send search image for confirmation"
      );

      resolve(false);
    }
  });
}

async function handleConfirmation(ctx, action) {
  const id = String(
    ctx.match?.[1] || ""
  );

  const pending =
    pendingConfirmations.get(id);

  if (!pending) {
    await safeAnswerCbQuery(ctx, 
      "This confirmation has expired.",
      { show_alert: true }
    );
    return;
  }

  if (
    String(ctx.from?.id) !==
    pending.chatId
  ) {
    await safeAnswerCbQuery(ctx, 
      "This confirmation belongs to another user.",
      { show_alert: true }
    );
    return;
  }

  if (pending.handled) {
    await safeAnswerCbQuery(ctx, 
      "Already handled."
    );
    return;
  }

  pending.handled = true;
  pendingConfirmations.delete(id);

  if (action === "leave") {
    await safeAnswerCbQuery(ctx, 
      "Image left."
    );

    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: []
      });
    } catch {}

    await cleanupFiles(
      pending.item.filePath,
      pending.item.rawPath
    );

    await ctx.reply(
      "🗑️ Left. This image was not posted to the channel."
    );

    pending.resolve(false);
    return;
  }

  try {
    await safeAnswerCbQuery(ctx, 
      "Posting to channel…"
    );

    const result = await publish(
      [pending.item],
      pending.targetChatId
    );

    const message =
      Array.isArray(result)
        ? result[0]
        : result;

    recordPost({
      pinterestPinId: String(
        pending.item.pin?.id ||
        pending.item.pin?.pin_id ||
        pending.item.pin?.pinId ||
        pending.item.pin?.pin_url ||
        pending.item.pin?.url ||
        `manual-${pending.item.imageHash}`
      ),

      imageHash: pending.item.imageHash,
      imageUrl: pending.item.imageUrl,
      sourceUrl: pending.item.sourceUrl,
      category: "manual-search",
      query: pending.item.query,
      caption: pending.item.caption,

      telegramMessageId:
        message?.message_id
          ? String(message.message_id)
          : null,

      status: "posted",
      targetChatId:
        pending.targetChatId,

      userId:
        pending.chatId
    });

    await cleanupFiles(
      pending.item.filePath,
      pending.item.rawPath
    );

    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: []
      });
    } catch {}

    await ctx.reply(
      "✅ Sent! The image has been posted to the channel."
    );

    pending.resolve(true);
  } catch (error) {
    logger.warn(
      {
        error: error?.message,
        id
      },
      "Confirmed image failed to post"
    );

    await cleanupFiles(
      pending.item.filePath,
      pending.item.rawPath
    );

    await ctx.reply(
      `❌ Could not post this image: ${
        error?.message?.slice(0, 250) ||
        "Unknown error"
      }`
    );

    pending.resolve(false);
  }
}

bot.action(
  /^confirm_send:(.+)$/,
  async ctx => {
    try {
      await handleConfirmation(
        ctx,
        "send"
      );
    } catch (error) {
      logger.error(
        {
          error:
            error?.stack ||
            error?.message
        },
        "confirm_send callback failed"
      );

      try {
        await safeAnswerCbQuery(ctx, 
          "Something went wrong.",
          { show_alert: true }
        );
      } catch {}
    }
  }
);

bot.action(
  /^confirm_leave:(.+)$/,
  async ctx => {
    try {
      await handleConfirmation(
        ctx,
        "leave"
      );
    } catch (error) {
      logger.error(
        {
          error:
            error?.stack ||
            error?.message
        },
        "confirm_leave callback failed"
      );

      try {
        await safeAnswerCbQuery(ctx, 
          "Something went wrong.",
          { show_alert: true }
        );
      } catch {}
    }
  }
);


// ── Batch publishing ────────────────────────────────────────────

function batchPublishKeyboard(id, sourceUrl = null) {
  const rows = [
    [
      { text: "📚 Post as Album", callback_data: `batch_album:${id}` },
      { text: "🖼️ Normal Posts", callback_data: `batch_normal:${id}` }
    ],
    [{ text: "✍️ Caption All", callback_data: `batch_custom:${id}` }],
    [{ text: "🗑️ Cancel", callback_data: `batch_cancel:${id}` }]
  ];

  if (/^https?:\/\//i.test(String(sourceUrl || ""))) {
    rows.splice(2, 0, [{ text: "🔗 Open Source Pin", url: sourceUrl }]);
  }

  return { reply_markup: { inline_keyboard: rows } };
}

function batchModeKeyboard(id) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📚 Album", callback_data: `batch_album:${id}` },
          { text: "🖼️ Normal", callback_data: `batch_normal:${id}` }
        ],
        [
          { text: "✏️ Replace Caption", callback_data: `batch_custom:${id}` },
          { text: "🗑️ Cancel", callback_data: `batch_cancel:${id}` }
        ]
      ]
    }
  };
}

async function finishBatchPublish(
  ctx,
  pending,
  mode,
  customCaption = ""
) {
  const items = pending.items || [];

  if (!items.length) {
    return 0;
  }

  const caption =
    String(customCaption || "").trim();

  const prepared =
    caption
      ? applyBatchCaption(
          items,
          caption,
          {
            album:
              mode === "album"
          }
        )
      : items;

  const results = [];

  if (mode === "album") {
    // Telegram media groups max out at 10 items.
    for (
      let i = 0;
      i < prepared.length;
      i += 10
    ) {
      const chunk =
        prepared.slice(i, i + 10);

      const result =
        await publish(
          chunk,
          pending.targetChatId
        );

      results.push(
        ...(Array.isArray(result)
          ? result
          : [result])
      );
    }
  } else {
    const normalResults =
      await publishNormal(
        prepared,
        pending.targetChatId
      );

    results.push(
      ...normalResults
    );
  }

  for (
    let i = 0;
    i < prepared.length;
    i++
  ) {
    const item = prepared[i];

    const telegramMessage =
      results[i];

    recordPost({
      pinterestPinId: String(
        item.pin?.id ||
        item.pin?.pin_id ||
        item.pin?.pinId ||
        item.pin?.pin_url ||
        item.pin?.url ||
        `manual-${item.imageHash}`
      ),

      imageHash:
        item.imageHash,

      imageUrl:
        item.imageUrl,

      sourceUrl:
        item.sourceUrl,

      category:
        "manual-search",

      query:
        item.query,

      caption:
        item.caption,

      telegramMessageId:
        telegramMessage?.message_id
          ? String(
              telegramMessage.message_id
            )
          : null,

      status:
        "posted",

      targetChatId:
        pending.targetChatId,

      userId:
        pending.chatId
    });
  }

  for (const item of items) {
    await cleanupFiles(
      item.filePath,
      item.rawPath
    );
  }

  return prepared.length;
}


// ── Batch callback handler ──────────────────────────────────────

async function handleBatchPublish(
  ctx,
  mode,
  explicitId = null
) {
  const id = String(
    explicitId ?? ctx.match?.[1] ?? ""
  );

  logger.info(
    {
      callback: ctx.callbackQuery?.data,
      id,
      mode,
      userId: ctx.from?.id
    },
    "Batch callback received"
  );

  const pending =
    pendingBatchPublishes.get(id);

  if (!pending) {
    await safeAnswerCbQuery(ctx, 
      "This search has expired.",
      { show_alert: true }
    );
    return;
  }

  if (
    String(ctx.from?.id) !==
    String(pending.chatId)
  ) {
    await safeAnswerCbQuery(ctx, 
      "This search belongs to another user.",
      { show_alert: true }
    );
    return;
  }

  // ───────────────────────────────────────
  // CUSTOM CAPTION
  // ───────────────────────────────────────

  if (mode === "custom") {
    pending.step = "caption";
    pending.mode = "custom";

    await safeAnswerCbQuery(ctx, 
      "Send your caption."
    );

    await ctx.reply(
      "✍️ *Custom Caption*\n\n" +
      "Send the caption you want applied " +
      "to every image.\n\n" +
      "Maximum: 1024 characters.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          force_reply: true,
          selective: true
        }
      }
    );

    return;
  }

  // ───────────────────────────────────────
  // ALBUM / NORMAL
  // ───────────────────────────────────────

  try {
    await safeAnswerCbQuery(ctx, 
      mode === "album"
        ? "Posting album…"
        : "Posting normal posts…"
    );

    // Prevent double clicks.
    pendingBatchPublishes.delete(id);

    const posted =
      await finishBatchPublish(
        ctx,
        pending,
        mode,
        pending.customCaption || ""
      );

    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: []
      });
    } catch {}

    await ctx.reply(
      `✅ *Search complete!*\n\n` +
      `🔎 Query: ${pending.query}\n` +
      `🖼️ Posted: ${posted}\n` +
      `📦 Mode: ${
        mode === "album"
          ? "Album"
          : "Normal Posts"
      }` +
      `${
        pending.customCaption
          ? "\n✍️ Custom caption: applied"
          : ""
      }`,
      {
        parse_mode: "Markdown",
        ...MAIN_MENU
      }
    );

    if (
      typeof pending.resolve ===
      "function"
    ) {
      pending.resolve(posted);
    }
  } catch (error) {
    logger.error(
      {
        error:
          error?.stack ||
          error?.message,
        id,
        mode
      },
      "Batch publishing failed"
    );

    await ctx.reply(
      `❌ Could not publish the search results:\n\n${
        error?.message?.slice(0, 300) ||
        "Unknown error"
      }`
    );

    for (
      const item
      of pending.items || []
    ) {
      await cleanupFiles(
        item.filePath,
        item.rawPath
      );
    }

    pendingBatchPublishes.delete(id);

    if (
      typeof pending.resolve ===
      "function"
    ) {
      pending.resolve(0);
    }
  }
}


// Finds the caller's own pending batch search, if any — used so /caption
// and /post work as text-command fallbacks even without ctx.match (which
// only exists for the button callbacks these mirror).
function findActiveBatchId(userId) {
  for (const [id, pending] of pendingBatchPublishes.entries()) {
    if (String(pending.chatId) === String(userId)) return id;
  }
  return null;
}

// ── Batch callbacks ─────────────────────────────────────────────

bot.action(
  /^batch_album:(.+)$/,
  async ctx => {
    try {
      await handleBatchPublish(
        ctx,
        "album"
      );
    } catch (error) {
      logger.error(
        {
          error:
            error?.stack ||
            error?.message,
          callback:
            ctx.callbackQuery?.data
        },
        "batch_album callback failed"
      );

      try {
        await safeAnswerCbQuery(ctx, 
          "Could not publish album.",
          { show_alert: true }
        );
      } catch {}
    }
  }
);

bot.action(
  /^batch_normal:(.+)$/,
  async ctx => {
    try {
      await handleBatchPublish(
        ctx,
        "normal"
      );
    } catch (error) {
      logger.error(
        {
          error:
            error?.stack ||
            error?.message,
          callback:
            ctx.callbackQuery?.data
        },
        "batch_normal callback failed"
      );

      try {
        await safeAnswerCbQuery(ctx, 
          "Could not publish posts.",
          { show_alert: true }
        );
      } catch {}
    }
  }
);

bot.action(
  /^batch_custom:(.+)$/,
  async ctx => {
    try {
      await handleBatchPublish(
        ctx,
        "custom"
      );
    } catch (error) {
      logger.error(
        {
          error:
            error?.stack ||
            error?.message,
          callback:
            ctx.callbackQuery?.data
        },
        "batch_custom callback failed"
      );

      try {
        await safeAnswerCbQuery(ctx, 
          "Could not open caption input.",
          { show_alert: true }
        );
      } catch {}
    }
  }
);

bot.action(
  /^batch_cancel:(.+)$/,
  async ctx => {
    const id = String(
      ctx.match?.[1] || ""
    );

    const pending =
      pendingBatchPublishes.get(id);

    if (!pending) {
      await safeAnswerCbQuery(ctx, 
        "This search has expired.",
        { show_alert: true }
      );
      return;
    }

    if (
      String(ctx.from?.id) !==
      String(pending.chatId)
    ) {
      await safeAnswerCbQuery(ctx, 
        "This search belongs to another user.",
        { show_alert: true }
      );
      return;
    }

    pendingBatchPublishes.delete(id);

    for (
      const item
      of pending.items || []
    ) {
      await cleanupFiles(
        item.filePath,
        item.rawPath
      );
    }

    await safeAnswerCbQuery(ctx, 
      "Search cancelled."
    );

    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: []
      });
    } catch {}

    await ctx.reply(
      "🗑️ Search results cancelled.\n\nNothing was posted.",
      MAIN_MENU
    );

    if (
      typeof pending.resolve ===
      "function"
    ) {
      pending.resolve(0);
    }
  }
);


async function askForSearch(ctx, channel) {
  const chatId = ctx.chat?.id;
  if (!chatId || ctx.chat?.type !== "private" || !channel) return;

  pendingSearches.set(chatId, { step: "query", started: Date.now(), channel });
  await ctx.reply(
    `🔎 Send the exact search word or phrase you want me to search on Pinterest.\n\nExample: pink wallpapers\n\n📡 Posting to: *${channelLabel(channel)}*`,
    { parse_mode: "Markdown", reply_markup: { force_reply: true, selective: true } }
  );
}

bot.action("search_postnow", async (ctx) => {
  await safeAnswerCbQuery(ctx, "Choosing your channel…");
  const channel = await resolveTargetChannel(ctx, "search_postnow");
  if (channel) await askForSearch(ctx, channel);
});

async function askForBulkSearch(ctx, channel) {
  const chatId = ctx.chat?.id;
  if (!chatId || ctx.chat?.type !== "private" || !channel) return;

  pendingBulkSearches.set(chatId, { step: "query", started: Date.now(), channel });
  await ctx.reply(
    `📦 Bulk Search & Post\n\nSend the exact Pinterest search word or phrase. I will search exactly what you send, then ask how many results you want posted.\n\nExample: anime wallpaper\n\n📡 Posting to: *${channelLabel(channel)}*`,
    { parse_mode: "Markdown", reply_markup: { force_reply: true, selective: true } }
  );
}

bot.action("bulk_search_post", async (ctx) => {
  await safeAnswerCbQuery(ctx, "Choosing your channel…");
  const channel = await resolveTargetChannel(ctx, "bulk_search_post");
  if (channel) await askForBulkSearch(ctx, channel);
});

// ── 🎥 Video Search ───────────────────────────────────────────
// Only one video can be selected per search — results are shown as a
// pick-one list, nothing downloads until the user taps a specific result.
async function askForVideoSearch(ctx, channel) {
  const chatId = ctx.chat?.id;
  if (!chatId || ctx.chat?.type !== "private" || !channel) return;

  pendingVideoSearches.set(chatId, { step: "query", started: Date.now(), channel });
  await ctx.reply(
    `🎥 Video Search\n\nSend the exact Pinterest search word or phrase. I'll show up to ${config.content.videoResultsPerQuery} video results for you to choose ONE from.\n\nExample: aesthetic anime edit\n\n📡 Posting to: *${channelLabel(channel)}*`,
    { parse_mode: "Markdown", reply_markup: { force_reply: true, selective: true } }
  );
}

bot.action("video_search", async (ctx) => {
  await safeAnswerCbQuery(ctx, "Choosing your channel…");
  const channel = await resolveTargetChannel(ctx, "video_search");
  if (channel) await askForVideoSearch(ctx, channel);
});

bot.action(/^video_pick:(\d+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  const pending = pendingVideoResults.get(chatId);
  if (!pending || String(ctx.from?.id) !== String(chatId)) {
    return safeAnswerCbQuery(ctx, "This search is no longer active", { show_alert: true });
  }
  if (Date.now() - pending.started > SEARCH_TIMEOUT_MS) {
    pendingVideoResults.delete(chatId);
    await safeAnswerCbQuery(ctx, "Request expired", { show_alert: true });
    await ctx.reply("⌛ That video search expired. Press 🎥 Video Search and try again.");
    return;
  }

  const index = Number(ctx.match[1]);
  const candidate = pending.candidates[index];
  if (!candidate) return safeAnswerCbQuery(ctx, "Invalid selection", { show_alert: true });

  // Single-use — one video per search, as soon as a pick is made the list closes.
  pendingVideoResults.delete(chatId);
  await safeAnswerCbQuery(ctx, "Downloading your pick…");
  await ctx.sendChatAction("upload_video").catch(() => {});
  const progressMessage = await ctx.reply("⏳ Downloading and posting the selected video…");

  try {
    const { preparePickedVideo, publishPickedVideo } = await import("../worker.js");
    const prepared = await preparePickedVideo(candidate, pending.query);
    await publishPickedVideo(prepared, pending.channel.chat_id, ctx.from.id);
    await ctx.telegram.editMessageText(
      chatId, progressMessage.message_id, undefined,
      `✅ Video posted to *${channelLabel(pending.channel)}*.`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    await ctx.telegram.editMessageText(
      chatId, progressMessage.message_id, undefined,
      `❌ Could not post that video: ${error?.message?.slice(0, 300) || "Unknown error"}`
    );
  }
});

bot.action(/^video_download:(\d+)$/, async ctx => {
  const chatId = ctx.chat?.id;
  const pending = pendingVideoResults.get(chatId);
  if (!pending || String(ctx.from?.id) !== String(chatId)) {
    await safeAnswerCbQuery(ctx, "This video search is no longer active", { show_alert: true });
    return;
  }

  const candidate = pending.candidates[Number(ctx.match[1])];
  if (!candidate) {
    await safeAnswerCbQuery(ctx, "Invalid video selection", { show_alert: true });
    return;
  }

  await safeAnswerCbQuery(ctx, "Downloading video…");
  await ctx.sendChatAction("upload_video").catch(() => {});

  let prepared;
  try {
    const { preparePickedVideo } = await import("../worker.js");
    prepared = await preparePickedVideo(candidate, pending.query);
    await ctx.replyWithVideo(
      { source: prepared.filePath },
      {
        caption: prepared.caption,
        supports_streaming: true,
        reply_markup: /^https?:\/\//i.test(String(candidate.sourceUrl || ""))
          ? { inline_keyboard: [[{ text: "🔗 Open Pinterest Pin", url: candidate.sourceUrl }]] }
          : undefined
      }
    );
    // A download-to-chat is not a channel post, so don't record it as posted.
  } catch (error) {
    await ctx.reply(`❌ Video download failed: ${error?.message?.slice(0, 300) || "Unknown error"}`);
  } finally {
    if (prepared) {
      const { cleanupFiles } = await import("../images/processor.js");
      await cleanupFiles(prepared.filePath, prepared.rawPath);
    }
  }
});

bot.action("video_cancel", async (ctx) => {
  pendingVideoResults.delete(ctx.chat?.id);
  await safeAnswerCbQuery(ctx, "Cancelled");
  await ctx.reply("🛑 Video search cancelled.", MAIN_MENU);
});

const BULK_QTY_MENU = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "10 images", callback_data: "bulk_qty_10" }, { text: "25 images", callback_data: "bulk_qty_25" }],
      [{ text: "50 images", callback_data: "bulk_qty_50" }, { text: "100 images", callback_data: "bulk_qty_100" }],
      [{ text: "♾️ All available", callback_data: "bulk_qty_all" }]
    ]
  }
};

for (const [key, qty] of [["bulk_qty_10",10],["bulk_qty_25",25],["bulk_qty_50",50],["bulk_qty_100",100],["bulk_qty_all",0]]) {
  bot.action(key, async (ctx) => {
    const chatId = ctx.chat?.id;
  const bulk = pendingBulkSearches.get(chatId);
    const normal = pendingSearches.get(chatId);
    const pending = bulk?.step === "quantity" ? bulk : (normal?.step === "quantity" ? normal : null);
    const isBulk = !!(bulk?.step === "quantity");

    if (!pending) {
      await safeAnswerCbQuery(ctx, "Start a search first");
      return;
    }

    if (isBulk) pendingBulkSearches.delete(chatId);
    else pendingSearches.delete(chatId);

    if (Date.now() - pending.started > SEARCH_TIMEOUT_MS) {
      await safeAnswerCbQuery(ctx, "Request expired");
      await ctx.reply("⌛ That search request expired. Start the search again and try again.");
      return;
    }

    await safeAnswerCbQuery(ctx, qty ? `Posting ${qty} images` : "Posting all available");
    await ctx.reply(`${isBulk ? "📦 Bulk search started" : "🔎 Search started"}

🔎 Exact query: ${pending.query}
🖼️ Amount: ${qty || "all available"}
⏳ Searching Pinterest and preparing your selected images...`);

    try {
      const { runSearchPostJob } = await import("../worker.js");
      const progressMessage = await ctx.reply(
        `⏳ ᴘʀᴏᴄᴇssɪɴɢ 0/${qty || "available"}\n🔎 ${pending.query}`
      );
      let lastProgressAt = 0;

      const result = await runSearchPostJob(
        pending.query,
        async ({ prepared = 0, target = qty || 0 }) => {
          const now = Date.now();
          if (now - lastProgressAt < 700 && prepared < target) return;
          lastProgressAt = now;
          const totalLabel = target || "available";
          try {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              progressMessage.message_id,
              undefined,
              `⏳ ᴘʀᴏᴄᴇssɪɴɢ ${prepared}/${totalLabel}\n🔎 ${pending.query}`
            );
          } catch {
            // Ignore progress-edit failures and keep the posting task alive.
          }
        },
        qty,
        async (preparedItems) => {
          const id = `${String(ctx.from?.id).slice(-12)}_${Date.now()}_${++confirmationSequence}`;
          pendingBatchPublishes.set(id, {
            id,
            chatId: String(ctx.from?.id),
            targetChatId: pending.channel?.chat_id,
            query: pending.query,
            items: preparedItems,
            step: "mode",
            createdAt: Date.now()
          });
          const first = preparedItems[0];
          const batchCaption =
            `🎉 *Search finished!*\n\n` +
            `🔎 Query: ${pending.query}\n` +
            `🖼️ Ready images: ${preparedItems.length}\n\n` +
            `Previewing the first image. Choose how the full set should be published:`;
          try {
            await ctx.replyWithPhoto(
              { source: first.filePath },
              {
                caption: batchCaption,
                parse_mode: "Markdown",
                ...batchPublishKeyboard(id, first.sourceUrl)
              }
            );
          } catch {
            await ctx.reply(batchCaption, { parse_mode: "Markdown", ...batchPublishKeyboard(id, first.sourceUrl) });
          }
          return await new Promise(resolve => {
            const timer = setInterval(() => {
              const current = pendingBatchPublishes.get(id);
              if (!current) { clearInterval(timer); resolve(preparedItems.length); return; }
              if (current.step === "caption" && current.customCaption) {
                clearInterval(timer); resolve(0);
              }
            }, 500);
            setTimeout(() => { clearInterval(timer); resolve(0); }, 30 * 60 * 1000);
          });
        },
        pending.channel?.chat_id,
        ctx.from?.id,
        { readyOnly: true }
      );
      await ctx.reply(`✅ ${isBulk ? "Bulk post" : "Search post"} complete!

🔎 Query: ${result.query}
📌 Results found: ${result.found}
🖼️ Posted: ${result.posted}
⏭️ Skipped/failed: ${Math.max(0, (result.accepted || 0) - result.posted)}
📢 Channel: ${pending.channel ? channelLabel(pending.channel) : config.telegram.channelId}`);
    } catch (error) {
      logger.error({ error: error?.stack || error?.message, query: pending.query, qty }, `${isBulk ? "Bulk Search & Post" : "Search & Post"} failed`);
      await ctx.reply(`❌ ${isBulk ? "Bulk Search & Post" : "Search & Post"} failed: ${error?.message?.slice(0, 300) || "Unknown error"}`);
    }
  });
}


// ── Direct Pinterest link processing ────────────────────────────
// A user can paste a Pinterest pin URL (or pin.it short link) straight
// into the chat instead of using Search. It's detected automatically,
// resolved through the same extraction/download pipeline as every other
// flow, and shown with the same Post/Caption/Back controls used elsewhere.

const PINTEREST_URL_RE = /(https?:\/\/(?:[a-z0-9-]+\.)?(?:pinterest\.[a-z.]+\/pin\/[a-z0-9_/-]+|pin\.it\/[a-z0-9]+))/i;

function extractPinterestUrl(text) {
  const match = String(text || "").match(PINTEREST_URL_RE);
  return match ? match[1] : null;
}

const pendingDirectPins = new Map(); // id -> { chatId, type, items, sourceUrl, createdAt, step }
let directPinSequence = 0;

function directPinKeyboard(id, sourceUrl) {
  const rows = [
    [
      { text: "📤 POST", callback_data: `direct_pin_post:${id}` },
      { text: "✍️ CAPTION", callback_data: `direct_pin_caption:${id}` }
    ]
  ];
  if (/^https?:\/\//i.test(String(sourceUrl || ""))) {
    rows.push([{ text: "🔗 Open Pin", url: sourceUrl }]);
  }
  rows.push([{ text: "◀️ BACK", callback_data: `direct_pin_back:${id}` }]);
  return { reply_markup: { inline_keyboard: rows } };
}

async function cleanupDirectPin(pending) {
  for (const item of pending?.items || []) {
    await cleanupFiles(item.filePath, item.rawPath);
  }
}

async function handleDirectPinterestUrl(ctx, url) {
  const chatId = ctx.chat?.id;
  if (!chatId || ctx.chat?.type !== "private") return;

  await ctx.sendChatAction("typing").catch(() => {});
  const progress = await ctx.reply("🌸 Detected a Pinterest link — resolving the Pin…");

  let resolved;
  try {
    const { resolveDirectPinterestUrl } = await import("../worker.js");
    resolved = await resolveDirectPinterestUrl(url);
  } catch (error) {
    logger.warn({ error: error?.message, url }, "Direct Pinterest link resolution failed");
    await ctx.telegram.editMessageText(
      chatId, progress.message_id, undefined,
      `❌ ${error?.message?.slice(0, 300) || "Could not process that Pinterest link."}`
    ).catch(() => ctx.reply(`❌ ${error?.message?.slice(0, 300) || "Could not process that Pinterest link."}`));
    return;
  }

  try { await ctx.telegram.deleteMessage(chatId, progress.message_id); } catch {}

  const id = `dp_${String(chatId).slice(-12)}_${Date.now()}_${++directPinSequence}`;
  const first = resolved.items[0];
  pendingDirectPins.set(id, {
    id,
    chatId: String(chatId),
    type: resolved.type,
    items: resolved.items,
    sourceUrl: first.sourceUrl || url,
    createdAt: Date.now(),
    step: "ready"
  });

  const keyboard = directPinKeyboard(id, first.sourceUrl || url);

  try {
    if (resolved.type === "video") {
      await ctx.replyWithVideo(
        { source: first.filePath },
        { caption: first.caption, supports_streaming: true, ...keyboard }
      );
    } else if (resolved.type === "album" && resolved.items.length > 1) {
      const media = resolved.items.slice(0, 10).map((item, i) => ({
        type: "photo",
        media: { source: item.filePath },
        caption: i === 0 ? item.caption : undefined
      }));
      await ctx.replyWithMediaGroup(media);
      await ctx.reply(`📚 Album Pin — ${resolved.items.length} images`, keyboard);
    } else {
      await ctx.replyWithPhoto({ source: first.filePath }, { caption: first.caption, ...keyboard });
    }
  } catch (error) {
    logger.warn({ error: error?.message, id }, "Sending direct pin media failed");
    pendingDirectPins.delete(id);
    await cleanupDirectPin({ items: resolved.items });
    await ctx.reply(`❌ Could not send that Pin's media: ${error?.message?.slice(0, 250) || "Unknown error"}`);
  }
}

async function requireDirectPin(ctx) {
  const id = String(ctx.match?.[1] || "");
  const pending = pendingDirectPins.get(id);
  if (!pending) {
    await safeAnswerCbQuery(ctx, "This Pin session has expired.", { show_alert: true });
    return null;
  }
  if (String(ctx.from?.id) !== pending.chatId) {
    await safeAnswerCbQuery(ctx, "This belongs to another user.", { show_alert: true });
    return null;
  }
  return pending;
}

async function postDirectPinToChannel(ctx, pending, channel) {
  try {
    let results;
    if (pending.type === "video") {
      const message = await publishVideo(pending.items[0], channel.chat_id);
      results = [message];
    } else {
      results = await publish(pending.items, channel.chat_id);
    }

    for (let i = 0; i < pending.items.length; i++) {
      const item = pending.items[i];
      const message = Array.isArray(results) ? results[i] : results;
      recordPost({
        pinterestPinId: String(item.pin?.id || item.pin?.pin_id || item.pin?.pinId || item.pin?.pin_url || item.pin?.url || `direct-${item.imageHash}`),
        imageHash: item.imageHash,
        imageUrl: item.imageUrl,
        sourceUrl: item.sourceUrl,
        category: "direct-link",
        query: "",
        caption: item.caption,
        telegramMessageId: message?.message_id ? String(message.message_id) : null,
        status: "posted",
        targetChatId: channel.chat_id,
        userId: pending.chatId
      });
    }

    pendingDirectPins.delete(pending.id);
    await cleanupDirectPin(pending);
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
    await ctx.reply(`✅ Posted to *${channelLabel(channel)}*.`, { parse_mode: "Markdown" });
  } catch (error) {
    logger.warn({ error: error?.message, id: pending.id }, "Direct pin post failed");
    await ctx.reply(`❌ Could not post this Pin: ${error?.message?.slice(0, 250) || "Unknown error"}`);
  }
}

// Remembers which direct-pin session a channel picker tap belongs to, since
// pick_channel:<flow>:<channelId> callback data has no room for a second id.
const directPinChannelPick = new Map(); // chatId -> direct pin id

bot.action(/^direct_pin_post:(.+)$/, async ctx => {
  const pending = await requireDirectPin(ctx);
  if (!pending) return;

  directPinChannelPick.set(String(ctx.chat.id), pending.id);
  const channel = await resolveTargetChannel(ctx, "direct_pin_post");
  if (!channel) return; // resolveTargetChannel already replied (no channel / picker shown)

  directPinChannelPick.delete(String(ctx.chat.id));
  await safeAnswerCbQuery(ctx, "Posting…");
  await postDirectPinToChannel(ctx, pending, channel);
});

FLOW_STARTERS.direct_pin_post = async ctx => {
  const id = directPinChannelPick.get(String(ctx.chat.id));
  directPinChannelPick.delete(String(ctx.chat.id));
  const channel = takeTargetChannel(ctx.chat.id);
  const pending = id ? pendingDirectPins.get(id) : null;
  if (!pending || !channel) {
    await ctx.reply("⌛ That Pin session is no longer available. Please send the Pinterest link again.");
    return;
  }
  await postDirectPinToChannel(ctx, pending, channel);
};

const pendingDirectPinCaption = new Map(); // chatId -> direct pin id

bot.action(/^direct_pin_caption:(.+)$/, async ctx => {
  const pending = await requireDirectPin(ctx);
  if (!pending) return;

  pendingDirectPinCaption.set(String(ctx.chat.id), pending.id);
  await safeAnswerCbQuery(ctx, "Send your caption.");
  await ctx.reply(
    "✍️ *Caption*\n\nSend the caption you want for this Pin.\n\nMaximum: 1024 characters.",
    { parse_mode: "Markdown", reply_markup: { force_reply: true, selective: true } }
  );
});

bot.action(/^direct_pin_back:(.+)$/, async ctx => {
  const pending = await requireDirectPin(ctx);
  if (!pending) return;

  pendingDirectPins.delete(pending.id);
  pendingDirectPinCaption.delete(pending.chatId);
  await cleanupDirectPin(pending);
  await safeAnswerCbQuery(ctx, "Back");
  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
  await ctx.reply("◀️ Back to the main menu.", MAIN_MENU);
});

// Handle the search phrase after the button prompt.
bot.on("text", async (ctx, next) => {
  if (ctx.chat?.type !== "private") return next();

  const chatId = ctx.chat.id;

  // ✍️ CAPTION for a direct-link Pin — same "text step, not a callback
  // step" pattern as the batch caption below, kept first so it can never
  // be hijacked by the Pinterest-link auto-detection further down.
  const directCaptionId = pendingDirectPinCaption.get(String(chatId));
  if (directCaptionId) {
    const pending = pendingDirectPins.get(directCaptionId);
    if (!pending) {
      pendingDirectPinCaption.delete(String(chatId));
    } else {
      const caption = String(ctx.message.text || "").trim();
      if (!caption || caption.startsWith("/")) {
        await ctx.reply("❌ Send the caption as normal text, or use /cancel to stop.");
        return;
      }
      if (caption.length > 1024) {
        await ctx.reply(`❌ Caption is ${caption.length} characters. Telegram allows up to 1024 characters.`);
        return;
      }
      for (const item of pending.items) item.caption = caption;
      pendingDirectPinCaption.delete(String(chatId));
      const first = pending.items[0];
      const keyboard = directPinKeyboard(pending.id, pending.sourceUrl);
      await ctx.reply(`✍️ Caption saved.\n\n${caption}`, keyboard);
      return;
    }
  }

  // Custom caption is a text step, not a callback step. Keep it here so
  // the caption button actually waits for the user's next message.
  for (const [id, pendingBatch] of pendingBatchPublishes.entries()) {
    if (
      String(pendingBatch.chatId) !== String(ctx.from?.id) ||
      pendingBatch.step !== "caption"
    ) continue;

    if (Date.now() - pendingBatch.createdAt > 30 * 60 * 1000) {
      pendingBatchPublishes.delete(id);
      await cleanupFiles(
        ...(pendingBatch.items || []).flatMap(item => [item.filePath, item.rawPath])
      );
      await ctx.reply("⌛ Custom caption request expired. Please run the search again.");
      return;
    }

    const caption = String(ctx.message.text || "").trim();
    if (!caption || caption.startsWith("/")) {
      await ctx.reply("❌ Send the caption as normal text, or use /cancel to stop.");
      return;
    }

    if (caption.length > 1024) {
      await ctx.reply(
        `❌ Caption is ${caption.length} characters. Telegram allows up to 1024 characters for photo captions.`
      );
      return;
    }

    pendingBatch.customCaption = caption;
    pendingBatch.step = "custom_mode";

    await ctx.reply(
      "✍️ Caption saved for every image. Now choose the publishing mode:",
      batchModeKeyboard(id)
    );
    return;
  }

  // ── Automatic Pinterest link detection ─────────────────────────
  // A bare Pinterest URL is handled immediately — the user does not need
  // to press Search first. This takes priority over "send me a search
  // phrase"-style flows (a pasted link there is clearly meant to be
  // resolved directly, not searched for as literal text), but steps back
  // for flows that are mid-way through capturing a specific piece of
  // literal text (a channel username, a schedule time) so it doesn't
  // clobber those instead of helping.
  const addingChannel = pendingAddChannel.get(chatId);
  const schedulePending = pendingSchedules.get(chatId);
  const rawIncomingText = String(ctx.message.text || "").trim();
  const directPinUrl = (!addingChannel && !schedulePending)
    ? extractPinterestUrl(rawIncomingText)
    : null;

  if (directPinUrl) {
    pendingSearches.delete(chatId);
    pendingBulkSearches.delete(chatId);
    pendingVideoSearches.delete(chatId);
    pendingResearches.delete(chatId);
    await handleDirectPinterestUrl(ctx, directPinUrl);
    return;
  }

  if (addingChannel?.step === "username") {
    if (Date.now() - addingChannel.started > ADD_CHANNEL_TIMEOUT_MS) {
      pendingAddChannel.delete(chatId);
      await ctx.reply("⌛ That request expired. Tap ➕ Add Channel and try again.");
      return;
    }

    const raw = ctx.message.text || "";
    const forwardedUsername = ctx.message.forward_from_chat?.username
      ? `@${ctx.message.forward_from_chat.username}`
      : ctx.message.forward_from_chat?.id
        ? String(ctx.message.forward_from_chat.id)
        : null;
    const handle = forwardedUsername || normalizeChannelHandle(raw);

    if (!handle) {
      await ctx.reply("❌ Send a valid channel username (e.g. `@myaesthetic`) or forward a message from the channel.", { parse_mode: "Markdown" });
      return;
    }

    await askToVerifyAdmin(ctx, handle);
    return;
  }

  const scheduled = pendingSchedules.get(chatId);
  if (scheduled) {
    if (Date.now() - scheduled.started > SCHEDULE_TIMEOUT_MS) {
      pendingSchedules.delete(chatId);
      await ctx.reply("⌛ That scheduling request expired. Press 📸 Next Post and try again.");
      return;
    }

    const text = String(ctx.message.text || "").trim();
    if (scheduled.step === "query") {
      if (!text || text.startsWith("/")) return ctx.reply("❌ Send a normal search phrase, for example: soft girl pfp");
      scheduled.query = text;
      scheduled.step = "amount";
      scheduled.category = "custom";
      await ctx.reply(`✍️ Custom search: ${text}\n\n🖼️ Choose the exact amount:`, NEXT_AMOUNT_MENU);
      return;
    }
    if (scheduled.step === "amount_custom") {
      const amount = Number(text);
      if (!Number.isInteger(amount) || amount < 1 || amount > 100) return ctx.reply("❌ Amount must be a whole number from 1 to 100.");
      scheduled.amount = amount;
      scheduled.step = "time";
      await askForScheduleTime(ctx);
      return;
    }
    if (scheduled.step === "time") {
      const runAt = scheduleTimeToIso(text);
      if (!runAt || runAt.getTime() <= Date.now()) return ctx.reply("❌ Invalid or past time. Use YYYY-MM-DD HH:MM in Lagos time, for example 2026-09-12 14:30.");
      scheduled.runAt = runAt;
      await savePendingSchedule(ctx, scheduled);
      return;
    }
  }

  const researchStarted = pendingResearches.get(chatId);
  if (researchStarted) {
    pendingResearches.delete(chatId);
    if (Date.now() - researchStarted > SEARCH_TIMEOUT_MS) return ctx.reply("⌛ Research request expired. Press 🔬 Research and try again.");
    const topic = String(ctx.message.text || "").trim();
    if (!topic || topic.startsWith("/")) return ctx.reply("❌ Send a research topic or Pinterest search phrase.");
    try {
      await ctx.reply(`🔬 Researching Pinterest for: ${topic}\n\n⏳ Checking current results...`);
      const results = await searchPins(topic);
      const usable = results.filter(item => item?.imageUrl || item?.image_url || item?.image || item?.url);
      await ctx.reply(`🔬 Research complete\n\n🔎 Query: ${topic}\n📌 Results found: ${results.length}\n🖼️ Images with usable image data: ${usable.length}\n\nIf you like this topic, use 🔎 Search & Post Now or 📸 Next Post to schedule it.`, MAIN_MENU);
    } catch (error) {
      await ctx.reply(`❌ Research failed: ${error?.message?.slice(0, 300) || "Unknown error"}`);
    }
    return;
  }

  const videoSearch = pendingVideoSearches.get(chatId);
  if (videoSearch?.step === "query") {
    pendingVideoSearches.delete(chatId);

    if (Date.now() - videoSearch.started > SEARCH_TIMEOUT_MS) {
      await ctx.reply("⌛ That video search request expired. Press 🎥 Video Search and try again.");
      return;
    }

    const query = String(ctx.message.text || "").trim();
    if (!query || query.startsWith("/")) {
      await ctx.reply("❌ Please send a search word or phrase, for example: aesthetic anime edit");
      return;
    }

    await ctx.sendChatAction("typing").catch(() => {});
    await ctx.reply(`🎥 Searching Pinterest for videos: ${query}\n⏳ One moment...`);

    try {
      const { searchVideoCandidates } = await import("../worker.js");
      const { candidates } = await searchVideoCandidates(query);

      if (!candidates.length) {
        await ctx.reply("😕 No video results found for that search. Try a different phrase.", MAIN_MENU);
        return;
      }

      pendingVideoResults.set(chatId, { query, channel: videoSearch.channel, candidates, started: Date.now() });

      await ctx.reply(
        `🎥 Found ${candidates.length} video${candidates.length === 1 ? "" : "s"} for "${query}"\n\nBrowse below, then tap 🎬 Pick this one under whichever you want. 📡 Posting to *${channelLabel(videoSearch.channel)}*`,
        { parse_mode: "Markdown" }
      );

      // Show each candidate as an actual photo preview (its Pinterest
      // thumbnail) with its own pick button underneath, so the user can see
      // what they're choosing instead of picking blind off a text list.
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const pickRow = [
          { text: "📤 Post to Channel", callback_data: `video_pick:${i}` },
          { text: "📥 Download", callback_data: `video_download:${i}` }
        ];
        const urlRow = /^https?:\/\//i.test(String(c.sourceUrl || ""))
          ? [{ text: "🔗 Open Pin", url: c.sourceUrl }]
          : [];
        const caption = `${i + 1}. ${(c.title || query).slice(0, 150)}\n\n🎥 Video Pin`;
        const keyboard = { inline_keyboard: [pickRow, ...urlRow] };
        try {
          if (c.thumbnailUrl) {
            await ctx.replyWithPhoto(c.thumbnailUrl, { caption, reply_markup: keyboard });
          } else {
            await ctx.reply(caption, { reply_markup: keyboard });
          }
        } catch {
          // Thumbnail failed to load — fall back to a text row so the controls are never lost.
          await ctx.reply(caption, { reply_markup: keyboard });
        }
      }

      await ctx.reply("👆 Pick one above, or:", { reply_markup: { inline_keyboard: [[{ text: "🛑 Cancel", callback_data: "video_cancel" }]] } });
    } catch (error) {
      await ctx.reply(`❌ Video search failed: ${error?.message?.slice(0, 300) || "Unknown error"}`);
    }
    return;
  }

  const bulk = pendingBulkSearches.get(chatId);

  // IMPORTANT: Bulk mode must be checked before normal search mode.
  // Otherwise a bulk query is silently passed to the next middleware.
  if (bulk?.step === "query") {
    pendingBulkSearches.delete(chatId);

    if (Date.now() - bulk.started > SEARCH_TIMEOUT_MS) {
      await ctx.reply("⌛ That bulk search request expired. Press 📦 Bulk Search & Post and try again.");
      return;
    }

    const query = String(ctx.message.text || "").trim();

    if (!query || query.startsWith("/")) {
      await ctx.reply("❌ Please send a search word or phrase, for example: boy aesthetic pfp dark");
      return;
    }

    pendingBulkSearches.set(chatId, {
      step: "quantity",
      query,
      started: bulk.started,
      channel: bulk.channel
    });

    await ctx.reply(
      `🔎 Exact search: ${query}\n\nHow many results should I bulk-post?`,
      BULK_QTY_MENU
    );
    return;
  }

  const started = pendingSearches.get(chatId);
  if (!started || started.step !== "query") return next();

  // Normal Search & Post now also asks for the number of images before posting.
  pendingSearches.delete(chatId);

  if (Date.now() - started.started > SEARCH_TIMEOUT_MS) {
    await ctx.reply("⌛ That search request expired. Press 🔎 Search & Post Now and try again.");
    return;
  }

  const query = String(ctx.message.text || "").trim();

  if (!query || query.startsWith("/")) {
    await ctx.reply("❌ Please send a search word or phrase, for example: pink wallpapers");
    return;
  }

  pendingSearches.set(chatId, {
    step: "quantity",
    query,
    started: started.started,
    channel: started.channel
  });

  await ctx.reply(
    `🔎 Searching Pinterest for exactly: ${query}\n\n🖼️ How many images do you want me to send?`,
    BULK_QTY_MENU
  );
  return;
});

// ── Rich /start experience ─────────────────────────────────────
bot.command("start", async (ctx) => {
  if (ctx.chat.type === "private") {
    await sendRichDraft(ctx, {
      blocks: [{ type: "thinking", text: "Loading..." }]
    }, 1);
  } else {
    await ctx.telegram.sendChatAction(ctx.chat.id, "typing");
  }

  await new Promise(resolve => setTimeout(resolve, 1500));

  const rich = {
    blocks: [
      richPhoto(menuImageSource()),
      richHeader("Welcome", 3),
      richDivider(),
      richText(`Welcome to ${BRAND_SHORT}.\n\nPinterest image search, album posting, captions, scheduling and video tools.`),
      richTable(
        ["Feature", "Available"],
        [
          ["Pinterest search", "✓"],
          ["Album posting", "✓"],
          ["Captions", "✓"],
          ["Scheduling", "✓"],
          ["Video tools", "✓"]
        ],
        { bordered: true, striped: true, caption: "Bot features" }
      )
    ],
    reply_markup: MAIN_MENU.reply_markup
  };

  await sendRich(ctx, rich, async () => {
    await sendMenuCard(ctx, `🌸 *${BRAND}*\n\nChoose what you want to do:`, MAIN_MENU);
  });
});

// ── Task controls ──────────────────────────────────────────────

async function sendImageMenu(ctx) {
  const caption = `🌸 *${BRAND}*\n\nChoose what you want to do:`;
  return sendMenuCard(ctx, caption, MAIN_MENU);
}

bot.command("menu", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  try {
    await sendImageMenu(ctx);
  } catch (error) {
    logger.warn({ error: error?.message }, "Menu image failed; sending text menu");
    await ctx.reply(`🌸 *${BRAND}*\n\nChoose what you want to do:`, { parse_mode: "Markdown", ...MAIN_MENU });
  }
});

bot.action("stop_task", async (ctx) => {
  const { stopCurrentTask } = await import("../worker.js");
  const stopped = stopCurrentTask(ctx.from?.id);
  await safeAnswerCbQuery(ctx, stopped ? "Task paused" : "No active task");
  await ctx.reply(stopped ? "⏸️ Current task paused. Use /continue to resume it." : "ℹ️ There is no active task right now.");
});

bot.action("continue_task", async (ctx) => {
  const { continueCurrentTask } = await import("../worker.js");
  const continued = continueCurrentTask(ctx.from?.id);
  await safeAnswerCbQuery(ctx, continued ? "Task continued" : "No paused task");
  await ctx.reply(continued ? "▶️ Current task continued." : "ℹ️ There is no paused task right now.");
});

bot.command("stop", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  const { stopCurrentTask } = await import("../worker.js");
  const stopped = stopCurrentTask(ctx.from?.id);
  await ctx.reply(stopped ? "⏸️ Current task paused. Use /continue to resume." : "ℹ️ There is no active task right now.");
});

bot.command("continue", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  const { continueCurrentTask } = await import("../worker.js");
  const continued = continueCurrentTask(ctx.from?.id);
  await ctx.reply(continued ? "▶️ Current task continued." : "ℹ️ There is no paused task right now.");
});

bot.command("cancel", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  const { cancelCurrentTask } = await import("../worker.js");
  const cancelled = cancelCurrentTask(ctx.from?.id);
  await ctx.reply(cancelled ? "🛑 Current task cancellation requested." : "ℹ️ There is no task you can cancel right now.");
});

bot.action("cancel_task", async (ctx) => {
  const { cancelCurrentTask } = await import("../worker.js");
  const cancelled = cancelCurrentTask(ctx.from?.id);
  await safeAnswerCbQuery(ctx, cancelled ? "Cancellation requested" : "No task to cancel");
  if (cancelled) await ctx.reply("🛑 Current task is stopping safely. Temporary files will be cleaned up.");
});

bot.command("task", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  const { getCurrentTask } = await import("../worker.js");
  const task = getCurrentTask();
  if (!task) return ctx.reply("ℹ️ No task is currently running.");
  await ctx.reply(`📌 Current task: ${task.type}\n🔎 Query: ${task.query || "—"}\n${task.paused ? "⏸️ Status: paused" : "▶️ Status: running"}`);
});

// ── Post Now ────────────────────────────────────────────────────

async function runTriggerPostNow(ctx, channel) {
  if (!channel) return;
  await ctx.reply(`⏳ Posting now to *${channelLabel(channel)}*…`, { parse_mode: "Markdown" });
  try {
    const { runHourlyJob } = await import("../worker.js");
    await runHourlyJob(channel.chat_id);
    await ctx.reply(`✅ Done — check ${channelLabel(channel)}. If nothing posted, see /stats and logs.`);
  } catch (e) {
    logger.error({ error: e?.message }, "postnow failed");
    await ctx.reply(`❌ Failed: ${e.message?.slice(0, 300)}`);
  }
}

bot.command("postnow", async (ctx) => {
  if (ctx.chat?.type !== "private") {
    return ctx.reply("Use /postnow in private chat with the bot.");
  }
  const channel = await resolveTargetChannel(ctx, "trigger_postnow");
  if (channel) await runTriggerPostNow(ctx, channel);
});

bot.action("trigger_postnow", async (ctx) => {
  await safeAnswerCbQuery(ctx, "Choosing your channel…");
  const channel = await resolveTargetChannel(ctx, "trigger_postnow");
  if (channel) await runTriggerPostNow(ctx, channel);
});

// Text-command fallbacks for the search-result buttons, in case the
// inline keyboard doesn't render or a tap doesn't register.
bot.command("caption", async ctx => {
  if (ctx.chat?.type !== "private") {
    return ctx.reply("Use /caption in private chat with the bot.");
  }
  const id = findActiveBatchId(ctx.from.id);
  if (!id) {
    await ctx.reply(
      "❌ No search is waiting for a caption right now.\n\n" +
      "Run a search first — once results are ready, use /caption (or the ✍️ Caption All button) to set the caption for all of them."
    );
    return;
  }
  await handleBatchPublish(ctx, "custom", id);
});

// /post mirrors whichever "post now" button applies to your current
// context: if you have search results waiting, it posts them normally
// (same as 🖼️ Normal Posts); otherwise it behaves like /postnow.
bot.command("post", async ctx => {
  if (ctx.chat?.type !== "private") {
    return ctx.reply("Use /post in private chat with the bot.");
  }
  const id = findActiveBatchId(ctx.from.id);
  if (id) {
    await handleBatchPublish(ctx, "normal", id);
    return;
  }
  const channel = await resolveTargetChannel(ctx, "trigger_postnow");
  if (channel) await runTriggerPostNow(ctx, channel);
});

// ── Helpers ─────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

// ── Command handlers ────────────────────────────────────────────

// ── Admin controls ─────────────────────────────────────────────
bot.command("admin", async ctx => {
  if (!(await requireAdmin(ctx))) return;
  await ctx.reply(`🛠️ *${BRAND_SHORT} Admin Panel*\n\nMaintenance: ${getMaintenanceMode() ? "🔴 ON" : "🟢 OFF"}\nForce Join: ${FORCE_JOIN_ENABLED ? "🟢 ON" : "⚪ OFF"} (hard-coded)\nForce-join channels: ${FORCE_JOIN_CHANNELS.length}`, { parse_mode: "Markdown", ...adminKeyboard() });
});

bot.action("admin_maintenance", async ctx => {
  if (!(await requireAdmin(ctx))) return;
  const next = !getMaintenanceMode(); setMaintenanceMode(next);
  await safeAnswerCbQuery(ctx, next ? "Maintenance enabled" : "Maintenance disabled");
  await editMenuCard(ctx, `🛠️ *Admin Panel*\n\nMaintenance: ${next ? "🔴 ON" : "🟢 OFF"}\nForce Join: ${FORCE_JOIN_ENABLED ? "🟢 ON" : "⚪ OFF"} (hard-coded)\nForce-join channels: ${FORCE_JOIN_CHANNELS.length}`, { parse_mode: "Markdown", ...adminKeyboard() });
});

bot.action("admin_stats", async ctx => {
  if (!(await requireAdmin(ctx))) return;
  await safeAnswerCbQuery(ctx, "Loading stats…");
  try {
    const global = getStats();
    const channels = FORCE_JOIN_CHANNELS.length;
    const users = db.prepare("SELECT COUNT(DISTINCT user_id) AS c FROM posted_images WHERE user_id IS NOT NULL").get()?.c || 0;
    await ctx.reply(
      `📊 *Admin Stats*\\n\\n` +
      `📌 Total recorded posts: ${global.total || 0}\\n` +
      `👤 Active posting users: ${users}\\n` +
      `📢 Force-join channels: ${channels}\\n` +
      `🛠️ Maintenance: ${getMaintenanceMode() ? "ON" : "OFF"}\\n` +
      `🔒 Force Join: ${FORCE_JOIN_ENABLED ? "ON" : "OFF"} (hard-coded)`,
      { parse_mode: "Markdown", ...adminKeyboard() }
    );
  } catch (error) {
    logger.error({ error: error?.message }, "admin stats failed");
    await ctx.reply("❌ Could not load admin stats.", adminKeyboard());
  }
});

bot.action("admin_cleanup", async ctx => {
  if (!(await requireAdmin(ctx))) return;
  await safeAnswerCbQuery(ctx, "Cleaning temporary files…");
  try {
    const { cleanupDownloads } = await import("../utils/cleanup.js");
    await cleanupDownloads();
    await ctx.reply("🧹 Temporary download folder cleaned.", adminKeyboard());
  } catch (error) {
    logger.error({ error: error?.message }, "admin cleanup failed");
    await ctx.reply(`❌ Cleanup failed: ${error?.message || "Unknown error"}`, adminKeyboard());
  }
});

bot.action("admin_users", async ctx => {
  if (!(await requireAdmin(ctx))) return;
  await safeAnswerCbQuery(ctx);
  try {
    const total = countUsers();
    const active = countUsers({ includeBlocked: false });
    const recent = listUsers({ limit: 15 });
    const lines = recent.map(u => {
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || "—";
      const handle = u.username ? `@${u.username}` : "no username";
      const flag = u.is_blocked ? " 🚫" : "";
      return `• ${name} (${handle}) · id ${u.user_id}${flag}`;
    });
    await ctx.reply(
      `👥 *Users*\n\n` +
      `Total seen: ${total}\n` +
      `Reachable (not blocked): ${active}\n\n` +
      `Most recently active:\n${lines.join("\n") || "None yet."}`,
      { parse_mode: "Markdown", ...adminKeyboard() }
    );
  } catch (error) {
    logger.error({ error: error?.message }, "admin users failed");
    await ctx.reply("❌ Could not load user list.", adminKeyboard());
  }
});

bot.action("admin_broadcast", async ctx => {
  if (!(await requireAdmin(ctx))) return;
  await safeAnswerCbQuery(ctx);
  pendingBroadcast.set(ctx.chat.id, { started: Date.now() });
  await ctx.reply(
    `📢 *Broadcast*\n\n` +
    `Send me the message to broadcast now — text, photo, video, or anything else. ` +
    `It will be copied to every user who has used the bot (${countUsers({ includeBlocked: false })} reachable).\n\n` +
    `Send /cancel to abort.`,
    { parse_mode: "Markdown" }
  );
});

// ✅ JOINED / CHECK — always does a FRESH getChatMember check against every
// configured channel (never trusts the cache here), reports exactly which
// channels are still missing if any, and — once fully verified — resumes
// whatever the user was doing before Force Join interrupted them.
bot.action("force_join_check", async ctx => {
  await safeAnswerCbQuery(ctx, "Checking…");

  const status = await forceJoinStatus(ctx, { fresh: true });

  if (!status.ok) {
    try {
      await ctx.editMessageText(forceJoinMissingText(status.missing), {
        parse_mode: "Markdown",
        ...forceJoinKeyboard(status.missing)
      });
    } catch {
      await ctx.reply(forceJoinMissingText(status.missing), { parse_mode: "Markdown", ...forceJoinKeyboard(status.missing) });
    }
    return;
  }

  const welcomeText = `✅ *ALL CHANNELS VERIFIED*\n\n🌸 Welcome to ${BRAND_SHORT}!`;
  try {
    await ctx.editMessageText(welcomeText, { parse_mode: "Markdown" });
  } catch {
    await ctx.reply(welcomeText, { parse_mode: "Markdown" });
  }

  // Resume whatever triggered Force Join in the first place (a Pinterest
  // link, a button tap, a search query, ...) instead of making the user
  // redo it from scratch.
  const userId = ctx.from?.id;
  const resume = userId != null ? pendingResumeAfterJoin.get(userId) : null;
  if (resume) {
    pendingResumeAfterJoin.delete(userId);
    if (Date.now() - resume.savedAt <= FORCE_JOIN_RESUME_TIMEOUT_MS) {
      try {
        await bot.handleUpdate(resume.update);
      } catch (error) {
        logger.warn({ error: error?.message, userId }, "Resuming pending action after Force Join failed");
      }
      return;
    }
  }

  await ctx.reply(`🌸 *${BRAND}*\n\nWhat would you like to do?`, { parse_mode: "Markdown", ...MAIN_MENU });
});
bot.action("force_join_noop", async ctx => safeAnswerCbQuery(ctx));

bot.command("maintenance", async ctx => { if (!(await requireAdmin(ctx))) return; const arg = String(ctx.message.text || "").split(/\s+/)[1]?.toLowerCase(); if (["on","off"].includes(arg)) setMaintenanceMode(arg === "on"); await ctx.reply(`🛠️ Maintenance mode: ${getMaintenanceMode() ? "ON" : "OFF"}`, adminKeyboard()); });
// Force Join is hard-coded in src/config.js (FORCE_JOIN_ENABLED /
// FORCE_JOIN_CHANNELS) — this is deliberately read-only. There is no bot
// command or admin-panel control to change it; edit config.js and redeploy.
bot.command("forcejoin", async ctx => {
  if (!(await requireAdmin(ctx))) return;
  const lines = FORCE_JOIN_CHANNELS.map(c => `• ${forceJoinChannelLabel(c)} (${c.chatId})`);
  await ctx.reply(
    `🔒 Force Join: ${FORCE_JOIN_ENABLED ? "ON" : "OFF"} (hard-coded in config.js)\n` +
    `Channels: ${FORCE_JOIN_CHANNELS.length}\n${lines.join("\n")}`,
    adminKeyboard()
  );
});
bot.command("broadcast", async ctx => {
  if (!(await requireAdmin(ctx))) return;
  pendingBroadcast.set(ctx.chat.id, { started: Date.now() });
  await ctx.reply(`📢 Send me the message to broadcast now (${countUsers({ includeBlocked: false })} reachable). Send /cancel to abort.`);
});
bot.command("users", async ctx => {
  if (!(await requireAdmin(ctx))) return;
  await ctx.reply(`👥 Total seen: ${countUsers()}\nReachable: ${countUsers({ includeBlocked: false })}\n\nOpen /admin → 👥 Users for the recent list.`);
});

bot.start(async (ctx) => {
  const channels = listChannelsForUser(ctx.from.id);
  const status = channels.length
    ? `📡 You have *${channels.length}* channel${channels.length > 1 ? "s" : ""} connected.`
    : `📡 You haven't connected a channel yet — tap *➕ Add Channel* to get started.`;

  const caption =
    `🌸 *Welcome to ${BRAND}*\n\n` +
    `Your personal Pinterest → Telegram content assistant. ✨\n\n` +
    `${status}\n\n` +
    `Pick an option below 👇`;

  try {
    await sendMenuCard(ctx, caption, MAIN_MENU);
  } catch (error) {
    logger.warn({ error: error?.message }, "Start menu image failed; using text menu");
    await ctx.reply(caption, { parse_mode: "Markdown", ...MAIN_MENU });
  }
});

bot.command("ping", (ctx) => {
  if (ctx.chat?.type !== "private") return;
  ctx.reply("🏓 pong");
});

// Stats — total posts, last post, next scheduled
bot.command("stats", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  try {
    const active = getDefaultChannel(ctx.from.id);
    const stats = getStats({ userId: ctx.from.id, targetChatId: active?.chat_id || null });
    const global = getStats();
    const top = stats.categories.length ? stats.categories.map(x => `• ${x.category}: ${x.count}`).join("\n") : "• No posts yet";
    await ctx.reply(
      `📊 *Your Bloom Stats*\n` +
      `──────────────\n` +
      `Today: ${stats.today}\n` +
      `Last 7 days: ${stats.week}\n` +
      `Your recorded posts: ${stats.total}\n` +
      `All bot posts: ${global.total}\n` +
      `Last post: ${stats.last ? fmtDate(stats.last.created_at) : "—"}\n` +
      `Channel: ${active ? channelLabel(active) : "none connected"}\n\n` +
      `*Top categories*\n${top}`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    );
  } catch (err) {
    await ctx.reply("⚠️ Could not fetch stats.");
    logger.error({ error: err?.message }, "stats command error");
  }
});

// Last post — show the most recent post details
bot.command("last", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  try {
    const row = db.prepare(
      "SELECT pinterest_pin_id, category, query, caption, created_at, image_url FROM posted_images ORDER BY id DESC LIMIT 1"
    ).get();

    if (!row) {
      ctx.reply("📭 No posts yet.");
      return;
    }

    const text =
      `🖼️ Last Post\n` +
      `───────────\n` +
      `Category:  ${row.category}\n` +
      `Query:     ${row.query}\n` +
      `Pin ID:    ${row.pinterest_pin_id}\n` +
      `Caption:   ${row.caption || "—"}\n` +
      `Posted:    ${fmtDate(row.created_at)}`;

    ctx.reply(text);
  } catch (err) {
    ctx.reply("⚠️ Could not fetch last post.");
    logger.error({ error: err?.message }, "last command error");
  }
});

// List recent posts (last 5)
bot.command("list", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  try {
    const rows = db.prepare(
      "SELECT category, query, caption, created_at FROM posted_images ORDER BY id DESC LIMIT 5"
    ).all();

    if (!rows.length) {
      ctx.reply("📭 No posts yet.");
      return;
    }

    const lines = rows.map((r, i) =>
      `${i + 1}. ${fmtDate(r.created_at)} · ${r.category} · ${r.query}`
    );

    ctx.reply(`📋 Recent Posts\n──────────────\n${lines.join("\n")}`, MAIN_MENU);
  } catch (err) {
    ctx.reply("⚠️ Could not fetch post list.");
    logger.error({ error: err?.message }, "list command error");
  }
});

// Button / callback handlers
bot.action("info_schedule", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  await editMenuCard(ctx,
    `📅 Posting interval: every ${config.schedule.intervalSeconds / 60} minutes\n\nWhen you tap 🚀 Post Now, content is sent straight to your active channel.`,
    MORE_MENU
  );
});

bot.action("info_stats", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  try {
    const total = db.prepare("SELECT COUNT(*) AS c FROM posted_images").get().c;
    const active = getDefaultChannel(ctx.from.id);
    await editMenuCard(ctx,
      `📊 Stats\n───\nTotal posts: ${total}\nYour channel: ${active ? channelLabel(active) : "none connected yet"}\nInterval: ${config.schedule.intervalSeconds / 60} min`,
      MORE_MENU
    );
  } catch {
    await editMenuCard(ctx, "⚠️ Could not fetch stats.", MORE_MENU);
  }
});



async function sendMySchedules(ctx, page = 1) {
  const all = listScheduledPosts(ctx.from.id);
  if (!all.length) {
    await editMenuCard(ctx, "📋 *My Schedules*\n\nNo pending schedules. Use 📸 Next Post to create one.", MORE_MENU);
    return;
  }
  const { rows, pageItems } = paginatedRows(
    all,
    page,
    r => ({ text: `🗑️ #${r.id}`, callback_data: `schedule_cancel:${r.id}` }),
    "my_schedules"
  );
  const lines = pageItems.map(r => {
    const when = new Date(r.run_at).toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });
    return `#${r.id} · ${when} WAT\n🔎 ${r.query} · 🖼️ ${r.amount} · ${r.status}`;
  });
  rows.push([{ text: "⬅️ Back", callback_data: "open_more_menu" }]);
  await editMenuCard(ctx, `📋 *My Schedules*\n\n${lines.join("\\n\\n")}`, { reply_markup: { inline_keyboard: rows } });
}

bot.action(/^my_schedules(?::(\d+))?$/, async ctx => {
  await safeAnswerCbQuery(ctx);
  await sendMySchedules(ctx, Number(ctx.match[1]) || 1);
});

bot.action(/^schedule_cancel:(\d+)$/, async ctx => {
  const id = Number(ctx.match[1]);
  const result = cancelScheduledPost(ctx.from.id, id);
  await safeAnswerCbQuery(ctx, result.changes ? "Schedule cancelled" : "Schedule not found");
  await sendMySchedules(ctx, 1);
});

bot.action("settings", async ctx => {
  await safeAnswerCbQuery(ctx);
  const s = getUserSettings(ctx.from.id);
  await editMenuCard(ctx,
    `⚙️ *Settings*\n\n` +
    `🔔 Notifications: ${s.notifications ? "ON" : "OFF"}\n` +
    `🖼️ Album mode preference: ${s.album_mode ? "ON" : "OFF"}\n` +
    `📦 Max images per automatic post: ${s.max_images}\n\n` +
    `Use the buttons below to change your preferences.`,
    { reply_markup: { inline_keyboard: [
      [{ text: s.notifications ? "🔕 Turn notifications off" : "🔔 Turn notifications on", callback_data: "setting_notifications" }],
      [{ text: s.album_mode ? "🖼️ Album mode off" : "🖼️ Album mode on", callback_data: "setting_album" }],
      [{ text: "➖ Max images", callback_data: "setting_max_down" }, { text: "➕ Max images", callback_data: "setting_max_up" }],
      [{ text: "⬅️ Back", callback_data: "open_more_menu" }]
    ] } }
  );
});

async function refreshSettings(ctx) {
  const s = getUserSettings(ctx.from.id);
  await editMenuCard(ctx,
    `⚙️ *Settings*\n\n🔔 Notifications: ${s.notifications ? "ON" : "OFF"}\n🖼️ Album mode preference: ${s.album_mode ? "ON" : "OFF"}\n📦 Max images per automatic post: ${s.max_images}`,
    { reply_markup: { inline_keyboard: [
      [{ text: s.notifications ? "🔕 Turn notifications off" : "🔔 Turn notifications on", callback_data: "setting_notifications" }],
      [{ text: s.album_mode ? "🖼️ Album mode off" : "🖼️ Album mode on", callback_data: "setting_album" }],
      [{ text: "➖ Max images", callback_data: "setting_max_down" }, { text: "➕ Max images", callback_data: "setting_max_up" }],
      [{ text: "⬅️ Back", callback_data: "open_more_menu" }]
    ] } }
  );
}

bot.action("setting_notifications", async ctx => { const s = getUserSettings(ctx.from.id); updateUserSetting(ctx.from.id, "notifications", !s.notifications); await safeAnswerCbQuery(ctx, "Notification setting updated"); await refreshSettings(ctx); });
bot.action("setting_album", async ctx => { const s = getUserSettings(ctx.from.id); updateUserSetting(ctx.from.id, "album_mode", !s.album_mode); await safeAnswerCbQuery(ctx, "Album setting updated"); await refreshSettings(ctx); });
bot.action("setting_max_down", async ctx => { const s = getUserSettings(ctx.from.id); updateUserSetting(ctx.from.id, "max_images", Math.max(1, s.max_images - 1)); await safeAnswerCbQuery(ctx, "Maximum decreased"); await refreshSettings(ctx); });
bot.action("setting_max_up", async ctx => { const s = getUserSettings(ctx.from.id); updateUserSetting(ctx.from.id, "max_images", Math.min(100, s.max_images + 1)); await safeAnswerCbQuery(ctx, "Maximum increased"); await refreshSettings(ctx); });

bot.command("schedule", async ctx => {
  if (ctx.chat?.type !== "private") return;
  await ctx.reply("📋 Your pending schedules are below:");
  const rows = listScheduledPosts(ctx.from.id);
  if (!rows.length) return ctx.reply("No pending schedules. Use /nextpost to create one.");
  await ctx.reply(rows.map(r => `#${r.id} · ${new Date(r.run_at).toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" })} WAT\n🔎 ${r.query} · 🖼️ ${r.amount}`).join("\n\n"));
});

bot.command("settings", async ctx => {
  if (ctx.chat?.type !== "private") return;
  const s = getUserSettings(ctx.from.id);
  await ctx.reply(`⚙️ Settings\n\n🔔 Notifications: ${s.notifications ? "ON" : "OFF"}\n🖼️ Album mode: ${s.album_mode ? "ON" : "OFF"}\n📦 Max automatic images: ${s.max_images}\n\nOpen /menu → ✨ More → ⚙️ Settings to change them.`);
});

bot.command("nextpost", async ctx => {
  if (ctx.chat?.type !== "private") return;
  await ctx.reply("📸 Next Post\n\nChoose what you want to post:", nextPostCategoryKeyboard());
});

bot.command("research", async ctx => {
  if (ctx.chat?.type !== "private") return;
  pendingResearches.set(ctx.chat.id, Date.now());
  await ctx.reply("🔬 Send a topic or Pinterest search phrase to research.");
});

// Catch-all for unknown commands
bot.command("help", (ctx) => {
  ctx.reply(
    `🤖 *Available commands*\n\n` +
    `/start — Show menu\n` +
    `/addchannel — Connect a channel\n` +
    `/channels — Manage your channels\n` +
    `/postnow — Post immediately\n` +
    `/post — Post now (search results if waiting, otherwise same as /postnow)\n` +
    `/caption — Set the caption for a search's results, if one is waiting\n` +
    `📦 Bulk Search & Post — Search and bulk-post 10/25/50/100/all results\n` +
    `/stats — Your stats\n/schedule — Your pending schedules\n/settings — Your preferences\n/last — Most recent post\n/list — Last 5 posts\n` +
    `/help — Show commands\n/stop — Pause current task\n/continue — Resume paused task\n` +
    `/task — Current task status\n/menu — Show image menu\n/ping — Health check\n` +
    `/nextpost — Schedule the next post\n/research — Research Pinterest`,
    { parse_mode: "Markdown", ...MAIN_MENU }
  );
});

// ── Middleware ──────────────────────────────────────────────────

bot.catch((err) => {
  logger.error({ error: err?.message || String(err) }, "Telegram bot error");
});
