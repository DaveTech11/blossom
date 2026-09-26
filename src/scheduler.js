import cron from "node-cron";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { runHourlyJob, runScheduledPostJob } from "./worker.js";
import { getDueScheduledPosts, markScheduledPostDone, markScheduledPostPending, markScheduledPostRunning } from "./database/database.js";

async function runDueScheduledPosts() {
  const due = getDueScheduledPosts();
  for (const job of due) {
    const claimed = markScheduledPostRunning(job.id);
    if (!claimed.changes) continue;
    try {
      await runScheduledPostJob({ ...job, targetChatId: job.target_chat_id });
      markScheduledPostDone(job.id);
      logger.info({ id: job.id, query: job.query, amount: job.amount }, "Persistent scheduled post completed");
    } catch (error) {
      markScheduledPostPending(job.id);
      logger.warn({ id: job.id, error: error?.message }, "Persistent scheduled post kept pending for retry");
      break;
    }
  }
}

function cronFromSeconds(seconds) {
  // node-cron is minute-oriented. For the requested hourly default this is exact.
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    if (hours === 1) return "0 * * * *";
    return `0 */${hours} * * *`;
  }

  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `*/${minutes} * * * *`;
  }

  throw new Error(
    "POST_INTERVAL must be a whole number of minutes (3600 is recommended for hourly posting)."
  );
}

export function startScheduler() {
  let hourlyRunning = false;
  const expression = cronFromSeconds(config.schedule.intervalSeconds);

  const task = cron.schedule(expression, async () => {
    if (hourlyRunning) {
      logger.warn("Skipping scheduled cycle because the previous cycle is still running");
      return;
    }
    hourlyRunning = true;
    logger.info("Scheduled content job starting");
    try {
      await runHourlyJob();
    } finally {
      hourlyRunning = false;
    }
  });

  let dueRunning = false;
  const nextPostTask = cron.schedule("* * * * *", async () => {
    if (dueRunning) return;
    dueRunning = true;
    try {
      await runDueScheduledPosts();
    } finally {
      dueRunning = false;
    }
  });

  // Catch jobs that became due while Render was offline/restarting.
  void runDueScheduledPosts();

  logger.info({
    expression,
    intervalSeconds: config.schedule.intervalSeconds
  }, "Scheduler started");

  if (config.schedule.runOnStart) {
    void runHourlyJob();
  }

  return {
    stop() {
      task.stop();
      nextPostTask.stop();
    }
  };
}
