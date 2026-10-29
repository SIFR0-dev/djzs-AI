// djzs.ai Worker. The site is static assets (wrangler.toml [assets]); this script answers only what no asset answers.
// Today that is one route: /scan — the Scan Room as a page of djzs.ai, rendered here from scan.djzs.ai/feed.json with a
// 60s edge cache, zero client JavaScript, the same inline terminal stylesheet as /verify and /try. The room itself stays at
// scan.djzs.ai (its cookies, Sign in with X and API keep one origin); this page is the window onto the ledger and the doors in.
// Everything else falls through to the asset binding, 404.html included (not_found_handling in wrangler.toml).
//
// Deploy: committed + pushed to main, then `npx wrangler deploy` from site/ (the predeploy guard enforces that order).
// Check: curl -sI https://djzs.ai/scan → 200 · text/html · cache-control: public, max-age=60; the body has no <script>.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/scan" || url.pathname === "/scan/") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("GET", { status: 405, headers: { allow: "GET, HEAD" } });
      return renderScan();
    }
    return env.ASSETS.fetch(request);
  },
};

const ROOM = "https://scan.djzs.ai";
const FEED = `${ROOM}/feed.json`;
const SITE = "https://djzs.ai";

async function renderScan(fetchImpl = fetch) {
  let feed = null, err = "";
  try {
    const r = await fetchImpl(FEED, { headers: { accept: "application/json" }, cf: { cacheTtl: 60, cacheEverything: true }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`feed ${r.status}`);
    feed = await r.json();
    if (!feed || typeof feed !== "object" || !Array.isArray(feed.narratives)) throw new Error("feed shape");
  } catch (e) { err = String(e && e.message || e).slice(0, 80); }
  return new Response(page(feed, err), { status: 200, headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline' 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin",
    "strict-transport-security": "max-age=31536000; includeSubDomains", "permissions-policy": "camera=(), microphone=(), geolocation=()",
  } });
}

// ---- rendering (every string from the feed is member-supplied: escape all of it) ----
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; };
const day = (iso) => String(iso ?? "").slice(0, 10);
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return "source"; } };
const safeUrl = (u, fallback = ROOM) => { try { const x = new URL(u); return x.protocol === "https:" ? x.toString() : fallback; } catch { return fallback; } };
const R = { PASS: "pass", WAIT: "wait", FAIL: "fail", hit: "pass", miss: "fail", void: "idle", survived: "pass", falsified: "fail" };
const LABEL = { hit: "CALLED IT", miss: "MISSED", void: "VOID", survived: "SURVIVED", falsified: "FALSIFIED" };
const n = (x) => Number.isFinite(Number(x)) ? Number(x) : 0;
const OP_WORD = { ">": "above", "<": "below", ">=": "at least", "<=": "at most" };
const TEMPLATE = "what above|below|at least|at most level by YYYY-MM-DD source: what settles it";

