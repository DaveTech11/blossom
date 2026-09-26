import { getCandidates } from "./pinterest/search.js";
import { searchPins, resolvePinByUrl } from "./pinterest/client.js";
import { filterCandidates, filterVideoCandidates } from "./images/filter.js";
import {
  downloadImage,
  downloadVideo,
  pickImageUrl,
  pickSourceUrl,
  pickVideoUrl,
  isVideoPin
} from "./pinterest/downloader.js";
import {
  inspectImage,
  processImage,
  sha256,
  cleanupFiles
} from "./images/processor.js";
import { generateCaption } from "./captions/generator.js";
import { publish, publishVideo } from "./telegram/publisher.js";
import { config } from "./config.js";
import { hasImageHash, recordPost, listAllVerifiedChannels } from "./database/database.js";
import { logger } from "./utils/logger.js";


// ── Global task controls ───────────────────────────────────────
let activeTask = null;

class TaskCancelledError extends Error {
  constructor() { super("Task cancelled by user"); this.name = "TaskCancelledError"; }
}

function beginTask(type, query = null, ownerId = null) {
  if (activeTask) throw new Error(`A ${activeTask.type} task is already running.`);
  activeTask = { type, query, ownerId: ownerId == null ? null : String(ownerId), paused: false, cancelled: false, startedAt: Date.now() };
}

function finishTask() {
  activeTask = null;
}

async function waitIfPaused() {
  if (activeTask?.cancelled) throw new TaskCancelledError();
  while (activeTask?.paused) {
    if (activeTask?.cancelled) throw new TaskCancelledError();
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (activeTask?.cancelled) throw new TaskCancelledError();
}

async function pauseAwareDelay(ms) {
  let remaining = ms;
  while (remaining > 0) {
    await waitIfPaused();
    const slice = Math.min(1000, remaining);
    await new Promise(resolve => setTimeout(resolve, slice));
    remaining -= slice;
  }
}

export function stopCurrentTask(ownerId = null) {
  if (!activeTask) return false;
  if (ownerId != null && activeTask.ownerId && String(ownerId) !== activeTask.ownerId) return false;
  activeTask.paused = true;
  logger.info({ type: activeTask.type, query: activeTask.query }, "Current task paused");
  return true;
}

export function cancelCurrentTask(ownerId = null) {
  if (!activeTask) return false;
  if (ownerId != null && activeTask.ownerId && String(ownerId) !== activeTask.ownerId) return false;
  activeTask.cancelled = true;
  activeTask.paused = false;
  logger.info({ type: activeTask.type, query: activeTask.query }, "Current task cancelled");
  return true;
}

export function continueCurrentTask(ownerId = null) {
  if (!activeTask) return false;
  if (ownerId != null && activeTask.ownerId && String(ownerId) !== activeTask.ownerId) return false;
  activeTask.paused = false;
  logger.info({ type: activeTask.type, query: activeTask.query }, "Current task continued");
  return true;
}

export function getCurrentTask() {
  return activeTask ? { ...activeTask } : null;
}

function selectDiverse(candidates, count) {
  const sorted = [...candidates].sort(() => Math.random() - 0.5);
  const selected = [];
  const seenStyles = new Set();

  for (const candidate of sorted) {
    const style = candidate.classification?.label || "other";
    if (seenStyles.has(style) && selected.length < count) continue;
    selected.push(candidate);
    seenStyles.add(style);
    if (selected.length >= count) break;
  }

  for (const candidate of sorted) {
    if (selected.includes(candidate)) continue;
    selected.push(candidate);
    if (selected.length >= count) break;
  }

  return selected;
}

async function prepareCandidate(candidate, category, query) {
  let rawPath;
  let processedPath;

  try {
    const downloaded = await downloadImage(candidate.imageUrl);
    rawPath = downloaded.path;
    await inspectImage(rawPath);
    processedPath = await processImage(rawPath);
    const hash = await sha256(processedPath);

    if (hasImageHash(hash)) return null;

    return {
      ...candidate,
      category,
      query,
      imageHash: hash,
      filePath: processedPath,
      rawPath,
      caption: generateCaption({
        category,
        classification: candidate.classification,
        pin: candidate.pin,
        query
      })
    };
  } catch (error) {
    logger.warn({ error: error.message, imageUrl: candidate.imageUrl }, "Candidate rejected during download/processing");
    await cleanupFiles(rawPath, processedPath);
    return null;
  }
}

async function publishPrepared(prepared, category, query, targetChatId, userId = null) {
  let posted = 0;

  // Telegram supports up to 10 photos in one media group. Send search
  // results as albums instead of one message per image.
  const BATCH_SIZE = 10;

  for (let start = 0; start < prepared.length; start += BATCH_SIZE) {
    await waitIfPaused();
    const batch = prepared.slice(start, start + BATCH_SIZE);

    try {
      const results = await publish(batch, targetChatId);
      const telegramResults = Array.isArray(results)
        ? results
        : (results ? [results] : []);

      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        const telegramMessage = telegramResults[i];
        const messageId = telegramMessage?.message_id
          ? String(telegramMessage.message_id)
          : null;

        recordPost({
          pinterestPinId: String(
            item.pin?.id ||
            item.pin?.pin_id ||
            item.pin?.pinId ||
            item.pin?.pin_url ||
            item.pin?.url ||
            `manual-${item.imageHash}`
          ),
          imageHash: item.imageHash,
          imageUrl: item.imageUrl,
          sourceUrl: item.sourceUrl,
          category,
          query,
          caption: item.caption,
          telegramMessageId: messageId,
          status: "posted",
          targetChatId,
          userId
        });

        posted++;
      }

      for (const item of batch) {
        await cleanupFiles(item.filePath, item.rawPath);
      }

      logger.info(
        { query, batchSize: batch.length, posted, total: prepared.length },
        "Manual search album posted"
      );

      // Pause 1 minute between albums. Images inside an album arrive together.
      if (start + BATCH_SIZE < prepared.length) {
        await pauseAwareDelay(60000);
      }
    } catch (error) {
      logger.warn(
        { error: error?.message, query, batchSize: batch.length },
        "Manual search album failed; continuing"
      );

      for (const item of batch) {
        await cleanupFiles(item.filePath, item.rawPath);
      }
    }
  }

  return posted;
}

