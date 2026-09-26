export interface WatchlistRow {
  line: number;
  name: string;
  country: string;
  targetPrice: number;
  ticker?: string;
}

export type ExclusionReason = "missing_name" | "missing_target" | "invalid_target" | "has_note" | "invalid_ticker";

export interface ExcludedRow {
  line: number;
  name: string;
  reason: ExclusionReason;
}

export interface ParseResult {
  rows: WatchlistRow[];
  excluded: ExcludedRow[];
}

export class CsvError extends Error {}

export const MAX_ROWS = 1000;
const MAX_NAME_LENGTH = 200;
const TICKER_PATTERN = /^[A-Z0-9][A-Z0-9.\-=^]{0,14}$/;

const COLUMNS = {
  name: "nome",
  country: "nazione",
  target: "prezzo target long",
  note: "note",
  ticker: "ticker",
} as const;

const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/\s+/g, " ");

// Accepts Italian formatting: "16,3" and "1.234,5".
function parsePrice(raw: string): number {
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  return /^\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : NaN;
}

export function parseWatchlistCsv(text: string): ParseResult {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = lines[0].split(";").map(normalizeHeader);

  const col = (name: string) => header.indexOf(name);
  for (const required of [COLUMNS.name, COLUMNS.country, COLUMNS.target, COLUMNS.note]) {
    if (col(required) === -1) throw new CsvError(`Missing column: ${required}`);
  }

  const rows: WatchlistRow[] = [];
  const excluded: ExcludedRow[] = [];
  let dataLines = 0;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (++dataLines > MAX_ROWS) throw new CsvError(`Too many rows (max ${MAX_ROWS})`);

    const cells = lines[i].split(";").map((c) => c.trim());
    const cell = (name: string) => (col(name) === -1 ? "" : (cells[col(name)] ?? ""));
    const line = i + 1;
    const name = cell(COLUMNS.name);

    if (name.length > MAX_NAME_LENGTH) throw new CsvError(`Line ${line}: name too long`);
    if (!name) {
      excluded.push({ line, name, reason: "missing_name" });
      continue;
    }

    const rawTarget = cell(COLUMNS.target);
    if (!rawTarget) {
      excluded.push({ line, name, reason: "missing_target" });
      continue;
    }
    if (cell(COLUMNS.note)) {
      excluded.push({ line, name, reason: "has_note" });
      continue;
    }
    const targetPrice = parsePrice(rawTarget);
    if (!(targetPrice > 0)) {
      excluded.push({ line, name, reason: "invalid_target" });
      continue;
    }

    const ticker = cell(COLUMNS.ticker).toUpperCase();
    if (ticker && !TICKER_PATTERN.test(ticker)) {
      excluded.push({ line, name, reason: "invalid_ticker" });
      continue;
    }

    rows.push({ line, name, country: cell(COLUMNS.country), targetPrice, ...(ticker && { ticker }) });
  }

  return { rows, excluded };
}
