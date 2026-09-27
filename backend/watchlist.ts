import { queryUserItems } from "./db.ts";
import { json, userIdOf, type AuthedEvent } from "./http.ts";
import { tradingViewUrl } from "./ticker-search.ts";

export async function handler(event: AuthedEvent) {
  const items = await queryUserItems(userIdOf(event));
  const watchlist = items.map((item) => ({
    ticker: item.ticker,
    name: item.name,
    targetPrice: item.targetPrice,
    firstFlaggedAt: item.firstFlaggedAt ?? null,
    tradingViewUrl: tradingViewUrl(item.ticker),
  }));
  return json(200, { watchlist });
}
