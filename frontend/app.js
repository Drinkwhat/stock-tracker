const config = await (await fetch("config.json")).json();
const REDIRECT_URI = `${location.origin}/`;

// Kept in memory only; a reload signs in again silently through the Cognito session.
let idToken = null;
let previewRows = [];

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function setStatus(message, isError = false, target = $("status")) {
  target.textContent = message;
  target.classList.toggle("error", isError);
}

// --- Authentication (authorization code + PKCE) ---

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function signIn() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem("pkce", JSON.stringify({ verifier, state }));
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

  const url = new URL("/oauth2/authorize", config.cognitoDomain);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    scope: "openid email",
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  location.assign(url);
}

async function completeSignIn(params) {
  const saved = JSON.parse(sessionStorage.getItem("pkce") ?? "null");
  sessionStorage.removeItem("pkce");
  history.replaceState(null, "", REDIRECT_URI);
  if (!saved || saved.state !== params.get("state")) throw new Error("Sign-in failed, please try again.");

  const res = await fetch(new URL("/oauth2/token", config.cognitoDomain), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code: params.get("code"),
      redirect_uri: REDIRECT_URI,
      code_verifier: saved.verifier,
    }),
  });
  if (!res.ok) throw new Error("Sign-in failed, please try again.");
  idToken = (await res.json()).id_token;
}

function signOut() {
  idToken = null;
  const url = new URL("/logout", config.cognitoDomain);
  url.search = new URLSearchParams({ client_id: config.clientId, logout_uri: REDIRECT_URI });
  location.assign(url);
}

function tokenEmail() {
  const payload = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(payload)).email;
}

// --- API ---

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `Request failed (${status})`);
    this.body = body;
  }
}