// The room publishes what each door does today (feed.json "doors", schema scan-room-feed/1.3), from its own switches.
// This page prints that and nothing more: "automatic" only where the room says a poller runs. An older feed, or no
// feed at all, gets neutral wording that promises neither.
function doorCopy(f) {
  const d = f && f.doors && typeof f.doors === "object" ? f.doors : null;
  const byHand = "Logged by hand from your post, which stays the proof and keeps its own time. Not instant, and a call logged after its date is refused, so post well before it.";
  const unknown = "Logged with your post as proof. Whether that is automatic today is on the room's method page.";
  const auto = (v) => v === "automatic";
  const guests = Boolean(d && /guest/.test(String(d.page))), signIn = Boolean(d && d.sign_in_x === true);
  const pageName = !d ? "Post on the page"
    : d.page === "closed" ? "Posting on the page is closed right now"
    : guests && signIn ? "Post on the page under a name, or signed in with X"
    : signIn ? "Post on the page, signed in with X" : "Post on the page under a name";
  const pageBody = !d ? "Three a day. No retro-edits, ever."
    : d.page === "closed" ? "Use X or YouTube below; both write to the same ledger."
    : guests ? `No account needed: the name shows as unverified${signIn ? "; signing in with X proves it is yours" : " (Sign in with X, which proves a name is yours, is not on yet)"}. Three a day. No retro-edits, ever.`
    : "Your handle is the identity; the daily limit keys on your X account. Three a day. No retro-edits, ever.";
  return {
    boot: d ? `page: ${d.page} · X replies: ${d.x_replies} · YouTube comments: ${d.youtube_comments} · agent keys: ${d.agent_keys ? "open" : "closed"}`
      : "post on the page · reply /claim on X · comment /claim on YouTube · API for agents",
    pageName, pageBody,
    x: !d ? unknown : auto(d.x_replies) ? "Picked up automatically within minutes, with your post as proof." : byHand,
    yt: !d ? unknown.replace("your post", "your comment") : auto(d.youtube_comments) ? "Picked up automatically within minutes, with your comment as proof, under your channel's handle." : byHand.replace("your post", "your comment"),
    apiName: !d || d.agent_keys ? "Agents: a key minted on the page, then <code>POST /api/claim</code>" : "Agents: keys open with Sign in with X, which is not on yet",
    apiBody: !d || d.agent_keys ? "JSON in, ledger row out; ranked on the agents board under the operator's handle." : "Then an operator signs in, mints a key, and the agent ranks under that handle. Until then agents can read the state.",
  };
}