export async function runScheduledPostJob({ category, query, amount, targetChatId, userId }) {
  const count = Math.min(Math.max(Number(amount) || 1, 1), 100);
  const startedAt = Date.now();
  beginTask("scheduled-next-post", query, null);

  try {
    const items = await searchPins(query);
    if (!items.length) return { query, found: 0, posted: 0 };

    const candidates = filterCandidates(items, category || "scheduled");
    const prepared = [];

    for (const candidate of candidates) {
      await waitIfPaused();
      const item = await prepareCandidate(candidate, category || "scheduled", query);
      if (item) prepared.push(item);
      if (prepared.length >= count) break;
    }

    const posted = await publishPrepared(prepared, category || "scheduled", query, targetChatId, userId);
    logger.info({ category, query, requested: count, found: items.length, posted, elapsedMs: Date.now() - startedAt }, "Scheduled next post completed");
    return { query, found: items.length, posted, requested: count };
  } finally {
    finishTask();
  }
}

// Resolves who the unattended hourly job should post to. With no explicit
// channel, it broadcasts to every channel anyone has connected through the
// bot's ➕ Add Channel flow — no .env editing required. The legacy
// TELEGRAM_CHANNEL_ID (if still set) is included too, for backward compat.
function resolveAutoChannelIds(targetChatId) {
  if (targetChatId) return [String(targetChatId)];

  const ids = new Set(listAllVerifiedChannels().map(c => String(c.chat_id)));
  if (config.telegram.channelId) ids.add(String(config.telegram.channelId));
  return [...ids];
}

