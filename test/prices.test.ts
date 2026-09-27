import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchQuotes } from "../backend/prices.ts";

test("returns the quotes that succeed and leaves out failures", async () => {
  const quotes = await fetchQuotes(["CLX", "GONE", "ATE.PA"], async (ticker) => {
    if (ticker === "GONE") throw new Error("delisted");
    return { price: ticker === "CLX" ? 83.8 : 76.25, currency: "EUR" };
  });
  assert.deepEqual(
    [...quotes].sort(),
    [
      ["ATE.PA", { price: 76.25, currency: "EUR" }],
      ["CLX", { price: 83.8, currency: "EUR" }],
    ],
  );
});

test("converts prices to EUR and leaves out tickers without an FX rate", async () => {
  const fixtures: Record<string, { price: number; currency: string }> = {
    CLX: { price: 100, currency: "USD" },
    "ULVR.L": { price: 4000, currency: "GBp" },
    "ATE.PA": { price: 76.25, currency: "EUR" },
    "7203.T": { price: 2500, currency: "JPY" },
    "USDEUR=X": { price: 0.9, currency: "EUR" },
    "GBPEUR=X": { price: 1.2, currency: "EUR" },
  };
  const quotes = await fetchQuotes(["CLX", "ULVR.L", "ATE.PA", "7203.T"], async (t) => {
    if (!fixtures[t]) throw new Error("not found");
    return fixtures[t];
  });
  assert.deepEqual(
    [...quotes].sort(),
    [
      ["ATE.PA", { price: 76.25, currency: "EUR" }],
      ["CLX", { price: 90, currency: "EUR" }],
      ["ULVR.L", { price: 48, currency: "EUR" }],
    ],
  );
});