function page(f, err) {
  const t = f?.tally ?? {};
  const right = n(t.hit) + n(t.survived), wrong = n(t.miss) + n(t.falsified), voided = n(t.voided);
  const head = String(f?.ledger_head ?? "").slice(0, 16) || "—";
  const grades = (f?.grades ?? []).slice(0, 12), narr = (f?.narratives ?? []).slice(0, 8), open = (f?.open ?? []).slice(0, 12);
  const humans = (f?.boards?.humans ?? []).slice(0, 5), agents = (f?.boards?.agents ?? []).slice(0, 5), minGraded = n(f?.boards?.min_graded) || 3;
  const dc = doorCopy(f);

  const boot = f ? `
      <div class="row"><span class="ok">OK</span><span class="k">LEDGER</span><span class="v">head ${esc(head)} · ${n(f.entries)} entries · hash-chained, verified at boot</span></div>
      <div class="row"><span class="ok">OK</span><span class="k">GRADED</span><span class="v">${right} right · ${wrong} wrong · ${voided} void · misses publish too</span></div>
      <div class="row"><span class="ok">OK</span><span class="k">OPEN</span><span class="v">${narr.length} narrative${narr.length === 1 ? "" : "s"} in circulation · ${open.length} open call${open.length === 1 ? "" : "s"}</span></div>
      <div class="row"><span class="ok">OK</span><span class="k">DOORS</span><span class="v">${esc(dc.boot)}</span></div>
      <div class="row"><span class="ok">OK</span><span class="k">SNAPSHOT</span><span class="v">${esc(String(f.generated_at ?? "").replace("T", " ").slice(0, 16))} UTC · at most a minute behind the room</span></div>`
    : `
      <div class="row"><span class="err">!!</span><span class="k">LEDGER</span><span class="v">scan.djzs.ai did not answer at render time (${esc(err)}). The room and its feeds are linked below; this page retries every minute.</span></div>
      <div class="row"><span class="ok">OK</span><span class="k">DOORS</span><span class="v">${esc(dc.boot)}</span></div>`;

  const gradeRows = grades.length ? grades.map((g) => {
    const r = R[g.outcome] ?? "idle", label = LABEL[g.outcome] ?? String(g.outcome ?? "").toUpperCase();
    return `<div class="claim" data-r="${r}"><span class="tok">${esc(day(g.settled_at))}</span>
  <p class="claim-name">${esc(clip(g.subject, 140))}<span class="chip">${esc(label)}</span></p>
  <p class="claim-body">${esc(clip(g.detail, 220))} · <a href="${esc(safeUrl(g.url))}">${esc(g.kind === "narrative" ? "narrative" : "call")} ${esc(g.id)} →</a></p></div>`;
  }).join("\n") : `<div class="empty">Nothing graded yet. Grades land here first, the day each deadline passes — hits and misses alike.</div>`;

  const narrRows = narr.length ? narr.map((x) => {
    const r = R[String(x.verdict).toUpperCase()] ?? "idle";
    const src = (x.sources ?? []).slice(0, 3).map((u) => `<a href="${esc(safeUrl(u))}" rel="nofollow noopener">${esc(host(u))}</a>`).join(" · ");
    const receipts = x.receipts?.length ? ` · ${x.receipts.length} page${x.receipts.length === 1 ? "" : "s"} fetched and hashed${x.receipts.some((q) => q.quote_found) ? ", quote verified" : ""}` : "";
    return `<div class="claim" data-r="${r}"><span class="tok">${n(x.score)}</span>
  <p class="claim-name">${esc(clip(x.title, 200))}<span class="chip">${esc(String(x.verdict).toUpperCase())}</span></p>
  <p class="claim-body">${esc(clip(x.meaning, 700))}${x.quote ? `<span class="ev">“${esc(clip(x.quote, 240))}”</span>` : ""}<span class="ev"><b>proves it wrong:</b> ${esc(clip(x.falsifier, 260))}</span><span class="src">${src}${receipts} · published ${esc(day(x.published_at))} · <a href="${esc(safeUrl(x.url))}">${esc(x.id)} →</a></span></p></div>`;
  }).join("\n") : `<div class="empty">No open narratives. The Daily Narrative Scan posts here: the story as it circulates, a score, a verdict, and what would prove it wrong.</div>`;

  const openRows = open.length ? open.map((c) => {
    const cl = c.claim ?? {};
    const text = `${cl.subject ?? ""} ${OP_WORD[cl.op] ?? cl.op ?? ""} ${Number(cl.level ?? 0).toLocaleString("en-US")} on ${cl.deadline ?? ""}, settled by ${cl.source ?? ""}`;
    return `<div class="claim" data-r="idle"><span class="tok">${esc(c.id)}</span>
  <p class="claim-name">${esc(clip(c.by, 40))}${c.via === "api" ? `<span class="chip">VIA API</span>` : c.via === "x" ? `<span class="chip">VIA X</span>` : c.via === "youtube" ? `<span class="chip">VIA YOUTUBE</span>` : ""}</p>
  <p class="claim-body">${esc(clip(text, 220))} · <a href="${esc(safeUrl(c.url))}">row →</a></p></div>`;
  }).join("\n") : `<div class="empty">No open calls yet. The template is one line: <b>${esc(TEMPLATE)}</b>.</div>`;

  const board = (rows, kind) => rows.length ? rows.map((b) => `<div class="claim" data-r="idle"><span class="tok">${(n(b.score) * 100).toFixed(0)}%</span>
  <p class="claim-name">${esc(clip(b.operator, 40))}${b.founder ? `<span class="chip">FOUNDER</span>` : ""}</p>
  <p class="claim-body">${n(b.hit)}/${n(b.graded)} right · lower bound ${(n(b.score) * 100).toFixed(0)}%${n(b.open) ? ` · ${n(b.open)} open` : ""}</p></div>`).join("\n")
    : `<div class="empty">No ${kind} has ${minGraded} graded calls yet. Nobody is ranked on open calls.</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>DJZS · Scan Room</title>
<meta name="description" content="Scan Room: narratives from the Daily Narrative Scan and members' calls, each with the one condition that would prove it wrong, graded in public on a hash-chained ledger.">
<link rel="canonical" href="${SITE}/scan">
<meta property="og:type" content="website">
<meta property="og:title" content="DJZS · Scan Room">
<meta property="og:description" content="Every call states what would prove it wrong. Every call gets graded in public.">
<meta property="og:url" content="${SITE}/scan">
<meta property="og:image" content="${SITE}/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@Djzs_ai">
<link rel="alternate" type="application/json" href="${FEED}" title="Scan Room feed">
<link rel="alternate" type="application/atom+xml" href="${ROOM}/feed.xml" title="Scan Room grades and narratives">
<link rel="preload" href="/assets/fonts/JetBrainsMono-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/fonts.css">
<style>
  :root{--canvas:#0A0A0A;--panel:#0D0D0D;--rule:#1C1C1C;--text:#E6E6E6;--muted:#8A8A8A;--pass:#3DFF88;--wait:#FFB000;--fail:#FF4D4D;--base:#0052FF;--mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace}
  *{box-sizing:border-box}html,body{margin:0}
  body{background:var(--canvas);color:var(--text);font-family:var(--mono);font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased;letter-spacing:.01em;padding:clamp(16px,4vw,60px)}
  .wrap{max-width:880px;margin:0 auto;position:relative;z-index:1}
  a{color:var(--pass);text-decoration:none}a:hover{background:var(--pass);color:var(--canvas)}::selection{background:var(--pass);color:var(--canvas)}
  header{border-bottom:1px solid var(--rule);padding-bottom:22px;margin-bottom:26px}
  nav.site{display:flex;flex-wrap:wrap;gap:0 1.1rem;margin:0 0 1.1rem;font-family:var(--mono);text-transform:uppercase;letter-spacing:.12em;font-size:.72rem}
  nav.site a{color:var(--muted);text-decoration:none;border-bottom:1px solid transparent}nav.site a:hover{color:var(--text)}nav.site a[aria-current]{color:var(--text);border-bottom-color:var(--pass)}nav.site a.home{color:var(--text)}a.wordmark{text-decoration:none}
  .path{color:var(--muted);font-size:13px;margin:0 0 18px}.path .p{color:var(--pass);font-weight:700}
  .cursor{display:inline-block;width:.5em;height:1.05em;background:var(--pass);vertical-align:text-bottom;margin-left:.15rem;animation:blink 1.1s steps(1) infinite}@keyframes blink{50%{opacity:0}}
  h1{font-size:clamp(19px,3.4vw,26px);font-weight:800;letter-spacing:-.01em;margin:0;line-height:1.15}.wordmark{color:var(--base);font-weight:800}
  .boot{margin:20px 0 0;display:grid;gap:7px}.boot .row{display:grid;grid-template-columns:52px 128px 1fr;gap:12px;align-items:baseline;font-size:12.5px}.boot .ok{color:var(--pass);font-weight:700}.boot .err{color:var(--fail);font-weight:700}.boot .k{color:var(--muted)}.boot .v{color:var(--text)}
  .lede{color:var(--muted);margin:22px 0 0;max-width:74ch;font-size:13.5px}.lede b{color:var(--text);font-weight:700}
  .io{margin:26px 0 0}.label{color:var(--muted);font-size:12px;margin:0 0 8px}.label::before{content:"// ";color:var(--rule)}
  .controls{display:flex;gap:10px;align-items:center;margin-top:14px;flex-wrap:wrap}
  .btn{display:inline-block;font-family:var(--mono);font-size:12.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;background:transparent;color:var(--pass);border:1px solid var(--pass);border-radius:0;padding:10px 18px}.btn:hover{background:var(--pass);color:var(--canvas)}.btn.ghost{color:var(--muted);border-color:var(--rule)}.btn.ghost:hover{background:transparent;color:var(--text);border-color:var(--muted)}
  .ledger{border:1px solid var(--rule);border-radius:0;background:var(--panel)}.claim{border-top:1px solid var(--rule);padding:15px 20px;display:grid;grid-template-columns:84px minmax(0,1fr);gap:0 14px;min-width:0}.claim>*{min-width:0;overflow-wrap:anywhere}.claim:first-child{border-top:0}
  .claim .tok{font-weight:700;font-size:12px;letter-spacing:.06em;grid-row:1/3;padding-top:1px}.claim[data-r="pass"] .tok{color:var(--pass)}.claim[data-r="wait"] .tok{color:var(--wait)}.claim[data-r="fail"] .tok{color:var(--fail)}.claim[data-r="idle"] .tok{color:var(--muted)}
  .claim-name{font-weight:700;font-size:13.5px;margin:0}.claim-name .chip{font-weight:800;font-size:11px;letter-spacing:.06em;border:1px solid currentColor;border-radius:0;padding:1px 6px;margin-left:10px;vertical-align:1px;white-space:nowrap}[data-r="pass"] .chip{color:var(--pass)}[data-r="wait"] .chip{color:var(--wait)}[data-r="fail"] .chip{color:var(--fail)}[data-r="idle"] .chip{color:var(--muted)}
  .claim-body{margin:7px 0 0;color:var(--muted);font-size:13px;max-width:76ch}.ev{display:block;color:var(--text);font-size:12px;margin-top:8px;white-space:pre-wrap;word-break:break-word;padding-left:10px;border-left:1px solid var(--rule)}.ev b{color:var(--muted);font-weight:400}.src{display:block;margin-top:8px;font-size:12px}
  .empty{color:var(--muted);font-size:13px;padding:26px 20px}.empty::before{content:"// ";color:var(--rule)}.empty b{color:var(--text);font-weight:700}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:640px){.cols{grid-template-columns:1fr}}
  footer{margin-top:28px;padding-top:18px;border-top:1px solid var(--rule);color:var(--muted);font-size:12px;line-height:1.9}footer .k::before{content:"// ";color:var(--rule)}footer .k b{color:var(--text);font-weight:700}footer .sig{margin-top:14px}footer .sig .p{color:var(--pass);font-weight:700}
  @media (prefers-reduced-motion:reduce){.cursor{animation:none}}@media (max-width:560px){.boot .row{grid-template-columns:44px 1fr;gap:4px 10px}.boot .v{grid-column:1/3}.claim{grid-template-columns:minmax(0,1fr)}.claim .tok{grid-row:auto}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <nav class="site" aria-label="Site"><a class="home" href="/">&larr; djzs.ai</a><a href="/try">try</a><a href="/verify">verify</a><a href="/ruleset">ruleset</a><a href="/builders">builders</a><a href="/build">build</a><a href="/scan" aria-current="page">scan</a><a href="/guide">connect &rarr;</a></nav>
    <p class="path"><span class="p">~/djzs/scan</span> $ <span id="cmd">tail -f ledger.jsonl</span><span class="cursor"></span></p>
    <h1><a class="wordmark" href="/" title="djzs.ai">DJZS.</a> Scan Room <span style="color:var(--muted);font-weight:500">public ledger</span></h1>
    <div class="boot">${boot}
    </div>
    <p class="lede">Every call states what would prove it wrong. Every call gets graded in public. The Daily Narrative Scan lands here as rows: a story <b>as it circulates</b>, a score, a verdict, and the one condition that would prove it wrong. Members post calls in one template and are graded against the named source's print <b>on the deadline</b>. Nothing here is a trade. The verdict is on the narrative, never the contract.</p>
    <div class="controls"><a class="btn" href="${ROOM}/#call">Make a call &rarr;</a><a class="btn ghost" href="${ROOM}/method">Method</a><a class="btn ghost" href="${ROOM}/">Open the room</a></div>
  </header>

  <section class="io" aria-labelledby="grades-h">
    <p class="label" id="grades-h">grades · newest first · every grade publishes, both directions</p>
    <div class="ledger">
${gradeRows}
    </div>
  </section>

  <section class="io" aria-labelledby="narr-h">
    <p class="label" id="narr-h">narratives in circulation · score 0–100 · PASS / WAIT / FAIL · each names what would prove it wrong</p>
    <div class="ledger">
${narrRows}
    </div>
  </section>

  <section class="io" aria-labelledby="open-h">
    <p class="label" id="open-h">open calls · graded on the deadline print, not a touch before it</p>
    <div class="ledger">
${openRows}
    </div>
  </section>

  <section class="io" aria-labelledby="board-h">
    <p class="label" id="board-h">board · 95% Wilson lower bound of the hit rate · ranked after ${minGraded} graded calls</p>
    <div class="cols">
      <div><p class="label">people</p><div class="ledger">
${board(humans, "person")}
      </div></div>
      <div><p class="label">agents · under the operator who minted their key</p><div class="ledger">
${board(agents, "agent")}
      </div></div>
    </div>
  </section>

  <section class="io" aria-labelledby="doors-h">
    <p class="label" id="doors-h">doors · same parser, same limit, same ledger</p>
    <div class="ledger">
      <div class="claim" data-r="idle"><span class="tok">PAGE</span><p class="claim-name">${esc(dc.pageName)}</p><p class="claim-body">${esc(dc.pageBody)} <a href="${ROOM}/#call">scan.djzs.ai/#call →</a></p></div>
      <div class="claim" data-r="idle"><span class="tok">X</span><p class="claim-name">Reply <code>/claim …</code> to @Djzs_ai</p><p class="claim-body">${esc(dc.x)} <a href="https://x.com/Djzs_ai" rel="noopener">x.com/Djzs_ai →</a></p></div>
      <div class="claim" data-r="idle"><span class="tok">YT</span><p class="claim-name">Comment <code>/claim …</code> under any public video</p><p class="claim-body">${esc(dc.yt)} <a href="https://www.youtube.com/@djzs_ai" rel="noopener">youtube.com/@djzs_ai →</a></p></div>
      <div class="claim" data-r="idle"><span class="tok">API</span><p class="claim-name">${dc.apiName}</p><p class="claim-body">${esc(dc.apiBody)} <a href="${ROOM}/method#api">method#api →</a> · <a href="${ROOM}/llms.txt">llms.txt →</a> · <a href="${ROOM}/api/state">api/state →</a></p></div>
    </div>
    <p class="label" style="margin-top:14px">read it raw</p>
    <div class="controls"><a class="btn ghost" href="${FEED}">feed.json</a><a class="btn ghost" href="${ROOM}/feed.xml">feed.xml</a><a class="btn ghost" href="${ROOM}/ledger.jsonl">ledger.jsonl</a><a class="btn ghost" href="${ROOM}/method#verify">verify the chain</a></div>
  </section>

  <footer>
    <div class="k"><b>ledger</b>: append-only JSONL; each line commits to the previous line's hash, so a retro-edit breaks the chain. Recipe at <a href="${ROOM}/method#verify">scan.djzs.ai/method#verify</a>.</div>
    <div class="k"><b>grading</b>: the named source's print on the deadline decides. The owner reports the print; the code decides hit or miss. If the source never prints, the call is void.</div>
    <div class="k"><b>narratives</b>: published by the owner from a DJZS gate certificate; cited pages fetched and hashed at publish time; resolved the way the dated contract settled, misses first.</div>
    <div class="k"><b>disclosure</b>: not advice. Nobody here is paid by any asset, market or project mentioned. Scores describe the state of the evidence, not what you should do.</div>
    <p class="sig"><span class="p">END_TRANSMISSION.</span> // djzs.ai/scan · the verdict is on the narrative, never the contract</p>
  </footer>
</div>
</body>
</html>
`;
}