// Posts one already-prepared batch to several channels, recording history
// once (dedupe is global, not per-channel) and only cleaning up temp files
// after every channel has had a chance to receive the batch.
async function publishToChannels(prepared, category, query, channelIds) {
  let posted = 0;
  const BATCH_SIZE = 10;

  for (let start = 0; start < prepared.length; start += BATCH_SIZE) {
    await waitIfPaused();
    const batch = prepared.slice(start, start + BATCH_SIZE);
    let recorded = false;

    for (const chatId of channelIds) {
      try {
        const results = await publish(batch, chatId);
        const telegramResults = Array.isArray(results) ? results : (results ? [results] : []);

        if (!recorded) {
          for (let i = 0; i < batch.length; i++) {
            const item = batch[i];
            recordPost({
              pinterestPinId: String(
                item.pin?.id || item.pin?.pin_id || item.pin?.pinId ||
                item.pin?.pin_url || item.pin?.url || `manual-${item.imageHash}`
              ),
              imageHash: item.imageHash,
              imageUrl: item.imageUrl,
              sourceUrl: item.sourceUrl,
              category,
              query,
              caption: item.caption,
              telegramMessageId: telegramResults[i]?.message_id ? String(telegramResults[i].message_id) : null,
              status: "posted",
              targetChatId: channelIds[0]
            });
          }
          recorded = true;
          posted += batch.length;
        }
      } catch (error) {
        logger.warn({ error: error?.message, chatId, batchSize: batch.length }, "Broadcast to a channel failed; continuing with the rest");
      }
    }

    for (const item of batch) {
      await cleanupFiles(item.filePath, item.rawPath);
    }

    if (start + BATCH_SIZE < prepared.length) {
      await pauseAwareDelay(60000);
    }
  }

  return posted;
}

export async function runHourlyJob(targetChatId) {
  const startedAt = Date.now();

  try {
    beginTask("scheduled-post", null, null);

    const channelIds = resolveAutoChannelIds(targetChatId);
    if (!channelIds.length) {
      logger.info("No channels connected yet — skipping auto post. Users can connect one via ➕ Add Channel.");
      return 0;
    }

    await waitIfPaused();
    const { category, query, items } = await getCandidates();

    if (!items.length) {
      logger.warn({ category, query }, "Pinterest returned no candidates");
      return 0;
    }

    const candidates = filterCandidates(items, category);
    if (!candidates.length) {
      logger.warn({ category, query }, "No candidates passed filters");
      return 0;
    }

    const hourlyCount = Math.min(config.content.imagesPerPost, 100);
    const selected = selectDiverse(candidates, Math.min(candidates.length, hourlyCount));
    const prepared = [];

    for (const candidate of selected) {
      await waitIfPaused();
      const item = await prepareCandidate(candidate, category, query);
      if (item) prepared.push(item);
      if (prepared.length >= hourlyCount) break;
    }

    if (!prepared.length) {
      logger.warn({ category, query }, "No images survived processing");
      return 0;
    }

    await waitIfPaused();
    const posted = await publishToChannels(prepared.slice(0, hourlyCount), category, query, channelIds);

    logger.info({ category, query, count: prepared.length, channels: channelIds.length, elapsedMs: Date.now() - startedAt }, "Hourly post completed");
    return posted;
  } catch (error) {
    if (error?.name === "TaskCancelledError") {
      logger.info("Hourly task cancelled");
      return 0;
    }
    logger.error({ error: error?.stack || error?.message || String(error), elapsedMs: Date.now() - startedAt }, "Hourly job failed; scheduler will continue");
    return 0;
  } finally {
    finishTask();
  }
}

// ── Video Search (🎥) ───────────────────────────────────────────
// Unlike the image flows, video results are shown as a pick-one list first
// (no download yet) and only the video the user actually taps gets pulled
// down and posted — one video per search, by design.

