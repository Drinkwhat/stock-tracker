import { mapWithConcurrency } from "./concurrency.ts";
import { batchWrite, queryUserItems, type StoredItem } from "./db.ts";
import { bodyText, json, userIdOf, type AuthedEvent } from "./http.ts";
import { fetchQuote } from "./prices.ts";
import { MAX_NAME_LENGTH, MAX_ROWS, TICKER_PATTERN } from "./watchlist-csv.ts";

export interface WatchlistItem {
  name: string;
  ticker: string;
  targetPrice: number;
}

interface ItemError {
  index: number;
  field: "name" | "ticker" | "targetPrice";
  duplicateOf?: number;
}

export function validateItems(body: unknown): { items: WatchlistItem[] } | { error: string; details?: ItemError[] } {
  const rawItems = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(rawItems)) return { error: "Body must be an object with an items array" };
  if (rawItems.length > MAX_ROWS) return { error: `Too many items (max ${MAX_ROWS})` };

  const items: WatchlistItem[] = [];
  const errors: ItemError[] = [];
  const seen = new Map<string, number>();

  rawItems.forEach((raw: Record<string, unknown> | null, index) => {
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    const ticker = typeof raw?.ticker === "string" ? raw.ticker.trim().toUpperCase() : "";
    const targetPrice = raw?.targetPrice;

    if (!name || name.length > MAX_NAME_LENGTH) errors.push({ index, field: "name" });
    else if (!TICKER_PATTERN.test(ticker)) errors.push({ index, field: "ticker" });
    else if (typeof targetPrice !== "number" || !(targetPrice > 0) || !Number.isFinite(targetPrice)) {
      errors.push({ index, field: "targetPrice" });
    } else if (seen.has(ticker)) errors.push({ index, field: "ticker", duplicateOf: seen.get(ticker) });
    else {
      seen.set(ticker, index);
      items.push({ name, ticker, targetPrice });
    }
  });

  return errors.length > 0 ? { error: "Invalid items", details: errors } : { items };
}

// Alert state survives a re-upload only when the ticker keeps the same target price.
export function planReplace(userId: string, existing: StoredItem[], incoming: WatchlistItem[]) {
  const previous = new Map(existing.map((item) => [item.ticker, item]));
  const puts: StoredItem[] = incoming.map((item) => {
    const prev = previous.get(item.ticker);
    const state = prev && prev.targetPrice === item.targetPrice ? prev : {};
    const exchange = prev?.exchange === undefined ? {} : { exchange: prev.exchange };
    return { ...state, ...exchange, userId, ticker: item.ticker, name: item.name, targetPrice: item.targetPrice };
  });
  const kept = new Set(incoming.map((item) => item.ticker));
  const deletes = existing.filter((item) => !kept.has(item.ticker)).map((item) => item.ticker);
  return { puts, deletes };
}

export async function handler(event: AuthedEvent) {
  let body: unknown;
  try {
    body = JSON.parse(bodyText(event));
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const validation = validateItems(body);
  if ("error" in validation) return json(422, validation);

  const userId = userIdOf(event);
  const { puts, deletes } = planReplace(userId, await queryUserItems(userId), validation.items);

  await addUsExchanges(puts);

  // Not atomic; writing before deleting means a partial failure leaves a superset
  // that the next upload corrects. Use TransactWriteItems if lists stay under 100 items.
  await batchWrite(puts.map((Item) => ({ PutRequest: { Item } })));
  await batchWrite(deletes.map((ticker) => ({ DeleteRequest: { Key: { userId, ticker } } })));

  return json(200, { saved: puts.length, removed: deletes.length });
}

// US tickers carry no exchange suffix; store Yahoo's exchange code so TradingView links open the right listing.
// A failed lookup only means no link, so it never blocks the save.
async function addUsExchanges(puts: StoredItem[]) {
  const missing = puts.filter((item) => !item.ticker.includes(".") && item.exchange === undefined);
  await mapWithConcurrency(missing, 5, async (item) => {
    try {
      const { exchange } = await fetchQuote(item.ticker);
      if (exchange) item.exchange = exchange;
    } catch (err) {
      console.error("Exchange lookup failed", { ticker: item.ticker, error: String(err) });
    }
  });
}
