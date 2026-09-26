import { bodyText, json, type AuthedEvent } from "./http.ts";
import { resolveTicker, type Candidate, type Resolution } from "./ticker-search.ts";
import { CsvError, parseWatchlistCsv, type ExcludedRow } from "./watchlist-csv.ts";

const MAX_BODY_BYTES = 256 * 1024;
const SEARCH_CONCURRENCY = 5;

export interface PreviewRow {
  line: number;
  name: string;
  country: string;
  targetPrice: number;
  status: Resolution["status"] | "manual" | "error";
  ticker: string | null;
  candidates: Candidate[];
}

type Resolve = (name: string, country: string) => Promise<Resolution>;

export async function buildPreview(
  text: string,
  resolve: Resolve = resolveTicker,
): Promise<{ rows: PreviewRow[]; excluded: ExcludedRow[] }> {
  const { rows, excluded } = parseWatchlistCsv(text);

  const preview = await mapWithConcurrency(rows, SEARCH_CONCURRENCY, async (row): Promise<PreviewRow> => {
    const base = { line: row.line, name: row.name, country: row.country, targetPrice: row.targetPrice };
    if (row.ticker) return { ...base, status: "manual", ticker: row.ticker, candidates: [] };
    try {
      const result = await resolve(row.name, row.country);
      return { ...base, status: result.status, ticker: "ticker" in result ? result.ticker : null, candidates: result.candidates };
    } catch (err) {
      console.error("Ticker search failed", { line: row.line, error: String(err) });
      return { ...base, status: "error", ticker: null, candidates: [] };
    }
  });

  return { rows: preview, excluded };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function handler(event: AuthedEvent) {
  const text = bodyText(event);
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return json(413, { error: "File too large" });
  if (!text.trim()) return json(400, { error: "Empty file" });

  try {
    return json(200, await buildPreview(text));
  } catch (err) {
    if (err instanceof CsvError) return json(422, { error: err.message });
    throw err;
  }
}