export async function searchVideoCandidates(exactQuery) {
  const query = String(exactQuery || "").trim();
  if (!query) throw new Error("Search word cannot be empty");

  logger.info({ query }, "Manual Pinterest video search");
  const items = await searchPins(query);
  const candidates = filterVideoCandidates(items, "video-search");

  return { query, found: items.length, candidates };
}

export async function preparePickedVideo(candidate, query) {
  let rawPath;

  try {
    const downloaded = await downloadVideo(candidate.videoUrl);
    rawPath = downloaded.path;
    const hash = await sha256(rawPath);

    if (hasImageHash(hash)) {
      await cleanupFiles(rawPath);
      throw new Error("This video was already posted before");
    }

    return {
      ...candidate,
      imageUrl: candidate.videoUrl,
      query,
      imageHash: hash,
      filePath: rawPath,
      rawPath,
      caption: generateCaption({
        category: "video-search",
        classification: candidate.classification,
        pin: candidate.pin,
        query
      })
    };
  } catch (error) {
    await cleanupFiles(rawPath);
    throw error;
  }
}

export async function publishPickedVideo(prepared, targetChatId, userId = null) {
  beginTask("video-search", prepared.query, userId);
  try {
    const result = await publishVideo(prepared, targetChatId);
    const messageId = result?.message_id ? String(result.message_id) : null;

    recordPost({
      pinterestPinId: String(
        prepared.pin?.id || prepared.pin?.pin_id || prepared.pin?.pinId ||
        prepared.pin?.pin_url || prepared.pin?.url || `manual-video-${prepared.imageHash}`
      ),
      imageHash: prepared.imageHash,
      imageUrl: prepared.videoUrl,
      sourceUrl: prepared.sourceUrl,
      category: "video-search",
      query: prepared.query,
      caption: prepared.caption,
      telegramMessageId: messageId,
      status: "posted",
      targetChatId,
      userId
    });

    return { posted: true, messageId };
  } finally {
    await cleanupFiles(prepared.filePath, prepared.rawPath);
    finishTask();
  }
}

export async function runSearchPostJob(exactQuery, onProgress = null, bulkLimit = 0, onReady = null, targetChatId = null, ownerId = null, options = {}) {
  const query = String(exactQuery || "").trim();
  if (!query) throw new Error("Search word cannot be empty");

  const startedAt = Date.now();
  beginTask("search-post", query, ownerId);

  try {
    logger.info({ query }, "Manual Pinterest search");
    await waitIfPaused();

    const items = await searchPins(query);
    if (!items.length) return { query, found: 0, posted: 0 };

    const candidates = filterCandidates(items, "manual-search");
    if (!candidates.length) return { query, found: items.length, accepted: 0, posted: 0 };

    const limit = Number.isFinite(Number(bulkLimit)) && Number(bulkLimit) > 0 ? Number(bulkLimit) : 0;
    const target = limit || candidates.length;

    const prepared = [];
    let attempted = 0;
    for (const candidate of candidates) {
      if (prepared.length >= target) break;
      await waitIfPaused();
      attempted++;
      const item = await prepareCandidate(candidate, "manual-search", query);
      if (item) prepared.push(item);
      if (onProgress) {
        await onProgress({
          phase: "preparing",
          current: attempted,
          total: candidates.length,
          prepared: prepared.length,
          target
        });
      }
    }

    await waitIfPaused();

    // Search UI can now decide how the whole result set should be published:
    // album, normal one-by-one posts, or a custom caption applied to every image.
    if (typeof onReady === "function") {
      const posted = await onReady(prepared);
      return { query, found: items.length, accepted: candidates.length, attempted, prepared: prepared.length, posted: Number(posted) || 0 };
    }

    const posted = await publishPrepared(prepared, "manual-search", query, targetChatId, ownerId);

    logger.info({ query, found: items.length, accepted: candidates.length, attempted, prepared: prepared.length, posted, elapsedMs: Date.now() - startedAt }, "Manual search post completed");
    return { query, found: items.length, accepted: candidates.length, attempted, prepared: prepared.length, posted };
  } catch (error) {
    if (error?.name === "TaskCancelledError") {
      logger.info({ query }, "Manual search task cancelled");
      return { query, cancelled: true, found: 0, posted: 0 };
    }
    throw error;
  } finally {
    finishTask();
  }
}

