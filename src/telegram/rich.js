import { logger } from "../utils/logger.js";

/**
 * Telegram Rich Message compatibility layer.
 *
 * Bot API 10.1+ accepts explicit Rich Message blocks. Plain text is a
 * `paragraph` block (NOT `text`). This module keeps all rich-message
 * construction in one place so invalid block types don't leak into the bot.
 */
const DEFAULT_HEADER = process.env.RICH_HEADER || "🌸 Bloom Petal";

function clampHeadingSize(size) {
  const value = Number(size);
  return Number.isFinite(value) ? Math.min(6, Math.max(1, Math.trunc(value))) : 3;
}

function normalizeBlocks(blocks, { addHeader = true, header = DEFAULT_HEADER } = {}) {
  const safe = Array.isArray(blocks)
    ? blocks.flat(Infinity).filter(block => block && typeof block === "object" && !Array.isArray(block))
    : [];

  // Thinking is only valid for sendRichMessageDraft, not sendRichMessage.
  const withoutThinking = safe.filter(block => block.type !== "thinking");

  if (!addHeader || withoutThinking.some(block => block.type === "heading")) {
    return withoutThinking;
  }

  return [richHeader(header, 3), richDivider(), ...withoutThinking];
}

export async function sendRich(ctx, richMessage, fallback = null) {
  try {
    // reply_markup is NOT a rich block — Telegram has no "buttons" block type
    // in InputRichBlock. Inline keyboards travel as a normal top-level
    // sendRichMessage parameter, same as sendMessage.
    const { reply_markup, ...rest } = richMessage;
    const payload = { ...rest };
    if (Array.isArray(payload.blocks)) {
      payload.blocks = normalizeBlocks(payload.blocks);
    }

    const params = {
      chat_id: ctx.chat.id,
      rich_message: payload
    };
    if (reply_markup) params.reply_markup = reply_markup;

    return await ctx.telegram.callApi("sendRichMessage", params);
  } catch (error) {
    logger.warn({ error: error?.message }, "Rich message failed; using fallback");
    if (typeof fallback === "function") return fallback();
    throw error;
  }
}

export async function sendRichDraft(ctx, richMessage, draftId = 1) {
  try {
    // Drafts may use the special `thinking` block, so do not inject the
    // persistent header here.
    return await ctx.telegram.callApi("sendRichMessageDraft", {
      chat_id: ctx.chat.id,
      draft_id: draftId,
      rich_message: richMessage
    });
  } catch (error) {
    logger.debug({ error: error?.message }, "Rich message draft unavailable");
    return null;
  }
}

export function richPhoto(url) {
  return {
    type: "photo",
    photo: { type: "photo", media: String(url) }
  };
}

/** Rich section header. Telegram calls this block type `heading`. */
export function richHeader(text, size = 3) {
  return {
    type: "heading",
    text: String(text),
    size: clampHeadingSize(size)
  };
}

// Backwards-compatible alias used by the existing publisher.
export const richHeading = richHeader;

/** Plain text must be a paragraph block. */
export function richText(text) {
  return {
    type: "paragraph",
    text: String(text)
  };
}

export function richDivider() {
  return { type: "divider" };
}

/**
 * IMPORTANT: Telegram's Rich Message API has no "buttons" block type.
 * InputRichBlock is one of: paragraph, heading, preformatted, footer,
 * divider, mathematical_expression, anchor, list, block_quotation,
 * pull_quotation, collage, slideshow, table, details, map, animation,
 * audio, photo, video, voice_note, thinking. Buttons are never a block —
 * they go through the normal `reply_markup` parameter on sendRichMessage,
 * exactly like sendMessage. Build `{ inline_keyboard: rows }` and pass it
 * as `reply_markup` in the object given to sendRich(), not inside `blocks`.
 */
export function richButtons(rows) {
  const safeRows = (Array.isArray(rows) ? rows : [])
    .filter(row => Array.isArray(row) && row.length)
    .map(row => row.slice(0, 8).map(button => ({ ...button })));
  return { inline_keyboard: safeRows };
}

/**
 * Build a Telegram Rich Message table.
 *
 * `headers` is an array of column names and `rows` is an array of row arrays.
 * Header cells are marked with `is_header: true`, which gives Telegram a real
 * semantic table header instead of merely bold-looking text.
 */
export function richTable(headers = [], rows = [], options = {}) {
  const headerRow = Array.isArray(headers) ? headers.slice(0, 20) : [];
  const bodyRows = Array.isArray(rows) ? rows : [];
  const columnCount = headerRow.length || Math.min(
    20,
    bodyRows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0)
  );

  // RichBlockTableCell requires align + valign on every cell — Telegram
  // rejects the whole table block (and thus the whole message) if they're
  // missing. is_compact is not a field on InputRichBlockTable at all.
  const makeCell = (value, isHeader = false) => {
    const cell = {
      text: String(value ?? ""),
      align: isHeader ? "center" : "left",
      valign: "middle"
    };
    if (isHeader) cell.is_header = true;
    return cell;
  };

  const cells = [];
  if (headerRow.length) {
    cells.push(Array.from({ length: columnCount }, (_, index) =>
      makeCell(headerRow[index] ?? "", true)
    ));
  }

  for (const row of bodyRows) {
    if (!Array.isArray(row)) continue;
    cells.push(Array.from({ length: columnCount }, (_, index) =>
      makeCell(row[index] ?? "")
    ));
  }

  return {
    type: "table",
    cells,
    ...(options.bordered !== false ? { is_bordered: true } : {}),
    ...(options.striped ? { is_striped: true } : {}),
    ...(options.caption ? { caption: String(options.caption) } : {})
  };
}

export function keyboardToRichButtons(replyMarkup) {
  const rows = replyMarkup?.inline_keyboard || [];
  return rows
    .filter(row => Array.isArray(row))
    .map(row => row.map(button => ({
      text: String(button.text ?? ""),
      ...(button.url ? { url: button.url } : {}),
      ...(button.callback_data ? { callback_data: button.callback_data } : {}),
      ...(button.switch_inline_query ? { switch_inline_query: button.switch_inline_query } : {}),
      ...(button.switch_inline_query_current_chat
        ? { switch_inline_query_current_chat: button.switch_inline_query_current_chat }
        : {}),
      ...(button.copy_text ? { copy_text: button.copy_text } : {}),
      ...(button.web_app ? { web_app: button.web_app } : {}),
      ...(button.login_url ? { login_url: button.login_url } : {}),
      ...(button.style ? { style: button.style } : {})
    })));
}
