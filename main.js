import fs from "node:fs";
import http from "node:http";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { startScheduler } from "./scheduler.js";
import { bot, primeBotInfo } from "./telegram/publisher.js";
import { closeDatabase } from "./database/database.js";

fs.mkdirSync(config.storage.downloadDir, { recursive: true });

let scheduler;
let healthServer;

async function main() {
  // Render Web Services require an open HTTP port. This tiny health server
  // keeps the bot compatible with Render while Telegraf handles Telegram.
  const port = Number(process.env.PORT || 10000);
  healthServer = http.createServer((req, res) => {
    if (req.url === "/api/health" || req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "bloom-petal" }));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bloom & Petal is running");
  });
  healthServer.listen(port, "0.0.0.0", () => {
    logger.info({ port }, "Health server listening");
  });
  logger.info("𓂃⊹ ˚₊‧ 𝐁𝐋𝐎𝐎𝐌 ⟡ 𝐏𝐄𝐓𝐀𝐋 bot starting");

  await primeBotInfo();

  // The bot does not need polling for publishing, but launching Telegraf
  // keeps the bot connection healthy and allows future commands to be added.
  await bot.launch({
    dropPendingUpdates: true
  });

  scheduler = startScheduler();

  logger.info("Bot is running");
}

function shutdown(signal) {
  logger.info({ signal }, "Graceful shutdown");

  try {
    scheduler?.stop();
  } catch {}

  try {
    healthServer?.close();
  } catch {}

  try {
    bot.stop(signal);
  } catch {}

  try {
    closeDatabase();
  } catch {}

  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", error => {
  logger.error({ error }, "Unhandled rejection");
});

process.on("uncaughtException", error => {
  logger.fatal({ error }, "Uncaught exception");
  // Do not silently continue after an unknown process-level exception.
  process.exit(1);
});

main().catch(error => {
  logger.fatal({ error }, "Startup failed");
  process.exit(1);
});
