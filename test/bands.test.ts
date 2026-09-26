import assert from "node:assert/strict";
import { test } from "node:test";
import { bandFor, evaluate, isEmpty, type TrackedItem } from "../backend/bands.ts";

const item = (overrides: Partial<TrackedItem> = {}): TrackedItem => ({
  ticker: "CLX",
  name: "Clorox",
  targetPrice: 100,
  ...overrides,
});

const prices = (price: number) => new Map([["CLX", price]]);

test("bands are symmetric around the target and inclusive at the edges", () => {
  assert.equal(bandFor(97, 100), "narrow");
  assert.equal(bandFor(103, 100), "narrow");
  assert.equal(bandFor(95, 100), "wide");
  assert.equal(bandFor(105, 100), "wide");
  assert.equal(bandFor(94.9, 100), "none");
  assert.equal(bandFor(105.1, 100), "none");
});

test("band edges are not shifted by floating point noise", () => {
  assert.equal(bandFor(5.15, 5), "narrow");
  assert.equal(bandFor(4.85, 5), "narrow");
  assert.equal(bandFor(5.25, 5), "wide");
  assert.equal(bandFor(76.1 * 1.05, 76.1), "wide");
});

test("morning run reports the wide band and sets the first flagged date", () => {
  const { report, updates } = evaluate([item()], prices(104), "morning", "2026-09-28");
  assert.equal(report.inBand.length, 1);
  assert.equal(report.inBand[0].firstFlaggedAt, "2026-09-28");
  assert.ok(Math.abs(report.inBand[0].distance - 0.04) < 1e-9);
  assert.deepEqual(updates[0].state, { band: "wide", firstFlaggedAt: "2026-09-28", exitedWide: false, exitedNarrow: false });
});

test("intraday run ignores the wide band but records it without a flag date", () => {
  const { report, updates } = evaluate([item()], prices(104), "intraday", "2026-09-28");
  assert.ok(isEmpty(report));
  assert.deepEqual(updates[0].state, { band: "wide", firstFlaggedAt: undefined, exitedWide: false, exitedNarrow: false });
});

test("intraday run reports the narrow band", () => {
  const { report } = evaluate([item()], prices(98), "intraday", "2026-09-28");
  assert.deepEqual(
    report.inBand.map((l) => [l.ticker, l.firstFlaggedAt]),
    [["CLX", "2026-09-28"]],
  );
});

test("the first flagged date is kept while the stock stays in the band", () => {
  const flagged = item({ band: "wide", firstFlaggedAt: "2026-09-20", exitedWide: false, exitedNarrow: false });
  const { report, updates } = evaluate([flagged], prices(96), "morning", "2026-09-28");
  assert.equal(report.inBand[0].firstFlaggedAt, "2026-09-20");
  assert.deepEqual(updates, []);
});

test("an afternoon exit from ±5% is reported the next morning and resets the flag date", () => {
  const flagged = item({ band: "narrow", firstFlaggedAt: "2026-09-20", exitedWide: false, exitedNarrow: false });

  const afternoon = evaluate([flagged], prices(110), "intraday", "2026-09-25");
  assert.ok(isEmpty(afternoon.report));
  const afterExit = { ...flagged, ...afternoon.updates[0].state };
  assert.deepEqual(afternoon.updates[0].state, { band: "none", firstFlaggedAt: undefined, exitedWide: true, exitedNarrow: false });

  const morning = evaluate([afterExit], prices(111), "morning", "2026-09-26");
  assert.deepEqual(
    morning.report.exitedWide.map((l) => l.ticker),
    ["CLX"],
  );
  assert.deepEqual(morning.report.exitedNarrow, []);
  assert.equal(morning.updates[0].state.exitedWide, false);

  const nextMorning = evaluate([{ ...afterExit, ...morning.updates[0].state }], prices(111), "morning", "2026-09-27");
  assert.ok(isEmpty(nextMorning.report));
});

test("leaving ±3% but staying within ±5% is reported as a narrow exit", () => {
  const flagged = item({ band: "narrow", firstFlaggedAt: "2026-09-20", exitedWide: false, exitedNarrow: false });
  const { report } = evaluate([flagged], prices(104), "morning", "2026-09-28");
  assert.deepEqual(
    report.exitedNarrow.map((l) => l.ticker),
    ["CLX"],
  );
  assert.deepEqual(
    report.inBand.map((l) => l.firstFlaggedAt),
    ["2026-09-20"],
  );
});

test("an exit is reported even if the stock re-entered before the morning", () => {
  const exited = item({ band: "none", exitedWide: true, exitedNarrow: false });
  const { report } = evaluate([exited], prices(99), "morning", "2026-09-28");
  assert.deepEqual(
    report.exitedWide.map((l) => l.ticker),
    ["CLX"],
  );
  assert.equal(report.inBand[0].firstFlaggedAt, "2026-09-28");
});

test("a stock that was never reported does not produce an exit", () => {
  const unseen = item({ band: "wide", exitedWide: false, exitedNarrow: false });
  const { report, updates } = evaluate([unseen], prices(120), "morning", "2026-09-28");
  assert.ok(isEmpty(report));
  assert.equal(updates[0].state.exitedWide, false);
});

test("a wide exit takes precedence over a narrow exit in the same morning", () => {
  const both = item({ band: "none", exitedWide: true, exitedNarrow: true });
  const { report } = evaluate([both], prices(120), "morning", "2026-09-28");
  assert.equal(report.exitedWide.length, 1);
  assert.equal(report.exitedNarrow.length, 0);
});

test("stocks without a price are listed and left untouched", () => {
  const { report, updates } = evaluate([item({ ticker: "GONE" })], prices(100), "morning", "2026-09-28");
  assert.deepEqual(report.unpriced, ["GONE"]);
  assert.deepEqual(updates, []);
});

test("in-band stocks are sorted by distance from the target", () => {
  const items = [item({ ticker: "A" }), item({ ticker: "B" }), item({ ticker: "C" })];
  const { report } = evaluate(
    items,
    new Map([
      ["A", 104],
      ["B", 99.5],
      ["C", 97.5],
    ]),
    "morning",
    "2026-09-28",
  );
  assert.deepEqual(
    report.inBand.map((l) => l.ticker),
    ["B", "C", "A"],
  );
});
