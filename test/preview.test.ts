import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPreview } from "../backend/preview.ts";
import type { Resolution } from "../backend/ticker-search.ts";

const CSV = [
  "nazione;Nome;prezzo Target Long;note;ticker",
  "stati uniti;Clorox;66,2;;",
  "stati uniti;Slb NV;31,4;;SLB",
  "stati uniti;Flaky;10;;",
  "Atlantide;Nowhere;5;;",
  "stati uniti;NCR;;pochi dati;",
].join("\n");

const resolutions: Record<string, Resolution> = {
  Clorox: { status: "resolved", ticker: "CLX", candidates: [{ symbol: "CLX", name: "Clorox", exchange: "NYQ" }] },
  Nowhere: { status: "unsupported_country", candidates: [] },
};

test("builds a preview with search results, manual overrides and failures", async () => {
  const searched: string[] = [];
  const { rows, excluded } = await buildPreview(CSV, async (name) => {
    searched.push(name);
    if (name === "Flaky") throw new Error("rate limited");
    return resolutions[name];
  });

  assert.deepEqual(searched.sort(), ["Clorox", "Flaky", "Nowhere"]);
  assert.deepEqual(
    rows.map((r) => [r.line, r.name, r.status, r.ticker]),
    [
      [2, "Clorox", "resolved", "CLX"],
      [3, "Slb NV", "manual", "SLB"],
      [4, "Flaky", "error", null],
      [5, "Nowhere", "unsupported_country", null],
    ],
  );
  assert.deepEqual(excluded, [{ line: 6, name: "NCR", reason: "missing_target" }]);
});
