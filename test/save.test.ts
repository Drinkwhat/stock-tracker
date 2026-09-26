import assert from "node:assert/strict";
import { test } from "node:test";
import { planReplace, validateItems } from "../backend/save.ts";

test("accepts a valid list and normalizes tickers", () => {
  assert.deepEqual(validateItems({ items: [{ name: " Clorox ", ticker: "clx", targetPrice: 66.2 }] }), {
    items: [{ name: "Clorox", ticker: "CLX", targetPrice: 66.2 }],
  });
});

test("accepts an empty list, which clears the watchlist", () => {
  assert.deepEqual(validateItems({ items: [] }), { items: [] });
});

test("rejects malformed bodies", () => {
  for (const body of [null, "x", {}, { items: "x" }]) {
    assert.ok("error" in validateItems(body));
  }
});

test("reports every invalid item, including duplicate tickers", () => {
  const result = validateItems({
    items: [
      { name: "Slb NV", ticker: "SLB", targetPrice: 31.4 },
      { name: "", ticker: "X", targetPrice: 1 },
      { name: "Bad", ticker: "DROP TABLE", targetPrice: 1 },
      { name: "Neg", ticker: "NEG", targetPrice: -5 },
      { name: "Str", ticker: "STR", targetPrice: "10" },
      { name: "Schlumberger", ticker: "slb", targetPrice: 30 },
    ],
  });
  assert.deepEqual(result, {
    error: "Invalid items",
    details: [
      { index: 1, field: "name" },
      { index: 2, field: "ticker" },
      { index: 3, field: "targetPrice" },
      { index: 4, field: "targetPrice" },
      { index: 5, field: "ticker", duplicateOf: 0 },
    ],
  });
});

test("keeps alert state only when the target price is unchanged", () => {
  const existing = [
    { userId: "u1", ticker: "CLX", name: "Clorox", targetPrice: 66.2, firstFlaggedAt: "2026-09-20" },
    { userId: "u1", ticker: "KSS", name: "Kohl's", targetPrice: 13.4, firstFlaggedAt: "2026-09-21" },
    { userId: "u1", ticker: "BAX", name: "Baxter", targetPrice: 16.3 },
  ];
  const { puts, deletes } = planReplace("u1", existing, [
    { name: "Clorox Co", ticker: "CLX", targetPrice: 66.2 },
    { name: "Kohl's", ticker: "KSS", targetPrice: 12 },
    { name: "Anika", ticker: "ANIK", targetPrice: 14 },
  ]);
  assert.deepEqual(puts, [
    { userId: "u1", ticker: "CLX", name: "Clorox Co", targetPrice: 66.2, firstFlaggedAt: "2026-09-20" },
    { userId: "u1", ticker: "KSS", name: "Kohl's", targetPrice: 12 },
    { userId: "u1", ticker: "ANIK", name: "Anika", targetPrice: 14 },
  ]);
  assert.deepEqual(deletes, ["BAX"]);
});
