import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";

const databasePath = config.storage.databasePath;

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);

// Keep SQLite reliable on Render and other container hosts.
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS posted_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pinterest_pin_id TEXT NOT NULL,
    image_hash TEXT NOT NULL UNIQUE,
    image_url TEXT,
    source_url TEXT,
    category TEXT,
    query TEXT,
    caption TEXT,
    telegram_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'posted',
    target_chat_id TEXT,
    user_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_posted_images_created_at
    ON posted_images(created_at);

  CREATE INDEX IF NOT EXISTS idx_posted_images_pin_id
    ON posted_images(pinterest_pin_id);

  CREATE INDEX IF NOT EXISTS idx_posted_images_target
    ON posted_images(target_chat_id, created_at);

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    notifications INTEGER NOT NULL DEFAULT 1,
    album_mode INTEGER NOT NULL DEFAULT 0,
    max_images INTEGER NOT NULL DEFAULT 10,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS scheduled_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    query TEXT NOT NULL,
    amount INTEGER NOT NULL,
    run_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_scheduled_posts_due
    ON scheduled_posts(status, run_at);

  CREATE TABLE IF NOT EXISTS force_join_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL UNIQUE,
    username TEXT,
    title TEXT,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    username TEXT,
    title TEXT,
    is_verified INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, chat_id)
  );

  CREATE INDEX IF NOT EXISTS idx_channels_user
    ON channels(user_id);

  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_blocked INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_users_last_seen
    ON users(last_seen_at);
`);

// Older databases created before "channels" existed won't have this column
// on scheduled_posts. Add it defensively so upgrades don't crash.
try {
  db.exec(`ALTER TABLE scheduled_posts ADD COLUMN target_chat_id TEXT`);
} catch {
  // Column already exists — ignore.
}

// Safe migrations for databases created by older Bloom & Petal releases.
for (const statement of [
  `ALTER TABLE posted_images ADD COLUMN target_chat_id TEXT`,
  `ALTER TABLE posted_images ADD COLUMN user_id TEXT`
]) {
  try { db.exec(statement); } catch {}
}

const getStateStmt = db.prepare(
  "SELECT value FROM state WHERE key = ?"
);

const setStateStmt = db.prepare(`
  INSERT INTO state (key, value)
  VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

const hasHashStmt = db.prepare(
  "SELECT 1 FROM posted_images WHERE image_hash = ? LIMIT 1"
);

const hasPinStmt = db.prepare(
  "SELECT 1 FROM posted_images WHERE pinterest_pin_id = ? LIMIT 1"
);

const insertPostStmt = db.prepare(`
  INSERT INTO posted_images (
    pinterest_pin_id,
    image_hash,
    image_url,
    source_url,
    category,
    query,
    caption,
    telegram_message_id,
    status,
    target_chat_id,
    user_id
  ) VALUES (
    @pinterestPinId,
    @imageHash,
    @imageUrl,
    @sourceUrl,
    @category,
    @query,
    @caption,
    @telegramMessageId,
    @status,
    @targetChatId,
    @userId
  )
`);

export function getState(key) {
  const row = getStateStmt.get(key);
  return row?.value ?? null;
}

export function setState(key, value) {
  setStateStmt.run(key, value == null ? null : String(value));
}

export function hasImageHash(imageHash) {
  if (!imageHash) return false;
  return Boolean(hasHashStmt.get(imageHash));
}

export function hasPinterestPin(pinterestPinId) {
  if (!pinterestPinId) return false;
  return Boolean(hasPinStmt.get(String(pinterestPinId)));
}

export function recordPost(post) {
  if (!post || typeof post !== "object") {
    throw new TypeError("recordPost requires a post object");
  }

  return insertPostStmt.run({
    pinterestPinId: String(post.pinterestPinId ?? ""),
    imageHash: String(post.imageHash ?? ""),
    imageUrl: post.imageUrl ?? null,
    sourceUrl: post.sourceUrl ?? null,
    category: post.category ?? null,
    query: post.query ?? null,
    caption: post.caption ?? null,
    telegramMessageId:
      post.telegramMessageId == null ? null : String(post.telegramMessageId),
    status: post.status ?? "posted",
    targetChatId: post.targetChatId == null ? null : String(post.targetChatId),
    userId: post.userId == null ? null : String(post.userId)
  });
}

export function closeDatabase() {
  try {
    db.close();
  } catch {
    // Database may already be closed during shutdown.
  }
}


export function createScheduledPost({ userId, category, query, amount, runAt, targetChatId }) {
  const result = db.prepare(`
    INSERT INTO scheduled_posts (user_id, category, query, amount, run_at, status, target_chat_id)
    VALUES (@userId, @category, @query, @amount, @runAt, 'pending', @targetChatId)
  `).run({
    userId: String(userId),
    category: String(category),
    query: String(query),
    amount: Number(amount),
    runAt: String(runAt),
    targetChatId: targetChatId == null ? null : String(targetChatId)
  });
  return Number(result.lastInsertRowid);
}

