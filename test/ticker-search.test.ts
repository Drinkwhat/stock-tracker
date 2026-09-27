import assert from "node:assert/strict";
import { test } from "node:test";
import { candidatesForTradingView, resolveTicker, searchCandidates, tradingViewUrl, type YahooQuote } from "../backend/ticker-search.ts";

// Trimmed real responses from the Yahoo Finance search endpoint.
const RESPONSES: Record<string, YahooQuote[]> = {
  Alten: [
    { symbol: "ATE.PA", quoteType: "EQUITY", exchange: "PAR", longname: "Alten S.A." },
    { symbol: "ABLGF", quoteType: "EQUITY", exchange: "PNK", longname: "Alten S.A." },
    { symbol: "ATEP.XD", quoteType: "EQUITY", exchange: "DXE", shortname: "Alten SA" },
  ],
  Slb: [
    { symbol: "SLB", quoteType: "EQUITY", exchange: "NYQ", shortname: "SLB Limited" },
    { symbol: "SLBT", quoteType: "EQUITY", exchange: "NGM", shortname: "SL Science Holding Limited" },
    { symbol: "SLB280121P00027500", quoteType: "OPTION", exchange: "OPR" },
  ],
  "Healthpeak Properties": [
    { symbol: "DOC", quoteType: "EQUITY", exchange: "NYQ", longname: "Healthpeak Properties, Inc." },
    { symbol: "HC5.F", quoteType: "ETF", exchange: "FRA" },
  ],
};

const search = async (query: string) => RESPONSES[query] ?? [];

test("resolves a single match on the country's exchange", async () => {
  const result = await resolveTicker("Alten", "Francia", search);
  assert.equal(result.status, "resolved");
  assert.equal(result.status === "resolved" && result.ticker, "ATE.PA");
});

test("ignores non-equity quotes", async () => {
  const result = await resolveTicker("Healthpeak Properties", "stati uniti", search);
  assert.equal(result.status, "resolved");
  assert.equal(result.status === "resolved" && result.ticker, "DOC");
});

test("retries without the corporate suffix and flags multiple matches as ambiguous", async () => {
  const queries: string[] = [];
  const result = await resolveTicker("Slb NV", "Stati Uniti", async (q) => {
    queries.push(q);
    return search(q);
  });
  assert.deepEqual(queries, ["Slb NV", "Slb"]);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.status === "ambiguous" && result.ticker, "SLB");
  assert.deepEqual(
    result.candidates.map((c) => c.symbol),
    ["SLB", "SLBT"],
  );
});

test("returns not_found when no listing matches the country", async () => {
  assert.equal((await resolveTicker("Alten", "stati uniti", search)).status, "not_found");
});

test("returns unsupported_country without searching", async () => {
  let called = false;
  const result = await resolveTicker("Alten", "Atlantide", async () => {
    called = true;
    return [];
  });
  assert.equal(result.status, "unsupported_country");
  assert.equal(called, false);
});

test("search keeps equities on any supported exchange", async () => {
  assert.deepEqual(
    (await searchCandidates("Alten", undefined, search)).map((c) => c.symbol),
    ["ATE.PA"],
  );
});

test("maps Yahoo tickers to TradingView pages", () => {
  const tv = "https://www.tradingview.com/symbols/";
  assert.equal(tradingViewUrl("ENEL.MI"), `${tv}MIL-ENEL/`);
  assert.equal(tradingViewUrl("ATE.PA"), `${tv}EURONEXT-ATE/`);
  assert.equal(tradingViewUrl("BT-A.L"), `${tv}LSE-BT.A/`);
  assert.equal(tradingViewUrl("BRK-B", "NYQ"), `${tv}NYSE-BRK.B/`);
  assert.equal(tradingViewUrl("AAPL", "NMS"), `${tv}NASDAQ-AAPL/`);
  assert.equal(tradingViewUrl("HAL"), null, "US ticker without a known exchange gets no link");
  assert.equal(tradingViewUrl("7203.T"), null);
});

test("resolves TradingView symbols to the Yahoo listing with the same TradingView page", async () => {
  const listed: Record<string, { exchange: string; name: string }> = {
    "ATE.PA": { exchange: "PAR", name: "Alten S.A." },
    HAL: { exchange: "NYQ", name: "Halliburton Company" },
    "BRK-B": { exchange: "NYQ", name: "Berkshire Hathaway Inc." },
  };
  const fetchOne = async (ticker: string) => {
    if (!listed[ticker]) throw new Error("not found");
    return { price: 1, currency: "USD", ...listed[ticker] };
  };
  const symbols = async (tv: string) => (await candidatesForTradingView(tv, fetchOne)).map((c) => c.symbol);
  assert.deepEqual(await symbols("EURONEXT:ATE"), ["ATE.PA"]);
  assert.deepEqual(await symbols("NYSE:HAL"), ["HAL"]);
  assert.deepEqual(await symbols("NYSE:BRK.B"), ["BRK-B"]);
  assert.deepEqual(await symbols("NASDAQ:HAL"), [], "exchange must match");
  assert.deepEqual(await symbols("TSE:7203"), [], "unsupported exchange");
});
