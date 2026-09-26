import assert from "node:assert/strict";
import { test } from "node:test";
import { CsvError, MAX_ROWS, parseWatchlistCsv } from "../backend/watchlist-csv.ts";

// Mirrors the real export: BOM, CRLF, irregular header spacing, decimal commas.
const HEADER =
  "﻿nazione;settore;Nome;Giornaliero ;Settimana;1 Mese;YTD;1 anno;3 anni;attenzione;prezzo Target Long;prezzo  Target short;note;data nota";

const csv = (...rows: string[]) => [HEADER, ...rows].join("\r\n");

test("parses valid rows with Italian number formatting", () => {
  const result = parseWatchlistCsv(
    csv(
      "stati uniti;Healthcare;Baxter;2,64;5,48;-19,46;-36,01;-43,98;-66,68;ribasso;16,3;;;21/09/26",
      "Svizzera;Consumi ciclici;Daetwyl I;0,88;2,95;12,31;20,57;13,26;-15,74;Lateralizzazione;1.234,5;;;21/09/26",
    ),
  );
  assert.deepEqual(result.excluded, []);
  assert.deepEqual(result.rows, [
    { line: 2, name: "Baxter", country: "stati uniti", targetPrice: 16.3 },
    { line: 3, name: "Daetwyl I", country: "Svizzera", targetPrice: 1234.5 },
  ]);
});

test("excludes rows without target or with a note, even when a target is present", () => {
  const result = parseWatchlistCsv(
    csv(
      "stati uniti;Tecnologia;NCR;1,82;3,07;-15,37;-27,17;-30,43;-29,95;ribasso;;;pochi dati ;21/09/26",
      "Francia;Salute;EssilorLuxottica;-0,07;-4,51;-2,13;-1,15;5,25;52,94;Rialzo;139;;in osservazione;21/09/26",
      "Francia;Tecnologia;Alten;-2,61;-6,54;-1,52;-1,31;-11,07;-47,12;Lateralizzazione;abc;;;21/09/26",
      ";;;;;;;;;;10;;;",
    ),
  );
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.excluded, [
    { line: 2, name: "NCR", reason: "missing_target" },
    { line: 3, name: "EssilorLuxottica", reason: "has_note" },
    { line: 4, name: "Alten", reason: "invalid_target" },
    { line: 5, name: "", reason: "missing_name" },
  ]);
});

test("uses an optional ticker column as a manual override", () => {
  const text = [
    "nazione;Nome;prezzo Target Long;note;ticker",
    "stati uniti;Slb NV;31,4;;slb",
    "stati uniti;Bad;10;;DROP TABLE",
    "stati uniti;Clorox;66,2;;",
  ].join("\n");
  const result = parseWatchlistCsv(text);
  assert.deepEqual(result.rows, [
    { line: 2, name: "Slb NV", country: "stati uniti", targetPrice: 31.4, ticker: "SLB" },
    { line: 4, name: "Clorox", country: "stati uniti", targetPrice: 66.2 },
  ]);
  assert.deepEqual(result.excluded, [{ line: 3, name: "Bad", reason: "invalid_ticker" }]);
});

test("ignores blank lines", () => {
  const result = parseWatchlistCsv(csv("stati uniti;Retail;Kohl’s Corp;;;;;;;;13,4;;;", "", "  "));
  assert.equal(result.rows.length, 1);
});

test("rejects files missing a required column", () => {
  assert.throws(() => parseWatchlistCsv("nazione;Nome;note\nFrancia;Alten;"), CsvError);
});

test("rejects files over the row limit", () => {
  const rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => `stati uniti;S${i};10;`);
  assert.throws(() => parseWatchlistCsv(["nazione;Nome;prezzo Target Long;note", ...rows].join("\n")), CsvError);
});
