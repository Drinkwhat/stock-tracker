import { mapWithConcurrency } from "./concurrency.ts";

export interface Quote {
  price: number;
  currency: string;
}

const CONCURRENCY = 5;

export async function fetchQuote(ticker: string): Promise<Quote> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`;
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Yahoo chart request for ${ticker} failed with status ${res.status}`);
  const data = (await res.json()) as {
    chart?: { result?: { meta?: { regularMarketPrice?: unknown; currency?: unknown } }[] };
  };
  const meta = data.chart?.result?.[0]?.meta;
  if (typeof meta?.regularMarketPrice !== "number" || !(meta.regularMarketPrice > 0)) {
    throw new Error(`No price for ${ticker}`);
  }
  return { price: meta.regularMarketPrice, currency: typeof meta.currency === "string" ? meta.currency : "" };
}

/** Returns quotes for the tickers that could be priced; failures are logged and left out. */
export async function fetchQuotes(tickers: string[], fetchOne = fetchQuote): Promise<Map<string, Quote>> {
  const quotes = new Map<string, Quote>();
  await mapWithConcurrency(tickers, CONCURRENCY, async (ticker) => {
    try {
      quotes.set(ticker, await fetchOne(ticker));
    } catch (err) {
      console.error("Price fetch failed", { ticker, error: String(err) });
    }
  });
  return quotes;
}
