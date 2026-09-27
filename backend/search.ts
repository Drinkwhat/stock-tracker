import { json, type AuthedEvent } from "./http.ts";
import { searchCandidates } from "./ticker-search.ts";
import { MAX_NAME_LENGTH } from "./watchlist-csv.ts";

export async function handler(event: AuthedEvent) {
  const query = event.queryStringParameters?.q?.trim() ?? "";
  if (!query || query.length > MAX_NAME_LENGTH) return json(400, { error: "Missing or too long query" });
  return json(200, { candidates: await searchCandidates(query) });
}
