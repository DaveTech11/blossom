import axios from "axios";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const officialApi = axios.create({
  baseURL: config.pinterest.baseUrl,
  timeout: 12000,
  headers: {
    Authorization: config.pinterest.accessToken
      ? `Bearer ${config.pinterest.accessToken}`
      : undefined,
    Accept: "application/json"
  }
});

const rebixApi = axios.create({
  baseURL: config.pinterest.endpoint,
  timeout: 12000,
  headers: {
    Accept: "application/json"
  }
});

function isRetryable(error) {
  const status = error?.response?.status;

  // Do not repeatedly retry slow/failed Pinterest requests.
  return status === 429 || status >= 500;
}

export async function searchPins(term) {
  if (config.pinterest.provider === "rebix") {
    try {
      const response = await rebixApi.get("", {
        params: { q: term }
      });

      const data = response.data;

      const items = Array.isArray(data)
        ? data
        : (data?.items || data?.results || data?.data || []);

      if (!Array.isArray(items)) {
        throw new Error(
          "Pinterest endpoint returned an unexpected response format"
        );
      }

      return items;
    } catch (error) {
      logger.error(
        {
          term,
          status: error?.response?.status,
          message: error?.message
        },
        "Pinterest search failed"
      );

      throw new Error(
        `Pinterest search failed: ${error?.message || "request failed"}`
      );
    }
  }

  if (!config.pinterest.accessToken) {
    throw new Error(
      "PINTEREST_ACCESS_TOKEN is required when PINTEREST_PROVIDER=official"
    );
  }

  try {
    const response = await officialApi.get("/search/partner/pins", {
      params: {
        term,
        country_code: config.pinterest.countryCode,
        locale: config.pinterest.locale,
        limit: config.content.searchResultsPerQuery
      }
    });

    return response.data?.items || [];
  } catch (error) {
    logger.error(
      {
        term,
        status: error?.response?.status,
        message: error?.message
      },
      "Pinterest official API search failed"
    );

    throw new Error(
      `Pinterest search failed: ${error?.message || "request failed"}`
    );
  }
}

// ── Direct pin resolution (used by automatic Pinterest link detection) ──
// Neither provider exposes a dedicated "get one pin by id/url" endpoint in
// this project, so a direct link is resolved through the same search-style
// call used everywhere else — passing the full Pinterest URL as the query
// term. Both the rebix fallback and the official partner-search endpoint
// accept a free-text term, and Pinterest resolves a pin/short URL passed
// that way to (at minimum) that pin itself. This intentionally reuses the
// existing extraction path instead of adding a second Pinterest client.

export function extractPinId(url) {
  const match = String(url || "").match(/\/pin\/(\d+)/);
  return match ? match[1] : null;
}

// pin.it links are short redirects — resolve them to the canonical
// pinterest.com/pin/<id>/ URL before handing them to the search layer.
async function expandShortLink(url) {
  if (!/pin\.it\//i.test(url)) return url;

  try {
    const response = await axios.get(url, {
      maxRedirects: 5,
      timeout: 8000,
      validateStatus: () => true
    });
    return response.request?.res?.responseUrl
      || response.request?.responseURL
      || url;
  } catch (error) {
    logger.warn(
      { url, message: error?.message },
      "Could not expand pin.it short link; using it as-is"
    );
    return url;
  }
}

export async function resolvePinByUrl(rawUrl) {
  const url = await expandShortLink(String(rawUrl || "").trim());
  if (!url) return null;

  const items = await searchPins(url);
  if (!Array.isArray(items) || !items.length) return null;

  // If several items came back, prefer the one that actually matches the
  // pin id / link in the URL instead of blindly trusting result order.
  const wantedId = extractPinId(url);
  if (wantedId) {
    const exact = items.find(pin => {
      const pinId = String(pin?.id || pin?.pin_id || pin?.pinId || "");
      const link = String(pin?.pin_url || pin?.pinUrl || pin?.link || pin?.url || "");
      return pinId === wantedId || link.includes(wantedId);
    });
    if (exact) return exact;
  }

  return items[0];
}
