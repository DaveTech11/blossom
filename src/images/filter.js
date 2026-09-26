import { config } from "../config.js";
import { hasImageHash, hasPinterestPin } from "../database/database.js";
import { pickImageUrl, pickSourceUrl, pickVideoUrl, isVideoPin } from "../pinterest/downloader.js";
import { classifyPin } from "./classifier.js";

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function sourceAllowed(sourceUrl) {
  if (!config.content.requireSourceLink) return true;
  if (!sourceUrl) return false;

  if (!config.content.licensedDomains.length) return true;

  const host = hostnameOf(sourceUrl);
  return Boolean(host && config.content.licensedDomains.some(
    domain => host === domain || host.endsWith(`.${domain}`)
  ));
}

function looksSponsored(pin) {
  return Boolean(
    pin?.is_promoted ||
    pin?.promoted ||
    pin?.ad_data ||
    pin?.is_promoted_pin
  );
}

export function candidateInfo(pin, category) {
  const imageUrl = pickImageUrl(pin);
  const sourceUrl = pickSourceUrl(pin);
  const classification = classifyPin(pin, category);

  return {
    pin,
    imageUrl,
    sourceUrl,
    classification
  };
}

// Video results for the 🎥 Video Search flow. Unlike filterCandidates this
// doesn't dedupe against the image-hash table (nothing's downloaded yet at
// this point — the user still has to pick exactly one from the list) and
// keeps the pin's thumbnail so results can be shown before anything downloads.
export function filterVideoCandidates(items, category = "video-search") {
  const accepted = [];

  for (const pin of items) {
    if (!isVideoPin(pin)) continue;

    const pinId = pin?.id || pin?.pin_id || pin?.pinId || pin?.pin_url || pin?.url;
    if (!pinId) continue;
    if (hasPinterestPin(String(pinId))) continue;

    if (config.content.skipSponsored && looksSponsored(pin)) continue;

    const videoUrl = pickVideoUrl(pin);
    if (!videoUrl) continue;

    const sourceUrl = pickSourceUrl(pin);
    if (!sourceAllowed(sourceUrl)) continue;

    accepted.push({
      pin,
      videoUrl,
      sourceUrl,
      thumbnailUrl: pickImageUrl(pin),
      classification: classifyPin(pin, category),
      title: pin?.title || pin?.grid_title || pin?.alt_text || null
    });

    if (accepted.length >= config.content.videoResultsPerQuery) break;
  }

  return accepted;
}

export function filterCandidates(items, category) {
  const accepted = [];

  for (const pin of items) {
    const pinId = pin?.id || pin?.pin_id || pin?.pinId || pin?.pin_url || pin?.url;
    if (!pinId) continue;
    if (hasPinterestPin(String(pinId))) continue;

    if (config.content.skipSponsored && looksSponsored(pin)) {
      continue;
    }

    const candidate = candidateInfo(pin, category);

    if (!candidate.imageUrl) continue;
    if (!sourceAllowed(candidate.sourceUrl)) continue;

    accepted.push(candidate);
  }

  return accepted;
}
