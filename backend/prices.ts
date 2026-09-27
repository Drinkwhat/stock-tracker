import { mapWithConcurrency } from "./concurrency.ts";

export interface Quote {
  price: number;
  currency: string;
  /** Yahoo exchange code, e.g. NYQ; needed to link US tickers to TradingView. */
  exchange?: string;
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
    chart?: { result?: { meta?: { regularMarketPrice?: unknown; currency?: unknown; exchangeName?: unknown } }[] };
  };
  const meta = data.chart?.result?.[0]?.meta;
  if (typeof meta?.regularMarketPrice !== "number" || !(meta.regularMarketPrice > 0)) {
    throw new Error(`No price for ${ticker}`);
  }
  return {
    price: meta.regularMarketPrice,
    currency: typeof meta.currency === "string" ? meta.currency : "",
    exchange: typeof meta.exchangeName === "string" ? meta.exchangeName : undefined,
  };
}

// Yahoo quotes some listings in minor units (London in pence, Johannesburg in cents).
const MINOR_UNITS: Record<string, [string, number]> = { GBp: ["GBP", 100], GBX: ["GBP", 100], ZAc: ["ZAR", 100], ILA: ["ILS", 100] };

/**
 * Returns EUR quotes for the tickers that could be priced; targets are in EUR, so prices are converted
 * at the current Yahoo FX rate. Tickers whose price or FX rate cannot be fetched are logged and left out.
 */
export async function fetchQuotes(tickers: string[], fetchOne = fetchQuote): Promise<Map<string, Quote>> {
  const raw = new Map<string, Quote>();
  await mapWithConcurrency(tickers, CONCURRENCY, async (ticker) => {
    try {
      raw.set(ticker, await fetchOne(ticker));
    } catch (err) {
      console.error("Price fetch failed", { ticker, error: String(err) });
    }
  });

  const majorOf = (currency: string) => MINOR_UNITS[currency] ?? [currency, 1];
  const toConvert = [...new Set([...raw.values()].map((q) => majorOf(q.currency)[0]))].filter((c) => c !== "EUR");
  const rates = new Map<string, number>([["EUR", 1]]);
  await mapWithConcurrency(toConvert, CONCURRENCY, async (currency) => {
    try {
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Unknown currency");
      rates.set(currency, (await fetchOne(`${currency}EUR=X`)).price);
    } catch (err) {
      console.error("FX rate fetch failed", { currency, error: String(err) });
    }
  });

  const quotes = new Map<string, Quote>();
  for (const [ticker, q] of raw) {
    const [major, divisor] = majorOf(q.currency);
    const rate = rates.get(major);
    if (rate !== undefined) quotes.set(ticker, { ...q, price: (q.price / divisor) * rate, currency: "EUR" });
  }
  return quotes;
}