export function getNextScheduledPost() {
  return db.prepare(`SELECT * FROM scheduled_posts WHERE status = 'pending' ORDER BY run_at ASC, id ASC LIMIT 1`).get() || null;
}

export function getDueScheduledPosts(nowIso = new Date().toISOString()) {
  return db.prepare(`SELECT * FROM scheduled_posts WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC, id ASC`).all(nowIso);
}

export function markScheduledPostRunning(id) {
  return db.prepare(`UPDATE scheduled_posts SET status = 'running' WHERE id = ? AND status = 'pending'`).run(id);
}

export function markScheduledPostDone(id) {
  return db.prepare(`UPDATE scheduled_posts SET status = 'done' WHERE id = ?`).run(id);
}

export function markScheduledPostPending(id) {
  return db.prepare(`UPDATE scheduled_posts SET status = 'pending' WHERE id = ?`).run(id);
}

// ── Per-user channels ───────────────────────────────────────────
// Each Telegram user can register one or more channels that the bot has
// been made an admin of. Posting flows let the user pick which of their
// verified channels a given post/search should go to.

export function addChannel({ userId, chatId, username, title }) {
  const existing = db.prepare(
    `SELECT id FROM channels WHERE user_id = ? AND chat_id = ?`
  ).get(String(userId), String(chatId));

  if (existing) {
    db.prepare(
      `UPDATE channels SET username = ?, title = ?, is_verified = 1 WHERE id = ?`
    ).run(username || null, title || null, existing.id);
    return existing.id;
  }

  const hasAny = db.prepare(
    `SELECT COUNT(*) AS c FROM channels WHERE user_id = ?`
  ).get(String(userId)).c;

  const result = db.prepare(`
    INSERT INTO channels (user_id, chat_id, username, title, is_verified, is_default)
    VALUES (@userId, @chatId, @username, @title, 1, @isDefault)
  `).run({
    userId: String(userId),
    chatId: String(chatId),
    username: username || null,
    title: title || null,
    isDefault: hasAny ? 0 : 1
  });

  return Number(result.lastInsertRowid);
}

export function listChannelsForUser(userId) {
  return db.prepare(
    `SELECT * FROM channels WHERE user_id = ? ORDER BY is_default DESC, added_at ASC`
  ).all(String(userId));
}

export function getChannelById(id) {
  return db.prepare(`SELECT * FROM channels WHERE id = ?`).get(Number(id));
}

export function getChannelForUser(userId, id) {
  return db.prepare(
    `SELECT * FROM channels WHERE id = ? AND user_id = ?`
  ).get(Number(id), String(userId));
}

export function getDefaultChannel(userId) {
  return (
    db.prepare(`SELECT * FROM channels WHERE user_id = ? AND is_default = 1 LIMIT 1`).get(String(userId)) ||
    db.prepare(`SELECT * FROM channels WHERE user_id = ? ORDER BY added_at ASC LIMIT 1`).get(String(userId)) ||
    null
  );
}

export function setDefaultChannel(userId, channelId) {
  const tx = db.transaction(() => {
    db.prepare(`UPDATE channels SET is_default = 0 WHERE user_id = ?`).run(String(userId));
    db.prepare(`UPDATE channels SET is_default = 1 WHERE id = ? AND user_id = ?`).run(Number(channelId), String(userId));
  });
  tx();
}

export function listAllVerifiedChannels() {
  return db.prepare(
    `SELECT DISTINCT chat_id, username, title FROM channels WHERE is_verified = 1`
  ).all();
}

export function deleteChannel(userId, channelId) {
  const channel = getChannelForUser(userId, channelId);
  const result = db.prepare(
    `DELETE FROM channels WHERE id = ? AND user_id = ?`
  ).run(Number(channelId), String(userId));

  // If the deleted channel was the default, promote the oldest remaining one.
  if (result.changes && channel?.is_default) {
    const next = db.prepare(
      `SELECT id FROM channels WHERE user_id = ? ORDER BY added_at ASC LIMIT 1`
    ).get(String(userId));
    if (next) setDefaultChannel(userId, next.id);
  }

  return result;
}


export function getStats({ userId = null, targetChatId = null, sinceDays = null } = {}) {
  const clauses = [];
  const params = {};
  if (userId != null) { clauses.push("user_id = @userId"); params.userId = String(userId); }
  if (targetChatId != null) { clauses.push("target_chat_id = @targetChatId"); params.targetChatId = String(targetChatId); }
  if (sinceDays != null) { clauses.push("created_at >= datetime('now', @since)"); params.since = `-${Math.max(0, Number(sinceDays) || 0)} days`; }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return {
    total: db.prepare(`SELECT COUNT(*) AS c FROM posted_images ${where}`).get(params).c,
    today: db.prepare(`SELECT COUNT(*) AS c FROM posted_images ${where ? where + " AND" : "WHERE"} created_at >= datetime('now','start of day')`).get(params).c,
    week: db.prepare(`SELECT COUNT(*) AS c FROM posted_images ${where ? where + " AND" : "WHERE"} created_at >= datetime('now','-7 days')`).get(params).c,
    last: db.prepare(`SELECT * FROM posted_images ${where} ORDER BY id DESC LIMIT 1`).get(params) || null,
    categories: db.prepare(`SELECT COALESCE(category,'unknown') AS category, COUNT(*) AS count FROM posted_images ${where} GROUP BY category ORDER BY count DESC LIMIT 8`).all(params)
  };
}