async function api(path, options = {}) {
  const res = await fetch(new URL(path, config.apiUrl), {
    ...options,
    headers: { ...options.headers, authorization: `Bearer ${idToken}` },
  });
  if (res.status === 401) {
    await signIn();
    return new Promise(() => {});
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

// --- Current watchlist ---

const ICON_REMOVE =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>';
const ICON_UNDO =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5L3.5 8.5 7 12M4 8.5h7.5a4.5 4.5 0 010 9H9" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const flaggedDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

const field = (row, name) => row.querySelector(`[data-field="${name}"]`);
const setWatchlistStatus = (message, isError = false) => {
  setStatus(message, isError, $("watchlist-status"));
  updateChanges();
};

async function loadWatchlist() {
  const { watchlist } = await api("watchlist");
  watchlist.sort((a, b) => a.name.localeCompare(b.name));
  $("watchlist-rows").replaceChildren(...watchlist.map((item) => watchlistRow(item)));
  applyFilter();
  // The CSV is for onboarding; afterwards the list is edited in place.
  $("upload").hidden = watchlist.length > 0;
  $("watchlist").hidden = watchlist.length === 0;
  setWatchlistStatus("");
  return watchlist.length;
}

function watchlistRow(item) {
  const isNew = !item;
  item ??= { name: "", ticker: "", targetPrice: "", firstFlaggedAt: null };
  const label = item.name || "new stock";
  const input = (name, ariaLabel, value, props = {}) => {
    const node = el("input", { type: "text", value: String(value), autocomplete: "off", spellcheck: false, ...props });
    node.className = `cell-input ${name}-input`;
    node.dataset.field = name;
    node.dataset.saved = node.value;
    node.setAttribute("aria-label", ariaLabel);
    return node;
  };

  const remove = el("button", { type: "button", className: "icon-button", innerHTML: ICON_REMOVE });
  remove.setAttribute("aria-label", `Remove ${label}`);
  const flagged = item.firstFlaggedAt
    ? el("span", {
        className: "flag",
        title: `In the ±5% range since ${item.firstFlaggedAt}`,
        textContent: flaggedDate.format(new Date(`${item.firstFlaggedAt}T12:00`)),
      })
    : "";

  const row = el(
    "tr",
    { className: isNew ? "new" : "" },
    el("td", { className: "c-name" }, input("name", `Name of ${label}`, item.name, { placeholder: "Company name" })),
    el("td", { className: "c-ticker" }, input("ticker", `Ticker of ${label}`, item.ticker, { placeholder: "Ticker", maxLength: 15 })),
    el("td", { className: "c-chart chart" }, item.tradingViewUrl ? chartLink(item.tradingViewUrl, item.ticker) : ""),
    el(
      "td",
      { className: "c-target num" },
      input("targetPrice", `Target in EUR for ${label}`, item.targetPrice, { placeholder: "Target", inputMode: "decimal" }),
    ),
    el("td", { className: "c-flag" }, flagged),
    el("td", { className: "c-remove" }, remove),
  );
  remove.addEventListener("click", () => toggleRemoved(row, remove, label));
  // New stocks: look up the ticker when the name is entered.
  if (isNew) {
    field(row, "name").addEventListener("change", (event) =>
      suggestTickers(event.target.value, field(row, "ticker"), row.querySelector(".chart")).catch((err) =>
        setWatchlistStatus(err.message, true),
      ),
    );
  }
  return row;
}

// Filters only what is shown; hidden rows are still saved. Unsaved new rows always stay visible.
function applyFilter() {
  const raw = $("filter").value.trim();
  const query = raw.toLowerCase();
  const rows = [...$("watchlist-rows").rows];
  let shown = 0;
  for (const row of rows) {
    const text = `${field(row, "name").value} ${field(row, "ticker").value}`.toLowerCase();
    row.hidden = !row.classList.contains("new") && !text.includes(query);
    if (!row.hidden) shown++;
  }
  const total = rows.filter((row) => !row.classList.contains("new")).length;
  $("watchlist-count").textContent = query ? `${shown} of ${total}` : total === 1 ? "1 stock" : `${total} stocks`;
  $("watchlist-table").hidden = rows.length > 0 && shown === 0;
  $("no-match").hidden = !query || shown > 0;
  $("no-match").textContent = `No stocks match “${raw}”.`;
}

function toggleRemoved(row, button, label) {
  if (row.classList.contains("new")) {
    row.remove();
    updateChanges();
    return;
  }
  const removed = row.classList.toggle("removed");
  row.querySelectorAll("input, select").forEach((i) => (i.disabled = removed));
  button.innerHTML = removed ? ICON_UNDO : ICON_REMOVE;
  button.setAttribute("aria-label", removed ? `Keep ${label}` : `Remove ${label}`);
  updateChanges();
}

function pendingChanges() {
  let count = 0;
  for (const row of $("watchlist-rows").rows) {
    if (row.classList.contains("removed") || row.classList.contains("new")) {
      count++;
      continue;
    }
    let edited = false;
    for (const input of row.querySelectorAll("input")) {
      const changed = input.value.trim() !== input.dataset.saved;
      input.classList.toggle("edited", changed);
      edited ||= changed;
    }
    if (edited) count++;
  }
  return count;
}

function updateChanges() {
  const count = pendingChanges();
  $("changes").textContent = count === 0 ? "" : `${count} unsaved ${count === 1 ? "change" : "changes"}`;
  $("save-watchlist").disabled = count === 0;
  $("discard-watchlist").disabled = count === 0;
  $("savebar").hidden = count === 0 && !$("watchlist-status").textContent;
  $("watchlist").hidden = $("watchlist-rows").rows.length === 0 && !$("upload").hidden;
}

const chartLink = (href, ticker) => {
  const link = el("a", { href, target: "_blank", rel: "noopener", className: "chart-link", textContent: "Chart" });
  link.setAttribute("aria-label", `Open ${ticker} on TradingView (new tab)`);
  return link;
};

// Shows the search matches in a dropdown under the ticker input; the chart link follows the chosen
// ticker so it can be checked on TradingView before saving.
function attachCandidates(input, candidates, chartCell) {
  input.parentElement.querySelector("select")?.remove();
  const showChart = () => {
    const ticker = input.value.trim().toUpperCase();
    const match = input.candidates.find((c) => c.symbol === ticker);
    chartCell.replaceChildren(match?.tradingViewUrl ? chartLink(match.tradingViewUrl, ticker) : "");
  };
  if (!input.candidates) input.addEventListener("input", showChart);
  input.candidates = candidates;

  if (candidates.length > 1) {
    const select = el(
      "select",
      { className: "candidates" },
      ...candidates.map((c) =>
        el("option", { value: c.symbol, textContent: `${c.symbol} · ${c.name} (${c.exchange})`, selected: c.symbol === input.value }),
      ),
    );
    select.setAttribute("aria-label", "Matching stocks");
    select.addEventListener("change", () => {
      input.value = select.value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    input.after(select);
  }
  showChart();
}

async function suggestTickers(name, tickerInput, chartCell) {
  if (!name.trim()) return;
  setWatchlistStatus(`Looking up ${name}…`);
  tickerInput.setAttribute("aria-busy", "true");
  try {
    const { candidates } = await api(`watchlist/search?${new URLSearchParams({ q: name.trim() })}`);
    if (!tickerInput.value.trim() && candidates.length > 0) tickerInput.value = candidates[0].symbol;
    attachCandidates(tickerInput, candidates, chartCell);
    tickerInput.dispatchEvent(new Event("input", { bubbles: true }));
    if (candidates.length === 0) return setWatchlistStatus(`No ticker found for ${name}. Enter it by hand.`, true);
    setWatchlistStatus(
      candidates.length === 1
        ? `Found ${candidates[0].symbol} on ${candidates[0].exchange}. Check the chart before saving.`
        : `${candidates.length} matches for ${name}. Pick one and check the chart before saving.`,
    );
  } finally {
    tickerInput.removeAttribute("aria-busy");
  }
}

function addStock() {
  $("upload").hidden = true;
  const row = watchlistRow();
  $("watchlist-rows").append(row);
  updateChanges();
  field(row, "name").focus();
}

async function saveWatchlist() {
  const rows = [...$("watchlist-rows").rows].filter((row) => !row.classList.contains("removed"));
  rows.forEach((row) => row.querySelectorAll("input").forEach((i) => i.classList.remove("invalid")));

  const items = rows.map((row) => ({
    name: field(row, "name").value,
    ticker: field(row, "ticker").value,
    // Accept Italian decimals ("16,3"); anything unparseable is rejected by the server.
    targetPrice: Number(field(row, "targetPrice").value.trim().replace(",", ".")) || null,
  }));
  if (items.length === 0 && !confirm("Remove every stock from your watchlist?")) return;

  const button = $("save-watchlist");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const { saved } = await api("watchlist", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
    });
    await loadWatchlist();
    const message = `Saved. Your watchlist has ${saved} ${saved === 1 ? "stock" : "stocks"}.`;
    setWatchlistStatus(message);
    setTimeout(() => $("watchlist-status").textContent === message && setWatchlistStatus(""), 4000);
  } catch (err) {
    const details = err.body?.details ?? [];
    for (const detail of details) field(rows[detail.index], detail.field)?.classList.add("invalid");
    rows[details[0]?.index]?.querySelector(".invalid")?.focus();
    setWatchlistStatus(details.length ? "Fix the fields marked in red. Tickers must be unique." : err.message, true);
  } finally {
    button.textContent = "Save changes";
    updateChanges();
  }
}

async function discardChanges() {
  await loadWatchlist();
}

const formatPrice = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });

