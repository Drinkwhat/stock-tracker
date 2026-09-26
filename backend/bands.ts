export type Band = "none" | "wide" | "narrow";
export type RunKind = "morning" | "intraday";

export const WIDE_BAND = 0.05;
export const NARROW_BAND = 0.03;

export interface AlertState {
  band: Band;
  firstFlaggedAt?: string;
  exitedWide: boolean;
  exitedNarrow: boolean;
}

export interface TrackedItem extends Partial<AlertState> {
  ticker: string;
  name: string;
  targetPrice: number;
}

export interface ReportLine {
  ticker: string;
  name: string;
  targetPrice: number;
  price: number;
  distance: number;
  firstFlaggedAt?: string;
}

export interface Report {
  inBand: ReportLine[];
  exitedWide: ReportLine[];
  exitedNarrow: ReportLine[];
  unpriced: string[];
}

export const distanceOf = (price: number, target: number) => (price - target) / target;

export function bandFor(price: number, target: number): Band {
  // Round away float noise: (5.15 - 5) / 5 is 0.030000000000000072, which must count as 3%.
  const distance = Math.round(Math.abs(distanceOf(price, target)) * 1e9) / 1e9;
  if (distance <= NARROW_BAND) return "narrow";
  if (distance <= WIDE_BAND) return "wide";
  return "none";
}

/**
 * Morning runs report everything within ±5% plus the exits recorded since the previous
 * morning; intraday runs report only stocks within ±3%. Exits are remembered across runs
 * so an exit seen in the afternoon still shows up in the next morning report.
 */
export function evaluate(items: TrackedItem[], prices: Map<string, number>, kind: RunKind, today: string) {
  const report: Report = { inBand: [], exitedWide: [], exitedNarrow: [], unpriced: [] };
  const updates: { item: TrackedItem; state: AlertState }[] = [];

  for (const item of items) {
    const price = prices.get(item.ticker);
    if (price === undefined) {
      report.unpriced.push(item.ticker);
      continue;
    }

    const previousBand = item.band ?? "none";
    const band = bandFor(price, item.targetPrice);
    const wasReported = item.firstFlaggedAt !== undefined;
    const state: AlertState = {
      band,
      firstFlaggedAt: band === "none" ? undefined : item.firstFlaggedAt,
      exitedWide: (item.exitedWide ?? false) || (wasReported && previousBand !== "none" && band === "none"),
      exitedNarrow: (item.exitedNarrow ?? false) || (previousBand === "narrow" && band === "wide"),
    };

    const line = {
      ticker: item.ticker,
      name: item.name,
      targetPrice: item.targetPrice,
      price,
      distance: distanceOf(price, item.targetPrice),
    };

    if (kind === "morning" ? band !== "none" : band === "narrow") {
      state.firstFlaggedAt ??= today;
      report.inBand.push({ ...line, firstFlaggedAt: state.firstFlaggedAt });
    }

    if (kind === "morning") {
      if (state.exitedWide) report.exitedWide.push(line);
      else if (state.exitedNarrow) report.exitedNarrow.push(line);
      state.exitedWide = false;
      state.exitedNarrow = false;
    }

    if (!sameState(item, state)) updates.push({ item, state });
  }

  const byDistance = (a: ReportLine, b: ReportLine) => Math.abs(a.distance) - Math.abs(b.distance);
  report.inBand.sort(byDistance);
  return { report, updates };
}

function sameState(item: TrackedItem, state: AlertState): boolean {
  return (
    (item.band ?? "none") === state.band &&
    item.firstFlaggedAt === state.firstFlaggedAt &&
    (item.exitedWide ?? false) === state.exitedWide &&
    (item.exitedNarrow ?? false) === state.exitedNarrow
  );
}

export const isEmpty = (report: Report) =>
  report.inBand.length === 0 && report.exitedWide.length === 0 && report.exitedNarrow.length === 0;
