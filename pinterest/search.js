import { searchPins } from "./client.js";
import { logger } from "../utils/logger.js";
import { chooseQuery } from "./queries.js";
import { getState, setState } from "../database/database.js";

export async function getCandidates() {
  const lastCategory = getState("last_category");
  const lastQuery = getState("last_query");
  const { category, query } = chooseQuery(lastCategory, lastQuery);

  setState("last_category", category);
  setState("last_query", query);

  logger.info({ category, query }, "Pinterest search");

  const items = await searchPins(query);

  return {
    category,
    query,
    items
  };
}