// --- Upload and review ---

const LOOKUP_LABELS = {
  resolved: "Found",
  ambiguous: "Several matches, check",
  manual: "From file",
  not_found: "Not found, enter ticker",
  unsupported_country: "Country not supported, enter ticker",
  error: "Lookup failed, enter ticker",
};

const EXCLUSION_LABELS = {
  missing_name: "no name",
  missing_target: "no long target price",
  invalid_target: "invalid target price",
  has_note: "has a note",
  invalid_ticker: "invalid ticker",
};

async function previewFile(file) {
  setStatus(`Looking up tickers for ${file.name}…`);
  $("preview").hidden = true;
  const { rows, excluded } = await api("watchlist/preview", {
    method: "POST",
    headers: { "content-type": "text/csv" },
    body: await file.text(),
  });
  previewRows = rows;

  $("preview-rows").replaceChildren(...rows.map(previewRow));
  const toCheck = rows.filter((r) => r.status !== "resolved" && r.status !== "manual").length;
  $("preview-summary").textContent =
    `${rows.length} stocks ready, ${excluded.length} skipped.` +
    (toCheck ? ` ${toCheck} need your attention (highlighted).` : "");

  $("excluded").hidden = excluded.length === 0;
  $("excluded").querySelector("summary").textContent = `${excluded.length} skipped rows`;
  $("excluded-rows").replaceChildren(
    ...excluded.map((e) => el("li", { textContent: `Line ${e.line}: ${e.name || "(no name)"}, ${EXCLUSION_LABELS[e.reason]}` })),
  );

  $("preview").hidden = false;
  $("upload").hidden = true;
  setStatus("");
}

