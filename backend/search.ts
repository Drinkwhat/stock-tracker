import { json, type AuthedEvent } from "./http.ts";
import { candidatesForTradingView, searchCandidates } from "./ticker-search.ts";
import { MAX_NAME_LENGTH } from "./watchlist-csv.ts";

// ?q= searches by company name; ?tv= resolves a TradingView symbol such as NYSE:HAL.
export async function handler(event: AuthedEvent) {
  const params = event.queryStringParameters ?? {};
  const tv = params.tv?.trim();
  if (tv) return json(200, { candidates: await candidatesForTradingView(tv) });

  const query = params.q?.trim() ?? "";
  if (!query || query.length > MAX_NAME_LENGTH) return json(400, { error: "Missing or too long query" });
  return json(200, { candidates: await searchCandidates(query) });
}