export function listRecentPosts({ limit = 10, userId = null, targetChatId = null } = {}) {
  const clauses = [];
  const params = { limit: Math.min(Math.max(Number(limit) || 10, 1), 50) };
  if (userId != null) { clauses.push("user_id = @userId"); params.userId = String(userId); }
  if (targetChatId != null) { clauses.push("target_chat_id = @targetChatId"); params.targetChatId = String(targetChatId); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM posted_images ${where} ORDER BY id DESC LIMIT @limit`).all(params);
}

export function listScheduledPosts(userId, { includeDone = false } = {}) {
  const statusClause = includeDone ? "" : "AND status IN ('pending','running')";
  return db.prepare(`SELECT * FROM scheduled_posts WHERE user_id = ? ${statusClause} ORDER BY run_at ASC, id ASC`).all(String(userId));
}

export function cancelScheduledPost(userId, id) {
  return db.prepare(`UPDATE scheduled_posts SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status IN ('pending','running')`).run(Number(id), String(userId));
}

export function getUserSettings(userId) {
  const existing = db.prepare(`SELECT * FROM user_settings WHERE user_id = ?`).get(String(userId));
  if (existing) return existing;
  db.prepare(`INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)`).run(String(userId));
  return db.prepare(`SELECT * FROM user_settings WHERE user_id = ?`).get(String(userId));
}

export function updateUserSetting(userId, key, value) {
  const allowed = new Set(['notifications', 'album_mode', 'max_images']);
  if (!allowed.has(key)) throw new Error(`Unsupported user setting: ${key}`);
  getUserSettings(userId);
  const numeric = key === 'max_images' ? Math.min(Math.max(Number(value) || 1, 1), 100) : (value ? 1 : 0);
  db.prepare(`UPDATE user_settings SET ${key} = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).run(numeric, String(userId));
  return getUserSettings(userId);
}


export function getMaintenanceMode() {
  return getState("maintenance_mode") === "true";
}

export function setMaintenanceMode(enabled) {
  setState("maintenance_mode", enabled ? "true" : "false");
}

export function getForceJoinEnabled() {
  return getState("force_join_enabled") === "true";
}

export function setForceJoinEnabled(enabled) {
  setState("force_join_enabled", enabled ? "true" : "false");
}

export function addForceJoinChannel({ chatId, username, title }) {
  const result = db.prepare(`
    INSERT INTO force_join_channels (chat_id, username, title)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET username=excluded.username, title=excluded.title
  `).run(String(chatId), username || null, title || null);
  return result;
}

export function listForceJoinChannels() {
  return db.prepare(`SELECT * FROM force_join_channels ORDER BY added_at ASC`).all();
}

export function deleteForceJoinChannel(id) {
  return db.prepare(`DELETE FROM force_join_channels WHERE id = ?`).run(Number(id));
}

// ── Users (for admin visibility + broadcast) ───────────────────
// Recorded on every update we see from a private chat, regardless of
// whether the user has ever posted or configured anything, so admins can
// see the bot's actual reach and broadcast to everyone who has used it.

const upsertUserStmt = db.prepare(`
  INSERT INTO users (user_id, username, first_name, last_name)
  VALUES (@userId, @username, @firstName, @lastName)
  ON CONFLICT(user_id) DO UPDATE SET
    username = excluded.username,
    first_name = excluded.first_name,
    last_name = excluded.last_name,
    last_seen_at = CURRENT_TIMESTAMP,
    is_blocked = 0
`);

export function recordUser({ id, username, firstName, lastName } = {}) {
  if (id == null) return;
  upsertUserStmt.run({
    userId: String(id),
    username: username || null,
    firstName: firstName || null,
    lastName: lastName || null
  });
}

export function countUsers({ includeBlocked = true } = {}) {
  const where = includeBlocked ? "" : "WHERE is_blocked = 0";
  return db.prepare(`SELECT COUNT(*) AS c FROM users ${where}`).get().c;
}

export function listUsers({ limit = 20, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  return db.prepare(
    `SELECT * FROM users ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`
  ).all(safeLimit, safeOffset);
}

// Every non-blocked user, oldest first — the broadcast send order.
export function listAllUserIds() {
  return db.prepare(
    `SELECT user_id FROM users WHERE is_blocked = 0 ORDER BY first_seen_at ASC`
  ).all().map(row => row.user_id);
}

export function markUserBlocked(userId) {
  return db.prepare(`UPDATE users SET is_blocked = 1 WHERE user_id = ?`).run(String(userId));
}
