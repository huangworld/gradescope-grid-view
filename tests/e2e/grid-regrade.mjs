// E2E: regrade-request mode. Fake grade-page server + real regrades.js / grid.js / rubric.js in Chrome for Testing.
// A regrade list table (live layout, plus a variant without Student/Sections) is injected into an
// extension page; the scraper + grid run on it exactly as they would on gradescope.com.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CHROME = process.env.CHROME_BIN;
const EXT = new URL("../../extension", import.meta.url).pathname;
const PORT = 9335, SRV = 8766;
const profile = mkdtempSync(join(tmpdir(), "gsg-e2e-rg-"));
const base = `http://127.0.0.1:${SRV}`;

// ---- fake grade pages, keyed "qid/sid" ----
const pages = {
  "2/101": { score: 7, open_request: { created_at: "2026-10-20T10:00:00Z", student_comment: "typo on part b please recheck" } },
  "2/102": { score: 5, closed_requests: [{ created_at: "2026-10-01T09:00:00Z", student_comment: "earlier ask", staff_comment: "declined" }] },
  "3/103": { score: null, open_request: { created_at: "2026-10-21T08:00:00Z", student_comment: "missing credit for plot" } },
  "3/101": { score: 8, open_request: { created_at: "2026-10-19T08:00:00Z", student_comment: "second question ask" } },
  "3/104": { score: 6, owners: [{ name: "Dee Owner" }] },
};
const srv = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // the grid page is extension-origin; no host permission for 127.0.0.1
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.end();
  const m = req.url.match(/^\/courses\/1\/questions\/(\d+)\/submissions\/(\d+)\/grade$/);
  const p = m && pages[`${m[1]}/${m[2]}`];
  if (!p) return (res.statusCode = 404), res.end("nope");
  const props = {
    pages: [],
    question: { id: +m[1], weight: 10 },
    submission: { score: p.score, ...(p.owners ? { owners: p.owners } : {}) },
    rubric_items: [{ id: 1, description: "all good", weight: "0" }],
    ...(p.open_request ? { open_request: p.open_request } : {}),
    ...(p.closed_requests ? { closed_requests: p.closed_requests } : {}),
  };
  res.setHeader("Content-Type", "text/html");
  res.end(`<html><head><meta name="csrf-token" content="x"></head><body><div data-react-class="SubmissionGrader" data-react-props='${JSON.stringify(props).replace(/'/g, "&#39;")}'></div></body></html>`);
});
await new Promise((r) => srv.listen(SRV, "127.0.0.1", r));
console.log("server up");

// ---- the regrade list page, as the live one is laid out ----
const link = (q, s) => `<a href="${base}/courses/1/questions/${q}/submissions/${s}/grade">Review</a>`;
const TABLE = `
<table id="t1"><thead><tr><th>Student</th><th>Sections</th><th>Question</th><th>Grader</th><th>Completed</th><th>Review</th></tr></thead><tbody>
<tr><td>Ada Lovelace ada@x.edu</td><td>A01</td><td>10: B2. Simple linear regression</td><td>Zhicheng Huang</td><td></td><td>${link(2, 101)}</td></tr>
<tr><td>Bob Ross (bob@x.edu)</td><td>A02</td><td>10: B2. Simple linear regression</td><td>Other TA</td><td>Oct 3, 2026</td><td>${link(2, 102)}</td></tr>
<tr><td>Cyd</td><td>A01</td><td>11: B3. Checking assumptions</td><td>Zhicheng Huang</td><td></td><td>${link(3, 103)}</td></tr>
<tr><td>Ada Lovelace ada@x.edu</td><td>A01</td><td>11: B3. Checking assumptions</td><td>Zhicheng Huang</td><td></td><td>${link(3, 101)}</td></tr>
<tr><td>Ada Lovelace ada@x.edu</td><td>A01</td><td>11: B3. Checking assumptions</td><td>—</td><td></td><td>${link(3, 101)}</td></tr>
</tbody></table>
<table id="t2"><thead><tr><th>Question</th><th>Grader</th><th>Completed</th><th></th></tr></thead><tbody>
<tr><td>11: B3. Checking assumptions</td><td>—</td><td><i class="fa fa-check"></i></td><td>${link(3, 104)}</td></tr>
</tbody></table>`;

