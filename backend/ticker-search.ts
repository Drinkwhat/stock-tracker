export interface YahooQuote {
  symbol?: string;
  quoteType?: string;
  exchange?: string;
  shortname?: string;
  longname?: string;
}

export interface Candidate {
  symbol: string;
  name: string;
  exchange: string;
}

export type Resolution =
  | { status: "resolved" | "ambiguous"; ticker: string; candidates: Candidate[] }
  | { status: "not_found" | "unsupported_country"; candidates: [] };

export type SearchFn = (query: string) => Promise<YahooQuote[]>;

const US_EXCHANGES = ["NMS", "NGM", "NCM", "NYQ", "ASE", "PCX", "BTS"];

// Yahoo exchange codes for the primary listing in each country, keyed by the Italian country name.
const EXCHANGES_BY_COUNTRY: Record<string, string[]> = {
  "stati uniti": US_EXCHANGES,
  usa: US_EXCHANGES,
  francia: ["PAR"],
  svizzera: ["EBS"],
  italia: ["MIL"],
  germania: ["GER"],
  "regno unito": ["LSE"],
  spagna: ["MCE"],
  olanda: ["AMS"],
  "paesi bassi": ["AMS"],
  belgio: ["BRU"],
  portogallo: ["LIS"],
};

const CORPORATE_SUFFIX = /\s+(n\.?v\.?|corp\.?|corporation|inc\.?|s\.?a\.?|ag|co\.?|plc|ltd\.?|s\.?p\.?a\.?|se)$/i;

function stripCorporateSuffix(name: string): string {
  let current = name.trim();
  for (let previous = ""; previous !== current; ) {
    previous = current;
    current = current.replace(CORPORATE_SUFFIX, "").trim();
  }
  return current;
}

const SUPPORTED_EXCHANGES = [...new Set(Object.values(EXCHANGES_BY_COUNTRY).flat())];

/** Equities matching the query, limited to the given exchanges (default: every supported country). */
export async function searchCandidates(
  query: string,
  exchanges = SUPPORTED_EXCHANGES,
  search: SearchFn = yahooSearch,
): Promise<Candidate[]> {
  return (await search(query))
    .filter((q) => q.symbol && q.quoteType === "EQUITY" && exchanges.includes(q.exchange ?? ""))
    .map((q) => ({ symbol: q.symbol!, name: q.longname ?? q.shortname ?? q.symbol!, exchange: q.exchange! }));
}

export async function resolveTicker(name: string, country: string, search: SearchFn = yahooSearch): Promise<Resolution> {
  const exchanges = EXCHANGES_BY_COUNTRY[country.trim().toLowerCase()];
  if (!exchanges) return { status: "unsupported_country", candidates: [] };

  for (const query of new Set([name, stripCorporateSuffix(name)])) {
    const candidates = await searchCandidates(query, exchanges, search);
    if (candidates.length > 0) {
      return { status: candidates.length === 1 ? "resolved" : "ambiguous", ticker: candidates[0].symbol, candidates };
    }
  }
  return { status: "not_found", candidates: [] };
}

export async function yahooSearch(query: string): Promise<YahooQuote[]> {
  const url = new URL("https://query2.finance.yahoo.com/v1/finance/search");
  url.search = new URLSearchParams({ q: query, quotesCount: "10", newsCount: "0" }).toString();
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Yahoo search failed with status ${res.status}`);
  const data = (await res.json()) as { quotes?: unknown };
  return Array.isArray(data.quotes) ? (data.quotes as YahooQuote[]) : [];
}
