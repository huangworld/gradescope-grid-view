// E2E: fake grade-page server + real extension (grid.js, ocr.js, offscreen.js) in Chrome for Testing.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CHROME = process.env.CHROME_BIN;
const EXT = new URL("../../extension", import.meta.url).pathname;
const PORT = 9334, SRV = 8765;
const profile = mkdtempSync(join(tmpdir(), "gsg-e2e-"));

// ---- fake server ----
const students = {
  101: { name: "Ada", img: "apple pie recipe", typed: null },
  102: { name: "Bob", img: "banana split", typed: null },
  103: { name: "Cyd", img: "cherry tart", typed: "hidden typed answer zeta" },
  104: { name: "Dee", img: "dragon fruit", typed: null },
  105: { name: "Eli", img: "elder flower", typed: null },
  106: { name: "Fay", img: "fig jam", typed: null },
};
const ALL = '["101","102","103","104","105","106"]';
const images = new Map();
const srv = http.createServer((req, res) => {
  let body = [];
  req.on("data", (c) => body.push(c));
  req.on("end", () => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,PUT,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") return res.end();
    let m;
    if ((m = req.url.match(/^\/img\/(\d+)\.png/))) {
      if (req.method === "PUT") (images.set(m[1], Buffer.concat(body)), res.end("ok"));
      else (res.setHeader("Content-Type", "image/png"), res.end(images.get(m[1])));
    } else if ((m = req.url.match(/^\/courses\/1\/questions\/2\/submissions\/(\d+)\/grade$/))) {
      const s = students[m[1]];
      const props = {
        pages: [{ id: +m[1] * 10, number: 1, url: `http://127.0.0.1:${SRV}/img/${m[1]}.png` }],
        question: { weight: 10 },
        submission: { score: null },
        rubric_items: [],
        ...(s.typed ? { question_submission: { answers: { 0: s.typed } } } : {}),
      };
      res.setHeader("Content-Type", "text/html");
      res.end(`<html><head><meta name="csrf-token" content="x"></head><body><div data-react-class="SubmissionGrader" data-react-props='${JSON.stringify(props).replace(/'/g, "&#39;")}'></div></body></html>`);
    } else (res.statusCode = 404, res.end("nope"));
  });
});
await new Promise((r) => srv.listen(SRV, "127.0.0.1", r));

const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
chrome.stderr.on("data", (d) => (stderr += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } else this.events.push(m); }; }
  send(method, params = {}, sessionId) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params, sessionId })); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
  async eval(sessionId, expression) { const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; }
}

