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

function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", isError);
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

async function loadWatchlist() {
  const { watchlist } = await api("watchlist");
  watchlist.sort((a, b) => a.name.localeCompare(b.name));
  $("watchlist-rows").replaceChildren(
    ...watchlist.map((item) =>
      el(
        "tr",
        {},
        el("td", { textContent: item.name }),
        el("td", { textContent: item.ticker }),
        el("td", { className: "num", textContent: formatPrice(item.targetPrice) }),
        el("td", { textContent: item.firstFlaggedAt ?? "—" }),
      ),
    ),
  );
  $("watchlist-table").hidden = watchlist.length === 0;
  $("watchlist-empty").hidden = watchlist.length > 0;
  return watchlist.length;
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
  setStatus("");
}

function previewRow(row, index) {
  const listId = `candidates-${index}`;
  const input = el("input", {
    type: "text",
    value: row.ticker ?? "",
    maxLength: 15,
    autocomplete: "off",
    spellcheck: false,
  });
  input.setAttribute("aria-label", `Ticker for ${row.name}`);
  input.dataset.index = index;

  const cell = el("td", {}, input);
  if (row.candidates.length > 1) {
    input.setAttribute("list", listId);
    cell.append(
      el("datalist", { id: listId }, ...row.candidates.map((c) => el("option", { value: c.symbol, label: `${c.name} (${c.exchange})` }))),
    );
  }

  const needsAttention = row.status !== "resolved" && row.status !== "manual";
  return el(
    "tr",
    { className: needsAttention ? "attention" : "" },
    el("td", { textContent: String(row.line) }),
    el("td", { textContent: row.name }),
    el("td", { textContent: row.country }),
    el("td", { className: "num", textContent: formatPrice(row.targetPrice) }),
    cell,
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
    $("file").value = "";
  });
  $("save").addEventListener("click", save);
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
