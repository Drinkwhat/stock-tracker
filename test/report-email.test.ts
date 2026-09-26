import assert from "node:assert/strict";
import { test } from "node:test";
import type { Report } from "../backend/bands.ts";
import { renderEmail } from "../backend/report-email.ts";

const line = (ticker: string, name: string, price: number, targetPrice: number, firstFlaggedAt?: string) => ({
  ticker,
  name,
  price,
  targetPrice,
  distance: (price - targetPrice) / targetPrice,
  firstFlaggedAt,
});

const report: Report = {
  inBand: [line("CLX", "Clorox", 65.5, 66.2, "2026-09-20")],
  exitedWide: [line("KSS", "Kohl's <b>Corp</b>", 15, 13.4)],
  exitedNarrow: [],
  unpriced: ["GONE"],
};
const currencies = new Map([
  ["CLX", "USD"],
  ["KSS", "USD"],
]);

test("morning email lists in-band stocks and exits", () => {
  const email = renderEmail(report, "morning", currencies, "Mon 28 Sep, 10:00");
  assert.equal(email.subject, "Stock alerts Mon 28 Sep, 10:00: 1 within ±5%, 1 left a band");
  assert.match(email.text, /Within ±5% of target\nClorox \| CLX \| 65\.50 USD \| 66\.20 USD \| −1\.06% \| 2026-09-20/);
  assert.match(email.text, /Left the ±5% band\nKohl's <b>Corp<\/b> \| KSS \| 15\.00 USD \| 13\.40 USD \| \+11\.94%/);
  assert.match(email.text, /Prices unavailable for: GONE/);
  assert.doesNotMatch(email.text, /Left the ±3% band/);
});

test("intraday email uses the narrow band title", () => {
  const email = renderEmail({ ...report, exitedWide: [], unpriced: [] }, "intraday", currencies, "Mon 28 Sep, 16:30");
  assert.equal(email.subject, "Stock alerts Mon 28 Sep, 16:30: 1 within ±3%");
  assert.match(email.html, /Within ±3% of target/);
});

test("company names are escaped in the HTML body", () => {
  const email = renderEmail(report, "morning", currencies, "Mon 28 Sep, 10:00");
  assert.match(email.html, /Kohl&#39;s &lt;b&gt;Corp&lt;\/b&gt;/);
  assert.doesNotMatch(email.html, /<b>Corp<\/b>/);
});