let fails = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? "  " + extra : ""}`); if (!cond) fails++; };

try {
  let v;
  for (let i = 0; i < 50 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(200); } }
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

  // an extension-origin tab to host the grid (offscreen.html is the only html we ship; its listener never
  // receives messages sent from this same tab, so it's inert here)
  const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/offscreen.html` });
  const pg = await attach({ targetId });
  await cdp.send("Runtime.enable", {}, pg);
  await cdp.send("Log.enable", {}, pg);
  await cdp.send("Page.enable", {}, pg);
  await sleep(500);
  // inject the extension's CSS so [hidden] rules apply like on the real page
  await cdp.eval(pg, `(async () => { const css = await (await fetch(chrome.runtime.getURL("content/ui.css"))).text(); const st = document.createElement("style"); st.textContent = css; document.head.append(st); })()`);

  // 1. upload page images rendered from text
  await cdp.eval(pg, `(async () => {
    const S = ${JSON.stringify(students)};
    for (const [sid, s] of Object.entries(S)) {
      const c = new OffscreenCanvas(1000, 300); const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, 1000, 300); g.fillStyle = "#000"; g.font = "52px Helvetica";
      g.fillText(s.img, 40, 160);
      const b = await c.convertToBlob({ type: "image/png" });
      await fetch("http://127.0.0.1:${SRV}/img/" + sid + ".png", { method: "PUT", body: b });
    }
  })()`);

  // 2. build the grid with fake rows
  const build = await cdp.eval(pg, `(async () => {
    const { createGrid } = await import(chrome.runtime.getURL("content/grid.js"));
    const S = ${JSON.stringify(students)};
    const rows = Object.entries(S).map(([sid, s]) => ({ sid, name: s.name, score: null, graded: false, gradeUrl: "http://127.0.0.1:${SRV}/courses/1/questions/2/submissions/" + sid + "/grade", tr: null }));
    const grid = createGrid({ rows, onClose: () => {} });
    document.body.append(grid.root);
    window.__grid = grid;
    window.__vis = () => [...document.querySelectorAll(".gsg-cell")].filter(c => !c.hidden).map(c => c.dataset.sid).sort();
    window.__pending = () => [...document.querderySelectorAll?.(".gsg-cell") ?? document.querySelectorAll(".gsg-cell")].filter(c => c.classList.contains("gsg-pending")).map(c => c.dataset.sid);
    window.__status = () => document.querySelector(".gsg-status").textContent;
    window.__find = document.querySelector(".gsg-find");
    window.__type = (q) => { __find.value = q; __find.dispatchEvent(new Event("input", { bubbles: true })); };
    window.__ocrBtn = [...document.querySelectorAll(".gsg-btn")].find(b => /OCR the pages/.test(b.title));
    const t0 = performance.now();
    let storageMs = null;
    try { await chrome.storage.sync.get(["ocrOn"]); storageMs = Math.round(performance.now() - t0); } catch (e) { storageMs = "ERR " + e.message; }
    await new Promise(r => setTimeout(r, 300));
    window.__indexBtn = [...document.querySelectorAll(".gsg-btn")].find(b => /index/i.test(b.title));
    window.__prog = () => { const p = document.querySelector(".gsg-progress"); return { hidden: p.hidden, label: p.querySelector(".gsg-progress-lbl").textContent, value: p.querySelector("progress").value, max: p.querySelector("progress").max }; };
    return { cells: document.querySelectorAll(".gsg-cell").length, ocrBtn: __ocrBtn?.textContent, indexBtn: __indexBtn?.textContent, find: !!__find, placeholder: __find?.placeholder, storageMs, btns: [...document.querySelectorAll(".gsg-toolbar .gsg-btn")].map(b => b.textContent) };
  })()`);
  console.log("built:", JSON.stringify(build));
  check("6 cells, find box, OCR off by default, Index button", build.cells === 6 && build.find && build.ocrBtn === "OCR: off" && build.indexBtn === "Index pages");

  const waitFor = async (expr, timeout = 30000) => {
    const t0 = Date.now();
    for (;;) {
      const r = await cdp.eval(pg, expr);
      if (r) return r;
      if (Date.now() - t0 > timeout) throw new Error("timeout waiting for " + expr + " status=" + (await cdp.eval(pg, "__status()")));
      await sleep(150);
    }
  };

  // wait for all ctx loaded (IO + loadAll)
  await cdp.eval(pg, `Promise.all(["101","102","103","104","105","106"].map(s => __grid.ensureCtx(s)))`);
  const ctx103 = await cdp.eval(pg, `JSON.stringify({answerText: __grid.state.ctx.get("103").answerText, pages: __grid.state.ctx.get("103").allPages.length, a101: __grid.state.ctx.get("101").answerText})`);
  console.log("ctx:", ctx103);
  check("answerText extracted from question_submission.answers", JSON.parse(ctx103).answerText === students[103].typed && JSON.parse(ctx103).a101 === "");

  // 3. typed-only query, OCR off → immediate
  await cdp.eval(pg, `__type("zeta")`);
  await sleep(400);
  let vis = await cdp.eval(pg, `JSON.stringify(__vis())`);
  check('"zeta" (OCR off) → only Cyd', vis === '["103"]', vis + " " + (await cdp.eval(pg, "__status()")));

  await cdp.eval(pg, `__type("apple")`);
  await sleep(400);
  vis = await cdp.eval(pg, `JSON.stringify(__vis())`);
  check('"apple" (OCR off) → nobody (no typed text has it)', vis === "[]", vis);

  // 4. syntax error keeps previous filter, marks box
  await cdp.eval(pg, `__type("(apple")`);
  await sleep(400);
  const bad = await cdp.eval(pg, `JSON.stringify({bad: __find.classList.contains("gsg-bad"), vis: __vis(), status: __status()})`);
  check("syntax error → red box, filter unchanged, status msg", (() => { const b = JSON.parse(bad); return b.bad && b.vis.length === 0 && /missing \)/.test(b.status); })(), bad);
  await cdp.eval(pg, `__type("apple")`);
  await sleep(400);
  check("fixed query clears red", (await cdp.eval(pg, `__find.classList.contains("gsg-bad")`)) === false);

  // 5. OCR on → pending then filtered
  await cdp.eval(pg, `__ocrBtn.click()`);
  await sleep(100);
  const pend = await cdp.eval(pg, `JSON.stringify({pending: __pending(), vis: __vis(), btn: __ocrBtn.textContent, status: __status()})`);
  console.log("right after OCR on:", pend);
  check("OCR on → cells pending+visible (dimmed)", (() => { const p = JSON.parse(pend); return p.btn === "OCR: on" && p.pending.length === 6 && p.vis.length === 6 && /pending/.test(p.status); })());
  await waitFor(`__pending().length === 0`);
  vis = await cdp.eval(pg, `JSON.stringify(__vis())`);
  const st = await cdp.eval(pg, "__status()");
  console.log("after OCR:", vis, st);
  check('"apple" (OCR on) → only Ada', vis === '["101"]');
  check("status shows find 1/6 · OCR 6/6", /find 1\/6 · OCR 6\/6/.test(st), st);
  const ocrTexts = await cdp.eval(pg, `JSON.stringify([...__grid.state.ocr.entries()].map(([k, v]) => [k, v.text, v.words?.length]))`);
  console.log("ocr cache:", ocrTexts);
  check("ocr entries carry word boxes", JSON.parse(ocrTexts).every(([, , n]) => n >= 2));
  const window_hits = `window.__hits = (sid) => document.querySelector('.gsg-cell[data-sid="' + sid + '"] .gsg-overlay').querySelectorAll(".gsg-hit").length`;
  await cdp.eval(pg, window_hits);
  const hitsNow = await cdp.eval(pg, `JSON.stringify({a: __hits("101"), hidden: document.querySelector('.gsg-cell[data-sid="101"] .gsg-overlay').hidden, box: document.querySelector('.gsg-cell[data-sid="101"] .gsg-hit')?.style.cssText})`);
  console.log("hits for apple:", hitsNow);
  check('"apple" → 1 highlight box on Ada, overlay shown', (() => { const h = JSON.parse(hitsNow); return h.a === 1 && h.hidden === false && /left:.*top:.*width:.*height:/.test(h.box); })());

  // 6. boolean combos over OCR+typed text (cached → instant)
  const q = async (query, expect) => { await cdp.eval(pg, `__type(${JSON.stringify(query)})`); await sleep(400); const v = await cdp.eval(pg, `JSON.stringify(__vis())`); check(`${query} → ${expect}`, v === expect, v); };
  await q("apple OR banana", '["101","102"]');
  await q("NOT banana", '["101","103","104","105","106"]');
  await q("/ch.rry/ AND zeta", '["103"]');
  await q('"split" -apple', '["102"]');
  await q("pie | tart", '["101","103"]');
  const hp = await cdp.eval(pg, `JSON.stringify([__hits("101"), __hits("103"), __hits("102")])`);
  check("pie | tart → one box each on Ada and Cyd, none on hidden Bob", hp === "[1,1,0]", hp);
  await q('"apple pie"', '["101"]');
  check('"apple pie" → 2 boxes (phrase)', (await cdp.eval(pg, `__hits("101")`)) === 2);
  await q("NOT banana", '["101","103","104","105","106"]');
  check("NOT banana → no boxes (negative term)", (await cdp.eval(pg, `[...document.querySelectorAll(".gsg-hit")].length`)) === 0);
  await q("/p\\w+/ AND recipe", '["101"]');
  check("regex + word → apple, pie, recipe boxes", (await cdp.eval(pg, `__hits("101")`)) === 3);
  await q("", ALL);
  check("empty query → no boxes", (await cdp.eval(pg, `[...document.querySelectorAll(".gsg-hit")].length`)) === 0);

  // 7. Esc behaviour + Ctrl/Cmd+F focus
  await cdp.eval(pg, `__type("apple")`); await sleep(400);
  await cdp.eval(pg, `__find.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true}))`); await sleep(100);
  check("Esc in box clears query → all visible", (await cdp.eval(pg, `JSON.stringify([__find.value, __vis().length])`)) === '["",6]');
  await cdp.eval(pg, `document.body.focus(); document.dispatchEvent(new KeyboardEvent("keydown", {key:"f", metaKey:true, bubbles:true}))`);
  check("Cmd+F focuses find box", (await cdp.eval(pg, `document.activeElement === __find`)) === true);

  // 8. crop toggle re-queues with new keys; destroy closes offscreen
  await cdp.eval(pg, `__type("apple")`); await sleep(400);
  const before = await cdp.eval(pg, `__grid.state.ocr.size`);
  await cdp.eval(pg, `__grid.state.ctx.get("101").cropRects = [{page_number:1, x1:0, y1:0, x2:50, y2:100}]; [...document.querySelectorAll(".gsg-btn")].find(b=>/^Crop:/.test(b.textContent)).click()`);
  await sleep(100);
  // crop was on by default → clicking turned it off; turn back on to get the cropped key
  await cdp.eval(pg, `[...document.querySelectorAll(".gsg-btn")].find(b=>/^Crop:/.test(b.textContent)).click()`);
  await waitFor(`__pending().length === 0`);
  const after = await cdp.eval(pg, `JSON.stringify({size: __grid.state.ocr.size, keys: [...__grid.state.ocr.keys()], vis: __vis()})`);
  console.log("after crop:", after);
  check("crop rect → one new OCR key (left half only: 'apple' still read)", JSON.parse(after).size === before + 1 && JSON.parse(after).keys.some(k => k.startsWith("101|1010|0,0,50,100")));

  // 9. Index pages: cancel path (6 pages, 4 in flight → 2 queued get cancelled)
  await cdp.eval(pg, `__type(""); __grid.state.ctx.get("101").cropRects = []; __grid.state.ocr.clear(); chrome.storage.local.clear()`);
  await sleep(300);
  check("after clearing cache button is 'Index pages'", (await cdp.eval(pg, `__indexBtn.textContent`)) === "Index pages");
  await cdp.eval(pg, `__indexBtn.click()`);
  await sleep(50);
  const mid = await cdp.eval(pg, `JSON.stringify({btn: __indexBtn.textContent, prog: __prog()})`);
  console.log("indexing:", mid);
  check("progress visible + cancel button while indexing", (() => { const m = JSON.parse(mid); return m.btn === "✕ Cancel index" && !m.prog.hidden && /indexing pages \d\/6/.test(m.prog.label) && m.prog.max === 6; })());
  await cdp.eval(pg, `__indexBtn.click()`); // cancel
  await waitFor(`__prog().hidden`);
  const canc = await cdp.eval(pg, `JSON.stringify({status: __status(), size: __grid.state.ocr.size, btn: __indexBtn.textContent})`);
  console.log("cancelled:", canc);
  check("cancel → status says cancelled, partial index kept, button offers resume", (() => { const c = JSON.parse(canc); return /Index cancelled: \d\/6/.test(c.status) && c.size >= 1 && c.size < 6 && /^Index pages \(\d\/6\)$/.test(c.btn); })());

  // 10. Index pages: full run, progress reaches 6/6, button shows Indexed ✓, storage persisted
  await cdp.eval(pg, `__indexBtn.click()`);
  await waitFor(`__prog().hidden`);
  const fin = await cdp.eval(pg, `JSON.stringify({status: __status(), size: __grid.state.ocr.size, btn: __indexBtn.textContent, on: __indexBtn.classList.contains("gsg-on")})`);
  console.log("indexed:", fin);
  check("full index → 6 pages, 'Indexed ✓ 6', status", (() => { const f = JSON.parse(fin); return f.size === 6 && f.btn === "Indexed ✓ 6" && f.on && /Indexed 6\/6 pages in \d+s/.test(f.status); })());
  await sleep(1800); // debounce save
  const stored = await cdp.eval(pg, `chrome.storage.local.get("ocrIndex:2").then(v => { const o = v["ocrIndex:2"] || {}; return [Object.keys(o).length, Object.values(o).every(e => typeof e.t === "string" && Array.isArray(e.w) && e.w.length >= 2)]; })`);
  check("index persisted to chrome.storage.local per question, with word boxes", stored[0] === 6 && stored[1] === true, JSON.stringify(stored));
  // instant find on indexed text
  await cdp.eval(pg, `__type("fig OR dragon")`); await sleep(400);
  check("find over index is instant", (await cdp.eval(pg, `JSON.stringify([__vis(), __pending().length])`)) === '[["104","106"],0]');

  // 11. reopen grid → index restored from storage, no OCR needed
  await cdp.eval(pg, `__grid.destroy()`);
  await sleep(500);
  const ctxs = await cdp.eval(pg, `chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"]}).then(c => c.length)`);
  check("destroy() closes offscreen document", ctxs === 0, String(ctxs));
  const reopened = await cdp.eval(pg, `(async () => {
    const { createGrid } = await import(chrome.runtime.getURL("content/grid.js"));
    const S = ${JSON.stringify(students)};
    const rows = Object.entries(S).map(([sid, s]) => ({ sid, name: s.name, score: null, graded: false, gradeUrl: "http://127.0.0.1:${SRV}/courses/1/questions/2/submissions/" + sid + "/grade", tr: null }));
    const grid = createGrid({ rows, onClose: () => {} });
    document.body.append(grid.root);
    window.__grid = grid;
    window.__find = document.querySelector(".gsg-find");
    window.__indexBtn = [...document.querySelectorAll(".gsg-btn")].find(b => /index/i.test(b.title));
    await new Promise(r => setTimeout(r, 400));
    await Promise.all(rows.map(r => grid.ensureCtx(r.sid)));
    await new Promise(r => setTimeout(r, 200));
    return { ocrSize: grid.state.ocr.size, ocrOn: grid.state.ocrOn, btn: __indexBtn.textContent };
  })()`);
  console.log("reopened:", JSON.stringify(reopened));
  check("reopened grid restores index + OCR on", reopened.ocrSize === 6 && reopened.ocrOn === true && reopened.btn === "Indexed ✓ 6");
  await cdp.eval(pg, `__type("banana")`); await sleep(400);
  const re2 = await cdp.eval(pg, `JSON.stringify([__vis(), __pending().length, __status()])`);
  check("find instant after reopen (no pending)", re2.startsWith('[["102"],0,'), re2);
  check("highlights restored from persisted index", (await cdp.eval(pg, `__hits("102")`)) === 1);
  await cdp.eval(pg, `__grid.destroy()`);

  const errs = cdp.events.filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Log.entryAdded" && e.params.entry.level === "error")).map((e) => JSON.stringify(e.params).slice(0, 250));
  if (errs.length) console.log("page errors:\n" + errs.join("\n"));
  console.log(fails ? `E2E FAIL (${fails})` : "E2E OK");
  process.exitCode = fails ? 1 : 0;
} catch (e) {
  console.error("E2E ERROR:", e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  srv.close();
}