// ── Direct Pinterest link processing ─────────────────────────────
// Triggered when a user pastes a Pinterest pin URL directly instead of
// going through Search — resolves exactly that pin and prepares it through
// the same download/process pipeline every other flow already uses.
// Returns { type: "image" | "video" | "album", items: [preparedItem, ...] }

async function prepareDirectImage(imageUrl, pin, sourceUrl) {
  let rawPath;
  let processedPath;

  try {
    const downloaded = await downloadImage(imageUrl);
    rawPath = downloaded.path;
    await inspectImage(rawPath);
    processedPath = await processImage(rawPath);
    const hash = await sha256(processedPath);

    return {
      pin,
      sourceUrl,
      imageUrl,
      imageHash: hash,
      filePath: processedPath,
      rawPath,
      caption: generateCaption({ category: "direct-link", pin, query: "" })
    };
  } catch (error) {
    logger.warn({ error: error.message, imageUrl }, "Direct pin image rejected during download/processing");
    await cleanupFiles(rawPath, processedPath);
    return null;
  }
}

// Idea/Story Pins can carry several image pages — surfaced as an album.
function storyPinImageUrls(pin) {
  const pages = pin?.story_pin_data?.pages;
  if (!Array.isArray(pages) || pages.length < 2) return [];

  return pages
    .map(page =>
      page?.image?.images?.originals?.url ||
      page?.image?.images?.["1200x"]?.url ||
      page?.image?.image?.url ||
      page?.image?.url ||
      null
    )
    .filter(Boolean);
}

export async function resolveDirectPinterestUrl(url) {
  const pin = await resolvePinByUrl(url);
  if (!pin) {
    throw new Error("Could not find that Pinterest Pin. It may be private, deleted, or unavailable.");
  }

  const sourceUrl = pickSourceUrl(pin) || url;

  if (isVideoPin(pin)) {
    const videoUrl = pickVideoUrl(pin);
    if (!videoUrl) {
      throw new Error("This Pin's video could not be found (no direct video file available).");
    }

    let rawPath;
    try {
      const downloaded = await downloadVideo(videoUrl);
      rawPath = downloaded.path;
      const hash = await sha256(rawPath);

      return {
        type: "video",
        items: [{
          pin,
          sourceUrl,
          videoUrl,
          imageUrl: videoUrl,
          imageHash: hash,
          filePath: rawPath,
          rawPath,
          caption: generateCaption({ category: "direct-link", pin, query: "" })
        }]
      };
    } catch (error) {
      await cleanupFiles(rawPath);
      throw new Error(`Could not download this Pin's video: ${error?.message || "unknown error"}`);
    }
  }

  const storyUrls = storyPinImageUrls(pin);
  if (storyUrls.length > 1) {
    const items = [];
    for (const imageUrl of storyUrls) {
      const prepared = await prepareDirectImage(imageUrl, pin, sourceUrl);
      if (prepared) items.push(prepared);
    }
    if (items.length > 1) return { type: "album", items };
    if (items.length === 1) return { type: "image", items };
    // Fall through to the single-image path below if none of the pages
    // could actually be downloaded/processed.
  }

  const imageUrl = pickImageUrl(pin);
  if (!imageUrl) {
    throw new Error("This Pin's media could not be found or is unsupported.");
  }

  const prepared = await prepareDirectImage(imageUrl, pin, sourceUrl);
  if (!prepared) {
    throw new Error("Could not download or process this Pin's image.");
  }

  return { type: "image", items: [prepared] };
}