const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
chrome.stderr.on("data", (d) => (stderr += d));
let chromeDead = false;
chrome.on("exit", (code, sig) => { chromeDead = true; console.log("chrome exited", code, sig, stderr.slice(-600)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } else this.events.push(m); }; }
  send(method, params = {}, sessionId) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params, sessionId })); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
  async eval(sessionId, expression) { const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; }
}

// WATCHDOG: a crashed Chrome leaves CDP promises pending forever
setTimeout(() => { console.log("E2E TIMEOUT (chrome stderr tail): " + stderr.slice(-800)); process.exit(2); }, 240000).unref();

let fails = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? "  " + extra : ""}`); if (!cond) fails++; };

try {
  let v;
  for (let i = 0; i < 50 && !v && !chromeDead; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(200); } }
  if (!v) throw new Error("DevTools endpoint never came up");
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const cdp = new CDP(ws);
  const attach = async (t) => (await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;

  let extId = null;
  for (let i = 0; i < 50 && !extId; i++) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    for (const t of targetInfos.filter((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"))) {
      const s = await attach(t);
      const name = await cdp.eval(s, `chrome.runtime.getManifest().name`).catch(() => null);
      await cdp.send("Target.detachFromTarget", { sessionId: s }).catch(() => {});
      if (name === "Gradescope Grid Grader") { extId = new URL(t.url).host; break; }
    }
    if (!extId) await sleep(200);
  }
  if (!extId) throw new Error("extension not found");
  console.log("extension", extId);

  const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/offscreen.html` });
  const pg = await attach({ targetId });
  await cdp.send("Runtime.enable", {}, pg);
  await cdp.send("Log.enable", {}, pg);
  await sleep(500);
  await cdp.eval(pg, `(async () => { const css = await (await fetch(chrome.runtime.getURL("content/ui.css"))).text(); const st = document.createElement("style"); st.textContent = css; document.head.append(st); })()`);

  console.log("page ready");
  // 1. scrape the injected table
  const scraped = await cdp.eval(pg, `(async () => {
    const wrap = document.createElement("div"); wrap.innerHTML = ${JSON.stringify(TABLE)}; document.body.append(wrap);
    const { collectRegradeRows } = await import(chrome.runtime.getURL("content/regrades.js"));
    const { rows, tables } = collectRegradeRows({ kind: "regrade", cid: "1", aid: "9" });
    window.__rows = rows;
    return JSON.stringify({ tables: tables.length, rows: rows.map(({ tr, ...r }) => r) });
  })()`);
  const sc = JSON.parse(scraped);
  console.log("scraped:", scraped);
  const by = Object.fromEntries(sc.rows.map((r) => [r.sid, r]));
  check("5 rows from 2 tables, duplicate link deduped, composite sids", sc.tables === 2 && sc.rows.map((r) => r.sid).join(",") === "2-101,2-102,3-103,3-101,3-104");
  check("names from Student column, emails stripped", by["2-101"].name === "Ada Lovelace" && by["2-102"].name === "Bob Ross" && by["3-103"].name === "Cyd");
  check("question / grader / section / completed read by header", by["2-101"].question.startsWith("10: B2") && by["2-101"].grader === "Zhicheng Huang" && by["2-101"].section === "A01" && by["2-101"].completed === false);
  check("completed: date → true; icon-only → true", by["2-102"].completed === true && by["3-104"].completed === true);
  check("no Student column → #sid fallback; '—' grader → unassigned", by["3-104"].name === "#104" && by["3-104"].nameSource === "fallback" && by["3-104"].grader === "" && by["3-104"].section === "");
  check("gradeUrl absolute, per row", by["3-101"].gradeUrl === `${base}/courses/1/questions/3/submissions/101/grade`);

  // 2. grid in regrade mode
  const built = await cdp.eval(pg, `(async () => {
    const { createGrid } = await import(chrome.runtime.getURL("content/grid.js"));
    const { createRubricPanel } = await import(chrome.runtime.getURL("content/rubric.js"));
    const grid = createGrid({ rows: __rows, onClose: () => {}, mode: "regrade", storageKey: "regrade:9" });
    const panel = createRubricPanel({ grid });
    document.body.append(grid.root, panel.el);
    window.__grid = grid; window.__panel = panel;
    window.__vis = () => [...document.querySelectorAll(".gsg-cell")].filter(c => !c.hidden).map(c => c.dataset.sid).sort();
    window.__sel = (re) => [...document.querySelectorAll("select.gsg-select")].find(s => [...s.options].some(o => re.test(o.textContent)));
    window.__set = (sel, v) => { sel.value = v; sel.dispatchEvent(new Event("change")); };
    window.__find = document.querySelector(".gsg-find");
    window.__type = (q) => { __find.value = q; __find.dispatchEvent(new Event("input", { bubbles: true })); };
    window.__rq = (sid) => document.querySelector('.gsg-cell[data-sid="' + sid + '"] .gsg-regrade').textContent;
    await new Promise(r => setTimeout(r, 300));
    const opts = (sel) => [...sel.options].map(o => o.value);
    return JSON.stringify({ cells: document.querySelectorAll(".gsg-cell").length, q: opts(__sel(/^Q: /)), g: opts(__sel(/^Grader: /)), s: opts(__sel(/requests$/)), sort: opts(__sel(/^Sort: /)), vis: __vis(), status: document.querySelector(".gsg-status").textContent, reply: !!document.querySelector(".gsg-reply"), hint: [...document.querySelectorAll(".gsg-panel .gsg-hint")].some(h => /not configured/.test(h.textContent)) });
  })()`);
  const b = JSON.parse(built);
  console.log("built:", built);
  check("selects: questions in table order, graders (all + distinct), status, request-date sort", b.q.join("|") === "10: B2. Simple linear regression|11: B3. Checking assumptions" && b.g.join("|") === "all|Zhicheng Huang|Other TA|" && b.s.join("|") === "open|all" && b.sort.includes("request"));
  check("default: first question, open only → just 2-101", b.vis.join(",") === "2-101" && /^1 request · /.test(b.status), b.status);
  check("reply fields hidden while endpoint unconfigured; hint shown", b.reply === false && b.hint === true);

  // 3. status + grader filters
  await cdp.eval(pg, `__set(__sel(/requests$/), "all")`);
  check("All requests → completed 2-102 appears", (await cdp.eval(pg, `JSON.stringify(__vis())`)) === '["2-101","2-102"]');
  await cdp.eval(pg, `__set(__sel(/^Grader: /), "Other TA")`);
  check("Grader filter → only 2-102", (await cdp.eval(pg, `JSON.stringify(__vis())`)) === '["2-102"]');
  await cdp.eval(pg, `__set(__sel(/^Grader: /), "all"); __set(__sel(/requests$/), "open")`);

  // 4. question switch clears selection
  const qsw = await cdp.eval(pg, `(() => {
    document.querySelector('.gsg-cell[data-sid="2-101"] .gsg-body').click();
    const before = __grid.getSelected().length;
    __set(__sel(/^Q: /), "11: B3. Checking assumptions");
    return JSON.stringify({ before, after: __grid.state.selected.size, vis: __vis() });
  })()`);
  check("switching question drops selection; Q11 open rows (3-104 completed → hidden)", qsw === '{"before":1,"after":0,"vis":["3-101","3-103"]}', qsw);
  await cdp.eval(pg, `__set(__sel(/requests$/), "all")`);
  check("Q11 all → 3-104 too", (await cdp.eval(pg, `JSON.stringify(__vis())`)) === '["3-101","3-103","3-104"]');

  // 5. load everything, check cell content
  const loads = await cdp.eval(pg, `Promise.allSettled(__rows.map(r => __grid.ensureCtx(r.sid))).then(rs => JSON.stringify(rs.map(r => r.status === "rejected" ? String(r.reason?.message || r.reason) : "ok")))`);
  check("every grade page loaded", !/rejected|Failed/.test(loads) && JSON.parse(loads).every((x) => x === "ok"), loads);
  await sleep(200);
  const cells = await cdp.eval(pg, `JSON.stringify({
    open: __rq("3-103"), closed: __rq("2-102"), none: __rq("3-104"),
    hasOpen: document.querySelector('.gsg-cell[data-sid="3-103"]').classList.contains("gsg-has-open"),
    name104: document.querySelector('.gsg-cell[data-sid="3-104"] .gsg-name').textContent,
    nameOf: __grid.nameOf("3-104"), url: __grid.gradeUrlOf("3-101"),
  })`);
  const c = JSON.parse(cells);
  console.log("cells:", cells);
  check("open request text + yellow class", /missing credit for plot/.test(c.open) && /open request/.test(c.open) && c.hasOpen);
  check("closed-only cell lists closed request (student + staff)", /1 closed request/.test(c.closed) && /earlier ask/.test(c.closed) && /declined/.test(c.closed));
  check("no request → 'no regrade request'", /no regrade request/.test(c.none));
  check("name fallback replaced from grade page (owners[0].name)", c.name104 === "Dee Owner" && c.nameOf === "Dee Owner");
  check("gradeUrlOf per row", c.url === `${base}/courses/1/questions/3/submissions/101/grade`);

  // 6. find over request text (OCR off), scoped to the shown question
  await cdp.eval(pg, `__type("plot")`); await sleep(400);
  check("find 'plot' → 3-103 only", (await cdp.eval(pg, `JSON.stringify(__vis())`)) === '["3-103"]');
  await cdp.eval(pg, `__type("second OR typo")`); await sleep(400);
  check("find scoped to Q11: 'second OR typo' → 3-101 (2-101 is Q10)", (await cdp.eval(pg, `JSON.stringify(__vis())`)) === '["3-101"]');
  await cdp.eval(pg, `__type("")`); await sleep(300);

  // 7. sort by request date, mark closed, storage key
  await cdp.eval(pg, `__set(__sel(/^Sort: /), "request")`);
  const order = await cdp.eval(pg, `JSON.stringify([...document.querySelectorAll(".gsg-cell")].filter(c => !c.hidden).map(c => c.dataset.sid))`);
  check("sort: request date newest first, no-request last", order === '["3-103","3-101","3-104"]', order);
  await cdp.eval(pg, `__set(__sel(/requests$/), "open"); __grid.markRequestClosed("3-103")`);
  const closed = await cdp.eval(pg, `JSON.stringify({ vis: __vis(), rq: __rq("3-103"), completed: __grid.state.byId.get("3-103").completed })`);
  check("markRequestClosed → leaves 'Open requests', shows as closed", /"vis":\["3-101"\].*1 closed request.*"completed":true/.test(closed), closed);
  const stored = await cdp.eval(pg, `(async () => { __grid.markGraded("3-101", { score: 9 }); await new Promise(r => setTimeout(r, 100)); const v = await chrome.storage.local.get("gradedAt:regrade:9"); return JSON.stringify(Object.keys(v["gradedAt:regrade:9"] || {})); })()`);
  check("gradedAt persisted under regrade:<aid>", stored === '["3-101"]', stored);
  await cdp.eval(pg, `__grid.destroy()`);

  const errs = cdp.events.filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Log.entryAdded" && e.params.entry.level === "error")).map((e) => JSON.stringify(e.params).slice(0, 250));
  if (errs.length) console.log("page errors:\n" + errs.join("\n"));
  console.log(fails ? `E2E FAIL (${fails})` : "E2E OK");
  process.exitCode = fails ? 1 : 0;
} catch (e) {
  console.error("E2E ERROR:", e.message);
  if (stderr) console.error(stderr.slice(-800));
  process.exitCode = 1;
} finally {
  chrome.kill();
  srv.close();
}
