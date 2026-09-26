import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchQuotes } from "../backend/prices.ts";

test("returns the quotes that succeed and leaves out failures", async () => {
  const quotes = await fetchQuotes(["CLX", "GONE", "ATE.PA"], async (ticker) => {
    if (ticker === "GONE") throw new Error("delisted");
    return { price: ticker === "CLX" ? 83.8 : 76.25, currency: ticker === "CLX" ? "USD" : "EUR" };
  });
  assert.deepEqual(
    [...quotes].sort(),
    [
      ["ATE.PA", { price: 76.25, currency: "EUR" }],
      ["CLX", { price: 83.8, currency: "USD" }],
    ],
  );
});
