import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import axios from "axios";
import { config } from "../config.js";
import { withRetry } from "../utils/retry.js";

fs.mkdirSync(config.storage.downloadDir, { recursive: true });

function extensionFromContentType(type = "") {
  const clean = type.split(";")[0].toLowerCase();
  if (clean === "image/png") return ".png";
  if (clean === "image/webp") return ".webp";
  if (clean === "image/gif") return ".gif";
  if (clean === "image/jpeg" || clean === "image/jpg") return ".jpg";
  return ".bin";
}

export function pickImageUrl(pin) {
  return (
    pin?.image ||
    pin?.image_url ||
    pin?.imageUrl ||
    pin?.media?.images?.orig?.url ||
    pin?.media?.images?.originals?.url ||
    pin?.media?.images?.["1200x"]?.url ||
    pin?.media?.images?.["736x"]?.url ||
    pin?.media?.images?.["564x"]?.url ||
    pin?.image?.original?.url ||
    pin?.image?.url ||
    null
  );
}

export function pickSourceUrl(pin) {
  return pin?.pin_url || pin?.pinUrl || pin?.link || pin?.url || null;
}

// Pinterest pin payloads (official API and the rebix fallback both) vary in
// shape for video pins. Try every layout seen in the wild, preferring a
// direct progressive MP4 over an HLS (.m3u8) manifest, since Telegram's
// sendVideo needs an actual file, not a stream playlist.
const VIDEO_QUALITY_PREFERENCE = [
  "V_720P", "V_EXP7", "V_HLSV4", "V_HLSV3_MOBILE", "V_480P",
  "720p", "480p", "original"
];

function firstMp4Url(videoList) {
  if (!videoList || typeof videoList !== "object") return null;

  for (const key of VIDEO_QUALITY_PREFERENCE) {
    const url = videoList[key]?.url;
    if (url && !url.includes(".m3u8")) return url;
  }

  const values = Object.values(videoList).filter(v => v?.url);
  const mp4 = values.find(v => !v.url.includes(".m3u8"));
  if (mp4) return mp4.url;

  // Nothing progressive found — fall back to whatever is there (may be HLS,
  // which downloadVideo will reject cleanly rather than mis-handle).
  return values[0]?.url || null;
}

export function pickVideoUrl(pin) {
  const videoList =
    pin?.videos?.video_list ||
    pin?.media?.videos?.video_list ||
    pin?.media?.video_list ||
    pin?.video?.video_list ||
    null;

  const fromList = firstMp4Url(videoList);
  if (fromList) return fromList;

  return (
    pin?.video_url ||
    pin?.videoUrl ||
    pin?.media?.video_url ||
    (typeof pin?.media?.url === "string" && pin?.media?.media_type === "video" ? pin.media.url : null) ||
    null
  );
}

export function isVideoPin(pin) {
  return Boolean(
    pin?.media?.media_type === "video" ||
    pin?.type === "video" ||
    pin?.pin_type === "video" ||
    pickVideoUrl(pin)
  );
}

export async function downloadVideo(url) {
  return withRetry(async () => {
    if (String(url).includes(".m3u8")) {
      throw new Error("Video is HLS-only (no progressive MP4 available) — cannot download directly");
    }

    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 30000,
      maxContentLength: config.content.maxVideoBytes,
      maxBodyLength: config.content.maxVideoBytes,
      validateStatus: s => s >= 200 && s < 300
    });

    const contentType = response.headers["content-type"] || "";
    if (!contentType.toLowerCase().startsWith("video/") && !url.toLowerCase().endsWith(".mp4")) {
      throw new Error(`URL did not return a video: ${contentType}`);
    }

    const bytes = Buffer.from(response.data);
    if (bytes.length > config.content.maxVideoBytes) {
      throw new Error("Video exceeds configured download limit");
    }

    const id = crypto.randomUUID();
    const output = path.join(config.storage.downloadDir, `${id}.mp4`);

    fs.writeFileSync(output, bytes);

    return {
      path: output,
      bytes: bytes.length,
      contentType: contentType || "video/mp4"
    };
  }, {
    retries: Math.min(config.content.maxRetries, 2),
    shouldRetry: error => !error.response || error.response.status >= 500 || error.code === "ECONNABORTED"
  });
}

export async function downloadImage(url) {
  return withRetry(async () => {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 15000,
      maxContentLength: config.content.maxDownloadBytes,
      maxBodyLength: config.content.maxDownloadBytes,
      validateStatus: s => s >= 200 && s < 300
    });

    const contentType = response.headers["content-type"] || "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new Error(`URL did not return an image: ${contentType}`);
    }

    const bytes = Buffer.from(response.data);
    if (bytes.length > config.content.maxDownloadBytes) {
      throw new Error("Image exceeds configured download limit");
    }

    const id = crypto.randomUUID();
    const extension = extensionFromContentType(contentType);
    const output = path.join(config.storage.downloadDir, `${id}${extension}`);

    fs.writeFileSync(output, bytes);

    return {
      path: output,
      bytes: bytes.length,
      contentType
    };
  }, {
    retries: Math.min(config.content.maxRetries, 2),
    shouldRetry: error => !error.response || error.response.status >= 500 || error.code === "ECONNABORTED"
  });
}
