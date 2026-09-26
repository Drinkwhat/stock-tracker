import { NARROW_BAND, WIDE_BAND, type Report, type ReportLine, type RunKind } from "./bands.ts";

export interface Email {
  subject: string;
  html: string;
  text: string;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const pct = (band: number) => `±${Math.round(band * 100)}%`;
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const signedPct = (d: number) => `${d >= 0 ? "+" : "−"}${(Math.abs(d) * 100).toFixed(2)}%`;

interface Section {
  title: string;
  lines: ReportLine[];
  withFlagDate: boolean;
}

export function renderEmail(report: Report, kind: RunKind, currencies: Map<string, string>, runLabel: string): Email {
  const band = kind === "morning" ? WIDE_BAND : NARROW_BAND;
  const sections: Section[] = [
    { title: `Within ${pct(band)} of target`, lines: report.inBand, withFlagDate: true },
    { title: `Left the ${pct(WIDE_BAND)} band`, lines: report.exitedWide, withFlagDate: false },
    {
      title: `Left the ${pct(NARROW_BAND)} band, still within ${pct(WIDE_BAND)}`,
      lines: report.exitedNarrow,
      withFlagDate: false,
    },
  ].filter((s) => s.lines.length > 0);

  const price = (line: ReportLine, value: number) => `${money(value)} ${currencies.get(line.ticker) ?? ""}`.trim();
  const cells = (line: ReportLine, withFlagDate: boolean) => [
    line.name,
    line.ticker,
    price(line, line.price),
    price(line, line.targetPrice),
    signedPct(line.distance),
    ...(withFlagDate ? [line.firstFlaggedAt ?? ""] : []),
  ];
  const headers = (withFlagDate: boolean) => [
    "Name",
    "Ticker",
    "Price",
    "Target",
    "Distance",
    ...(withFlagDate ? ["First flagged"] : []),
  ];

  const counts = [`${report.inBand.length} within ${pct(band)}`];
  const exits = report.exitedWide.length + report.exitedNarrow.length;
  if (exits > 0) counts.push(`${exits} left a band`);
  const subject = `Stock alerts ${runLabel}: ${counts.join(", ")}`;

  const cellStyle = "padding:4px 10px;border-bottom:1px solid #ddd;text-align:left";
  const htmlSections = sections.map(
    (s) =>
      `<h3 style="margin:20px 0 8px">${escapeHtml(s.title)}</h3>` +
      `<table style="border-collapse:collapse;font-size:14px">` +
      `<tr>${headers(s.withFlagDate).map((h) => `<th style="${cellStyle}">${h}</th>`).join("")}</tr>` +
      s.lines
        .map((l) => `<tr>${cells(l, s.withFlagDate).map((c) => `<td style="${cellStyle}">${escapeHtml(c)}</td>`).join("")}</tr>`)
        .join("") +
      `</table>`,
  );
  const unpricedNote = report.unpriced.length > 0 ? `Prices unavailable for: ${report.unpriced.join(", ")}` : "";

  const html =
    `<div style="font-family:system-ui,sans-serif;color:#1c1f24">` +
    `<h2 style="margin:0 0 4px">Stock alerts</h2><p style="margin:0;color:#5d6470">${escapeHtml(runLabel)}</p>` +
    htmlSections.join("") +
    (unpricedNote ? `<p style="color:#5d6470;margin-top:20px">${escapeHtml(unpricedNote)}</p>` : "") +
    `</div>`;

  const text = [
    `Stock alerts ${runLabel}`,
    ...sections.flatMap((s) => [
      "",
      s.title,
      ...s.lines.map((l) => cells(l, s.withFlagDate).join(" | ")),
    ]),
    ...(unpricedNote ? ["", unpricedNote] : []),
  ].join("\n");

  return { subject, html, text };
}