function previewRow(row, index) {
  const input = el("input", {
    type: "text",
    value: row.ticker ?? "",
    maxLength: 15,
    autocomplete: "off",
    spellcheck: false,
  });
  input.className = "cell-input ticker-input";
  input.setAttribute("aria-label", `Ticker for ${row.name}`);
  input.dataset.index = index;

  const cell = el("td", {}, input);
  const chartCell = el("td");
  if (row.candidates.length > 0) attachCandidates(input, row.candidates, chartCell);

  const needsAttention = row.status !== "resolved" && row.status !== "manual";
  return el(
    "tr",
    { className: needsAttention ? "attention" : "" },
    el("td", { textContent: String(row.line) }),
    el("td", { textContent: row.name }),
    el("td", { textContent: row.country }),
    el("td", { className: "num", textContent: formatPrice(row.targetPrice) }),
    cell,
    chartCell,
    el("td", { textContent: LOOKUP_LABELS[row.status] }),
  );
}

async function save() {
  const inputs = [...$("preview-rows").querySelectorAll("input")];
  inputs.forEach((i) => i.classList.remove("invalid"));

  const entries = inputs
    .map((input) => ({ input, row: previewRows[input.dataset.index], ticker: input.value.trim().toUpperCase() }))
    .filter((e) => e.ticker);
  const skipped = inputs.length - entries.length;

  const message =
    `Replace your current watchlist with ${entries.length} stocks?` +
    (skipped ? `\n${skipped} rows without a ticker will be left out.` : "");
  if (!confirm(message)) return;

  try {
    const { saved } = await api("watchlist", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: entries.map((e) => ({ name: e.row.name, ticker: e.ticker, targetPrice: e.row.targetPrice })),
      }),
    });
    $("preview").hidden = true;
    $("file").value = "";
    await loadWatchlist();
    setStatus(`Watchlist saved: ${saved} stocks.`);
  } catch (err) {
    for (const detail of err.body?.details ?? []) entries[detail.index]?.input.classList.add("invalid");
    setStatus(err.body?.details ? "Some tickers are invalid or duplicated (highlighted in red)." : err.message, true);
  }
}

// --- Startup ---

async function main() {
  $("sign-in").addEventListener("click", signIn);
  $("sign-out").addEventListener("click", signOut);
  $("cancel").addEventListener("click", () => {
    $("preview").hidden = true;
    $("upload").hidden = false;
    $("file").value = "";
  });
  $("save").addEventListener("click", save);
  $("add-stock").addEventListener("click", addStock);
  $("add-manually").addEventListener("click", addStock);
  $("save-watchlist").addEventListener("click", saveWatchlist);
  $("discard-watchlist").addEventListener("click", () => discardChanges().catch((err) => setWatchlistStatus(err.message, true)));
  $("watchlist-rows").addEventListener("input", updateChanges);
  $("filter").addEventListener("input", applyFilter);
  $("filter").addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.target.value = "";
    applyFilter();
  });
  addEventListener("keydown", (event) => {
    const typing = event.target.closest?.("input, select, textarea");
    if (event.key === "/" && !typing && !$("watchlist").hidden) {
      event.preventDefault();
      $("filter").focus();
    }
  });
  addEventListener("beforeunload", (event) => {
    if (!$("app").hidden && pendingChanges() > 0) event.preventDefault();
  });
  $("file").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) previewFile(file).catch((err) => setStatus(err.message, true));
  });

  const params = new URLSearchParams(location.search);
  if (params.has("code")) await completeSignIn(params);
  if (params.has("error")) setStatus("Sign-in was cancelled or failed.", true);

  if (!idToken) {
    $("signed-out").hidden = false;
    return;
  }

  $("user-email").textContent = tokenEmail();
  $("account").hidden = false;
  $("app").hidden = false;
  await loadWatchlist();
}

main().catch((err) => setStatus(err.message, true));
