import fs from "node:fs/promises";
import { config } from "../config.js";

export async function cleanupDownloads() {
  let entries = [];
  try {
    entries = await fs.readdir(config.storage.downloadDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    try {
      await fs.unlink(`${config.storage.downloadDir}/${entry}`);
    } catch {
      // Ignore individual cleanup errors.
    }
  }
}
