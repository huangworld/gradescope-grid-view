// Grid view: cells, paging, sizing, filtering, selection, graded markers, find.
import { fetchGradeCtx, makeLimiter } from "./gradescope.js";
import { parseQuery } from "./query.js";
import { ocrJobsFor, jobForPage, combineText, pageHits } from "./text.js";
import { ocrPage, ocrWarm, ocrShutdown, friendlyOcrError, loadIndex, saveIndex, loadGradedAt, saveGradedAt } from "./ocr.js";

const FIND_HELP = [
  "Find: filter cells whose text matches.",
  "  foo bar          both words (implicit AND)",
  "  foo OR bar       either          NOT foo / -foo   exclude",
  '  "a phrase"       exact phrase    /re+gex/i        regex',
  "  ( ... )          grouping;  NOT > AND > OR",
  "Text = typed answers (online assignments) + OCR of the pages shown (OCR: on).",
  "Find: all pages / this page = search every page of each student, or only the page each cell is on.",
  "OCR reads printed/typed text only; handwriting is mostly missed.",
].join("\n");

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v != null) el.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) el.append(kid);
  return el;
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const fmtScore = (s) => (s == null ? "" : Number.isInteger(+s) ? String(+s) : (+s).toFixed(2).replace(/\.?0+$/, ""));

export function createGrid({ rows, onClose }) {
  const state = {
    rows,
    byId: new Map(rows.map((r) => [r.sid, r])),
    ctx: new Map(),
    errors: new Map(),
    loading: new Set(),
    pageIdx: new Map(),
    selected: new Set(),
    anchor: null,
    filter: "all",
    sort: "name",
    cellW: 360,
    showAll: false,
    crop: true,
    retried: new Set(),
    query: "",
    pred: null, // compiled find predicate, or null = no find filter
    findScope: "all", // "all" pages of each student | "page" = only the page each cell currently shows
    matchers: null, // range matchers of the query's positive terms (for highlights)
    ocrOn: false,
    ocr: new Map(), // ocr job key → {text, words} | {err}
    saved: new Map(), // sid → score we saved from the grade panel; wins over a stale refetch
    gradedAt: new Map(), // sid → epoch ms we graded it from the panel (persisted per question)
  };
  const hitCache = new Map(); // ocr key → boxes for the current query
  const limiter = makeLimiter(5);
  const cells = new Map();
  let ocrErrShown = false;
  let findTimer = null;
  let indexing = null; // { cancelled: bool } while "Index pages" runs
  let saveTimer = null;
  const qid = rows[0]?.gradeUrl?.match(/\/questions\/(\d+)\//)?.[1] || null;

  // ---------- toolbar ----------
  const status = h("span", { class: "gsg-status" });
  const actions = h("div", { class: "gsg-actions" });
  const slider = h("input", {
    type: "range",
    min: 200,
    max: 900,
    step: 10,
    value: state.cellW,
    title: "Cell width",
    oninput: (e) => setCellW(+e.target.value),
  });
  const pagesSwitch = h("button", { class: "gsg-btn", title: "Show only the student's tagged pages, or every page of the submission", onclick: () => setShowAll(!state.showAll) });
  const cropBtn = h("button", { class: "gsg-btn", title: "Dim everything outside the question's crop region (fixed-template only)", onclick: () => setCrop(!state.crop) });
  const filterSel = h(
    "select",
    { class: "gsg-select", onchange: (e) => setFilter(e.target.value) },
    h("option", { value: "all", text: "All" }),
    h("option", { value: "ungraded", text: "Ungraded only" }),
    h("option", { value: "graded", text: "Graded only" })
  );
  const sortSel = h(
    "select",
    { class: "gsg-select", onchange: (e) => setSort(e.target.value) },
    h("option", { value: "name", text: "Sort: name" }),
    h("option", { value: "score", text: "Sort: score" }),
    h("option", { value: "recent", text: "Sort: recently graded" })
  );
  const findBox = h("input", {
    type: "search",
    class: "gsg-select gsg-find",
    placeholder: "find: foo AND (bar OR /re/i) NOT baz",
    title: FIND_HELP,
    spellcheck: "false",
    autocomplete: "off",
    oninput: (e) => {
      clearTimeout(findTimer);
      findTimer = setTimeout(() => setQuery(e.target.value), 250);
    },
    onkeydown: (e) => {
      if (e.key === "Enter") (clearTimeout(findTimer), setQuery(e.target.value));
      else if (e.key === "Escape") {
        e.stopPropagation();
        if (e.target.value) (e.target.value = "", setQuery(""));
        else e.target.blur();
      }
    },
  });
  const scopeBtn = h("button", {
    class: "gsg-btn",
    title: "Find: all pages = match anywhere in a student's pages (+ typed answer).\nFind: this page = match only the page each cell is currently showing (page with ◀ ▶ first, e.g. everyone on page 2).",
    onclick: () => setFindScope(state.findScope === "all" ? "page" : "all"),
  });
  const ocrBtn = h("button", { class: "gsg-btn", title: "OCR the pages shown so find can match their printed/typed text (runs locally; handwriting mostly missed)", onclick: () => setOcrOn(!state.ocrOn) });
  const indexBtn = h("button", {
    class: "gsg-btn",
    title: "Load every submission and OCR every page shown (current Pages/Crop setting) so find is instant afterwards. The index is kept per question in extension storage.",
    onclick: () => indexAll(),
  });
  const progBar = h("progress", { class: "gsg-progress-bar", max: 1, value: 0 });
  const progLbl = h("span", { class: "gsg-progress-lbl" });
  const progress = h("span", { class: "gsg-progress", hidden: "" }, progBar, progLbl);
  const menu = h(
    "details",
    { class: "gsg-menu" },
    h("summary", { class: "gsg-btn", text: "⋯" }),
    h(
      "div",
      { class: "gsg-menu-body" },
      h("button", { class: "gsg-btn", text: "Load all submissions", onclick: () => loadAll() }),
      h("button", { class: "gsg-btn", text: "Dump props (console + clipboard)", onclick: () => dumpProps() }),
      h("button", { class: "gsg-btn", text: "Reset all to page 1", onclick: () => resetPages() })
    )
  );

  const toolbar = h(
    "div",
    { class: "gsg-toolbar" },
    h("button", { class: "gsg-btn gsg-close", text: "✕ Close grid", onclick: () => onClose?.() }),
    h("span", { class: "gsg-sep" }),
    h("button", { class: "gsg-btn", text: "◀ page", title: "Previous page in every cell (←)", onclick: () => shiftAll(-1) }),
    h("button", { class: "gsg-btn", text: "page ▶", title: "Next page in every cell (→)", onclick: () => shiftAll(1) }),
    h("span", { class: "gsg-sep" }),
    h("label", { class: "gsg-lbl", text: "Size" }),
    slider,
    h("span", { class: "gsg-sep" }),
    pagesSwitch,
    cropBtn,
    filterSel,
    sortSel,
    h("span", { class: "gsg-sep" }),
    findBox,
    scopeBtn,
    ocrBtn,
    indexBtn,
    progress,
    h("span", { class: "gsg-sep" }),
    h("button", { class: "gsg-btn", text: "Select all", title: "Select every cell that passes the current filter + find", onclick: () => selectVisible() }),
    h("button", { class: "gsg-btn", text: "Clear selection", onclick: () => clearSelection() }),
    actions,
    menu,
    status
  );

  const gridEl = h("div", { class: "gsg-grid" });
  const root = h("div", { class: "gsg-root", id: "gsg-root" }, toolbar, gridEl);
  root.style.setProperty("--cell-w", `${state.cellW}px`);

  // ---------- cells ----------
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) if (en.isIntersecting) ensureCtx(en.target.dataset.sid).catch(() => {});
    },
    { root: root, rootMargin: "800px 0px" }
  );

  for (const row of rows) {
    const img = h("img", { class: "gsg-img", loading: "lazy", alt: "" });
    img.addEventListener("error", () => onImgError(row.sid));
    const overlay = h("div", { class: "gsg-overlay" });
    const check = h("span", { class: "gsg-tick gsg-check", role: "checkbox", "aria-checked": "false", title: "Select (shift-click for range)" });
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSelect(row.sid, e.shiftKey);
    });
    const badge = h("span", { class: "gsg-badge" });
    const name = h("a", { class: "gsg-name", href: row.gradeUrl, target: "_blank", rel: "noopener", text: row.name, title: `Open in grader (#${row.sid})` });
    name.addEventListener("click", (e) => e.stopPropagation());
    const pageLbl = h("span", { class: "gsg-pagelbl" });
    const prev = h("button", { class: "gsg-btn gsg-mini", text: "◀", onclick: (e) => (e.stopPropagation(), shiftOne(row.sid, -1)) });
    const next = h("button", { class: "gsg-btn gsg-mini", text: "▶", onclick: (e) => (e.stopPropagation(), shiftOne(row.sid, 1)) });
    const msg = h("div", { class: "gsg-msg" });
    const body = h("div", { class: "gsg-body" }, img, overlay, msg);
    body.addEventListener("click", (e) => toggleSelect(row.sid, e.shiftKey));
    const el = h(
      "div",
      { class: "gsg-cell gsg-unknown", "data-sid": row.sid },
      h("div", { class: "gsg-head" }, check, name, badge),
      body,
      h("div", { class: "gsg-foot" }, prev, pageLbl, next)
    );
    cells.set(row.sid, { el, img, overlay, check, badge, pageLbl, prev, next, msg, body });
    io.observe(el);
  }

  // ---------- data ----------
  function pagesOf(sid) {
    const ctx = state.ctx.get(sid);
    if (!ctx) return [];
    return state.showAll ? ctx.allPages : ctx.taggedPages;
  }
  function isGraded(sid) {
    const ctx = state.ctx.get(sid);
    if (ctx) return ctx.graded;
    return state.byId.get(sid).graded;
  }
  function scoreOf(sid) {
    const ctx = state.ctx.get(sid);
    if (ctx) return ctx.score;
    return state.byId.get(sid).score;
  }
  // Latest known grading time: our own panel save or the grade page's timestamp (if it has one).
  function gradedAtOf(sid) {
    const mine = state.gradedAt.get(sid) ?? -Infinity;
    const theirs = state.ctx.get(sid)?.gradedAt ?? -Infinity;
    const t = Math.max(mine, theirs);
    return t === -Infinity ? null : t;
  }

  async function ensureCtx(sid, { force = false } = {}) {
    if (!force && state.ctx.has(sid)) return state.ctx.get(sid);
    if (state.loading.has(sid) && !force) return waitFor(sid);
    state.loading.add(sid);
    state.errors.delete(sid);
    renderCell(sid);
    try {
      const ctx = await limiter(() => fetchGradeCtx(state.byId.get(sid).gradeUrl));
      if (state.saved.has(sid)) {
        // we graded this one ourselves; the grade page's graded flag / score may lag the save
        ctx.graded = true;
        if (ctx.score == null) ctx.score = state.saved.get(sid);
      }
      state.ctx.set(sid, ctx);
      if (!state.pageIdx.has(sid)) state.pageIdx.set(sid, 0);
      return ctx;
    } catch (e) {
      state.errors.set(sid, e.message || String(e));
      throw e;
    } finally {
      state.loading.delete(sid);
      queueOcr(sid);
      renderCell(sid);
      renderStatus();
      applyFilter();
    }
  }

  // ---------- find ----------
  function jobsFor(sid) {
    const ctx = state.ctx.get(sid);
    return ctx ? ocrJobsFor(sid, pagesOf(sid), ctx.cropRects, state.crop) : [];
  }
  // Jobs the find box reads: every page, or just the one the cell shows (findScope "page").
  function findJobsFor(sid) {
    if (state.findScope !== "page") return jobsFor(sid);
    const ctx = state.ctx.get(sid);
    const pages = pagesOf(sid);
    if (!ctx || !pages.length) return [];
    const idx = clamp(state.pageIdx.get(sid) ?? 0, 0, pages.length - 1);
    return [jobForPage(sid, pages[idx], ctx.cropRects, state.crop)];
  }
  function textOf(sid) {
    // page scope: typed answers belong to no page, so skip them when the student has pages
    const answer = state.findScope !== "page" || !pagesOf(sid).length;
    return combineText({ ctx: state.ctx.get(sid), jobs: findJobsFor(sid), ocrOn: state.ocrOn, ocr: state.ocr, answer });
  }
  function setFindScope(v) {
    state.findScope = v;
    renderScopeBtn();
    hitCache.clear();
    if (state.pred) queueOcr();
    renderAll();
  }
  function renderScopeBtn() {
    scopeBtn.textContent = state.findScope === "page" ? "Find: this page" : "Find: all pages";
    scopeBtn.classList.toggle("gsg-on", state.findScope === "page");
  }
  // Page-scoped find depends on which page each cell shows → re-evaluate after paging.
  function afterPageChange() {
    if (!state.pred || state.findScope !== "page") return;
    queueOcr();
    applyFilter();
    renderStatus();
  }
  // true = show. Cells whose text isn't known yet stay visible (dimmed) rather than flicker.
  function matchesFind(sid) {
    if (!state.pred) return true;
    const { text, status } = textOf(sid);
    return status !== "ready" || state.pred(text);
  }
  function setQuery(q) {
    state.query = q;
    let parsed;
    try {
      parsed = parseQuery(q);
    } catch (e) {
      findBox.classList.add("gsg-bad");
      findBox.title = `${e.message}${Number.isFinite(e.pos) ? ` (at ${e.pos + 1})` : ""}\n\n${FIND_HELP}`;
      setStatus(`find: ${e.message}`, true);
      return; // keep last good predicate
    }
    findBox.classList.remove("gsg-bad");
    findBox.title = FIND_HELP;
    state.pred = parsed?.pred || null;
    state.matchers = parsed?.highlight || null;
    hitCache.clear();
    if (state.pred) {
      if (state.ctx.size + state.errors.size < state.rows.length) loadAll().catch(() => {});
      if (state.ocrOn) queueOcr();
    }
    renderAll();
  }
  function setOcrOn(v) {
    state.ocrOn = v;
    persist();
    if (v) {
      ocrErrShown = false;
      ocrWarm().catch((e) => reportOcrError(e));
      if (state.pred) queueOcr();
    }
    renderAll();
  }
  function reportOcrError(e) {
    console.warn("[gsg] OCR", e);
    if (ocrErrShown) return;
    ocrErrShown = true;
    setStatus(`OCR: ${friendlyOcrError(e)}`, true);
  }
  // Run one OCR job and record the result. Resolves (never rejects) when done.
  function runOcrJob(job, opts) {
    return ocrPage(job, opts)
      .then(
        (res) => (state.ocr.set(job.key, res), hitCache.delete(job.key), scheduleSave()),
        (e) => {
          if (e?.cancelled) return;
          state.ocr.set(job.key, { err: e.message || String(e) });
          reportOcrError(e);
        }
      )
      .finally(() => {
        if (!root.isConnected) return;
        renderCell(job.sid);
        applyFilter();
        renderStatus();
      });
  }
  // Queue OCR for every page job not yet done (one sid, or all loaded cells).
  function queueOcr(onlySid) {
    if (!state.ocrOn || !state.pred) return;
    const sids = onlySid ? [onlySid] : [...state.ctx.keys()];
    for (const sid of sids) for (const job of findJobsFor(sid)) if (!state.ocr.has(job.key)) runOcrJob(job);
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveIndex(qid, state.ocr), 1500);
  }

  // ---------- index ----------
  function setProgress(done, total, what) {
    progress.hidden = false;
    progBar.max = Math.max(1, total);
    progBar.value = done;
    progLbl.textContent = `${what} ${done}/${total}`;
  }
  function indexedCount() {
    let done = 0, total = 0;
    for (const sid of state.ctx.keys()) for (const j of jobsFor(sid)) (total++, state.ocr.has(j.key) && done++);
    return { done, total, allLoaded: state.ctx.size + state.errors.size >= state.rows.length };
  }
  async function indexAll() {
    if (indexing) {
      indexing.cancelled = true;
      progLbl.textContent = "cancelling…";
      return;
    }
    const run = (indexing = { cancelled: false });
    const t0 = Date.now();
    if (!state.ocrOn) setOcrOn(true);
    else ocrWarm().catch((e) => reportOcrError(e));
    renderAll();
    try {
      // phase 1: every submission's grade page (gives pages + typed answers)
      const todo = state.rows.filter((r) => !state.ctx.has(r.sid));
      let loaded = state.rows.length - todo.length;
      setProgress(loaded, state.rows.length, "loading submissions");
      await Promise.allSettled(
        todo.map((r) =>
          ensureCtx(r.sid)
            .catch(() => {})
            .finally(() => setProgress(++loaded, state.rows.length, "loading submissions"))
        )
      );
      if (run.cancelled) return;
      // phase 2: OCR every page not yet indexed
      const jobs = [];
      for (const sid of state.ctx.keys()) for (const j of jobsFor(sid)) if (!state.ocr.has(j.key)) jobs.push(j);
      const total = indexedCount().total;
      let done = total - jobs.length;
      setProgress(done, total, "indexing pages");
      await Promise.all(jobs.map((j) => runOcrJob(j, { cancelled: () => run.cancelled }).then(() => !run.cancelled && setProgress(++done, total, "indexing pages"))));
    } finally {
      indexing = null;
      progress.hidden = true;
      const { done, total } = indexedCount();
      const secs = Math.round((Date.now() - t0) / 1000);
      saveIndex(qid, state.ocr);
      renderAll();
      setStatus(run.cancelled ? `Index cancelled: ${done}/${total} pages indexed` : `Indexed ${done}/${total} pages in ${secs}s`);
    }
  }
  function findStats() {
    let match = 0, evaluated = 0, pending = 0, ocrDone = 0, ocrTotal = 0;
    for (const r of state.rows) {
      const { text, status } = textOf(r.sid);
      if (status === "ready") (evaluated++, state.pred(text) && match++);
      else pending++;
      if (state.ocrOn) for (const j of findJobsFor(r.sid)) (ocrTotal++, state.ocr.has(j.key) && ocrDone++);
    }
    return { match, evaluated, pending, ocrDone, ocrTotal };
  }
  function waitFor(sid) {
    return new Promise((resolve, reject) => {
      const t = setInterval(() => {
        if (state.loading.has(sid)) return;
        clearInterval(t);
        state.ctx.has(sid) ? resolve(state.ctx.get(sid)) : reject(new Error(state.errors.get(sid) || "load failed"));
      }, 100);
    });
  }
  async function loadAll() {
    await Promise.allSettled(state.rows.map((r) => ensureCtx(r.sid)));
  }
  function onImgError(sid) {
    if (state.retried.has(sid)) return;
    state.retried.add(sid);
    ensureCtx(sid, { force: true }).catch(() => {});
  }
  function dumpProps() {
    const sid = [...state.selected][0] || [...state.ctx.keys()][0];
    const ctx = sid && state.ctx.get(sid);
    if (!ctx) return setStatus("No loaded submission to dump yet");
    console.log("[gsg] props for", sid, ctx.props, "tagged source:", ctx.taggedSource);
    navigator.clipboard?.writeText(JSON.stringify(ctx.props, null, 2)).catch(() => {});
    setStatus(`Dumped props of #${sid} (tagged source: ${ctx.taggedSource})`);
  }

  // ---------- rendering ----------
  function renderCell(sid) {
    const c = cells.get(sid);
    const row = state.byId.get(sid);
    const ctx = state.ctx.get(sid);
    const graded = isGraded(sid);
    c.el.classList.toggle("gsg-graded", graded === true);
    c.el.classList.toggle("gsg-ungraded", graded === false);
    c.el.classList.toggle("gsg-unknown", graded == null);
    c.el.classList.toggle("gsg-selected", state.selected.has(sid));
    c.el.classList.toggle("gsg-busy", state.loading.has(sid));
    c.el.classList.toggle("gsg-pending", !!state.pred && textOf(sid).status !== "ready");
    c.check.classList.toggle("gsg-on", state.selected.has(sid));
    c.check.setAttribute("aria-checked", String(state.selected.has(sid)));
    const score = scoreOf(sid);
    const total = ctx?.question?.weight;
    c.badge.textContent =
      graded === true ? `✓ ${fmtScore(score)}${total != null ? ` / ${fmtScore(total)}` : ""}` : graded === false ? "ungraded" : "…";

    const pages = pagesOf(sid);
    const err = state.errors.get(sid);
    if (!ctx) {
      c.img.removeAttribute("src");
      c.msg.textContent = err ? `⚠ ${err}` : state.loading.has(sid) ? "loading…" : "";
      c.msg.hidden = !c.msg.textContent;
      c.pageLbl.textContent = "";
      c.overlay.hidden = true;
      return;
    }
    if (!pages.length) {
      c.img.removeAttribute("src");
      c.msg.textContent = "no pages";
      c.msg.hidden = false;
      c.pageLbl.textContent = "0/0";
      c.overlay.hidden = true;
      return;
    }
    const idx = clamp(state.pageIdx.get(sid) ?? 0, 0, pages.length - 1);
    state.pageIdx.set(sid, idx);
    const page = pages[idx];
    if (c.img.getAttribute("src") !== page.url) c.img.src = page.url;
    c.msg.hidden = true;
    c.pageLbl.textContent = `p ${idx + 1}/${pages.length}`;
    c.prev.disabled = idx === 0;
    c.next.disabled = idx === pages.length - 1;
    renderOverlay(c, ctx, page);
  }

  function renderOverlay(c, ctx, page) {
    const rects = state.crop ? ctx.cropRects.filter((r) => String(r.page_number ?? r.page) === String(page.number)) : [];
    c.overlay.replaceChildren();
    rects.forEach((r, i) => {
      const box = h("div", { class: rects.length === 1 ? "gsg-crop gsg-crop-dim" : "gsg-crop" });
      box.style.left = `${r.x1}%`;
      box.style.top = `${r.y1}%`;
      box.style.width = `${r.x2 - r.x1}%`;
      box.style.height = `${r.y2 - r.y1}%`;
      c.overlay.append(box);
    });
    const hits = hitsFor(c.el.dataset.sid, ctx, page);
    const PAD = 0.3; // % — a little air around the word
    for (const b of hits) {
      const box = h("div", { class: "gsg-hit" });
      box.style.left = `${b.x - PAD}%`;
      box.style.top = `${b.y - PAD}%`;
      box.style.width = `${b.w + 2 * PAD}%`;
      box.style.height = `${b.h + 2 * PAD}%`;
      c.overlay.append(box);
    }
    c.overlay.hidden = !rects.length && !hits.length;
  }
  // Word boxes on this page matching the query's positive terms (cached per OCR key + query).
  function hitsFor(sid, ctx, page) {
    if (!state.matchers || !state.ocrOn) return [];
    const { key } = jobForPage(sid, page, ctx.cropRects, state.crop);
    if (hitCache.has(key)) return hitCache.get(key);
    const hits = pageHits(state.ocr.get(key), state.matchers);
    hitCache.set(key, hits);
    return hits;
  }

  // ignoreFind: rows passing the graded filter only (paging must also move cells find has hidden,
  // else in page scope they never reach the page being searched)
  function visibleOrdered({ ignoreFind = false } = {}) {
    const list = state.rows.filter((r) => {
      const g = isGraded(r.sid);
      const byGrade = state.filter === "all" || (state.filter === "graded" ? g === true : g !== true);
      return byGrade && (ignoreFind || matchesFind(r.sid));
    });
    const num = (s) => (s == null || s === "" ? -Infinity : parseFloat(s));
    // recently graded: newest first → graded w/o known time → ungraded; ties by name
    const recent = (sid) => gradedAtOf(sid) ?? (isGraded(sid) === true ? 0 : -1);
    list.sort((a, b) =>
      state.sort === "score"
        ? num(scoreOf(a.sid)) - num(scoreOf(b.sid)) || a.name.localeCompare(b.name)
        : state.sort === "recent"
          ? recent(b.sid) - recent(a.sid) || a.name.localeCompare(b.name)
          : a.name.localeCompare(b.name)
    );
    return list;
  }
  function applyFilter() {
    const vis = visibleOrdered();
    const visSet = new Set(vis.map((r) => r.sid));
    for (const [sid, c] of cells) c.el.hidden = !visSet.has(sid);
    // keep DOM order = sort order
    for (const r of vis) gridEl.append(cells.get(r.sid).el);
  }
  function renderStatus() {
    const n = state.rows.length;
    const loaded = state.ctx.size;
    const graded = state.rows.filter((r) => isGraded(r.sid) === true).length;
    const errs = state.errors.size;
    let s = `loaded ${loaded}/${n}${errs ? ` (${errs} failed)` : ""} · graded ${graded}/${n} · ${state.selected.size} selected`;
    if (state.pred) {
      const f = findStats();
      s += ` · find ${f.match}/${f.evaluated}${f.pending ? ` (${f.pending} pending)` : ""}`;
      if (state.ocrOn) s += ` · OCR ${f.ocrDone}/${f.ocrTotal}`;
    }
    status.textContent = s;
    renderIndexBtn();
    console.debug("[gsg] selected:", [...state.selected]);
    actions.dispatchEvent(new CustomEvent("gsg:selection", { detail: { count: state.selected.size } }));
  }
  function setStatus(msg, isError = false) {
    status.textContent = msg;
    status.classList.toggle("gsg-status-err", isError);
    setTimeout(() => {
      status.classList.remove("gsg-status-err");
      renderStatus();
    }, isError ? 8000 : 4000);
  }
  function renderAll() {
    for (const sid of cells.keys()) renderCell(sid);
    applyFilter();
    renderStatus();
    pagesSwitch.textContent = state.showAll ? "Pages: all" : "Pages: tagged";
    cropBtn.textContent = state.crop ? "Crop: on" : "Crop: off";
    cropBtn.classList.toggle("gsg-on", state.crop);
    ocrBtn.textContent = state.ocrOn ? "OCR: on" : "OCR: off";
    renderScopeBtn();
    ocrBtn.classList.toggle("gsg-on", state.ocrOn);
    if (findBox.value !== state.query) findBox.value = state.query;
    filterSel.value = state.filter;
    sortSel.value = state.sort;
    slider.value = state.cellW;
  }
  // Index button reflects loaded ctx + OCR cache, both of which change outside renderAll.
  function renderIndexBtn() {
    const ix = indexedCount();
    const complete = ix.allLoaded && ix.total > 0 && ix.done === ix.total;
    indexBtn.textContent = indexing ? "✕ Cancel index" : complete ? `Indexed ✓ ${ix.total}` : ix.done ? `Index pages (${ix.done}/${ix.total})` : "Index pages";
    indexBtn.classList.toggle("gsg-on", complete && !indexing);
    indexBtn.title = indexing
      ? "Stop indexing (pages already done are kept)"
      : complete
        ? "Every page shown is OCR'd; find is instant. Changing Pages/Crop needs a re-index."
        : "Load every submission and OCR every page shown (current Pages/Crop setting) so find is instant afterwards. The index is kept per question in extension storage.";
  }

  // ---------- interactions ----------
  function shiftAll(delta) {
    for (const r of visibleOrdered({ ignoreFind: true })) {
      const n = pagesOf(r.sid).length;
      if (!n) continue;
      const cur = state.pageIdx.get(r.sid) ?? 0;
      const nxt = clamp(cur + delta, 0, n - 1);
      if (nxt !== cur) {
        state.pageIdx.set(r.sid, nxt);
        renderCell(r.sid);
      }
    }
    afterPageChange();
  }
  function shiftOne(sid, delta) {
    const n = pagesOf(sid).length;
    if (!n) return;
    state.pageIdx.set(sid, clamp((state.pageIdx.get(sid) ?? 0) + delta, 0, n - 1));
    renderCell(sid);
    afterPageChange();
  }
  function resetPages() {
    state.pageIdx.clear();
    for (const sid of cells.keys()) renderCell(sid);
    afterPageChange();
  }
  function toggleSelect(sid, shift, forceVal) {
    if (shift && state.anchor && state.anchor !== sid) {
      const order = visibleOrdered().map((r) => r.sid);
      const a = order.indexOf(state.anchor);
      const b = order.indexOf(sid);
      if (a !== -1 && b !== -1) {
        const on = forceVal ?? !state.selected.has(sid);
        for (const s of order.slice(Math.min(a, b), Math.max(a, b) + 1)) on ? state.selected.add(s) : state.selected.delete(s);
      }
    } else {
      const on = forceVal ?? !state.selected.has(sid);
      on ? state.selected.add(sid) : state.selected.delete(sid);
      state.anchor = sid;
    }
    for (const s of cells.keys()) renderCell(s);
    renderStatus();
  }
  function clearSelection() {
    state.selected.clear();
    for (const s of cells.keys()) renderCell(s);
    renderStatus();
  }
  // Select exactly what is visible now (filter + find), i.e. what getSelected() would act on.
  function selectVisible() {
    const vis = visibleOrdered();
    if (!vis.length) return setStatus("Nothing visible to select", true);
    for (const r of vis) state.selected.add(r.sid);
    state.anchor = vis[vis.length - 1].sid;
    for (const s of cells.keys()) renderCell(s);
    renderStatus();
    setStatus(`Selected ${vis.length} visible`);
  }
  function setCellW(w) {
    state.cellW = clamp(w, 200, 900);
    root.style.setProperty("--cell-w", `${state.cellW}px`);
    slider.value = state.cellW;
    persist();
  }
  function setShowAll(v) {
    state.showAll = v;
    persist();
    queueOcr(); // page set changed → new OCR keys
    renderAll();
  }
  function setCrop(v) {
    state.crop = v;
    persist();
    queueOcr(); // crop region is part of the OCR key
    renderAll();
  }
  function setFilter(v) {
    state.filter = v;
    applyFilter();
  }
  function setSort(v) {
    state.sort = v;
    applyFilter();
  }
  function persist() {
    try {
      chrome.storage.sync.set({ cellW: state.cellW, showAll: state.showAll, crop: state.crop, ocrOn: state.ocrOn });
    } catch {}
  }
  async function restore() {
    try {
      const v = await chrome.storage.sync.get(["cellW", "showAll", "crop", "ocrOn"]);
      if (v.cellW) state.cellW = v.cellW;
      if (typeof v.showAll === "boolean") state.showAll = v.showAll;
      if (typeof v.crop === "boolean") state.crop = v.crop;
      if (typeof v.ocrOn === "boolean") state.ocrOn = v.ocrOn;
    } catch {}
    for (const [k, v] of await loadIndex(qid)) if (!state.ocr.has(k)) state.ocr.set(k, v);
    for (const [sid, t] of await loadGradedAt(qid)) if (!state.gradedAt.has(sid)) state.gradedAt.set(sid, t);
    root.style.setProperty("--cell-w", `${state.cellW}px`);
    renderAll();
  }

  function onKey(e) {
    if (!root.isConnected) return;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      findBox.focus();
      findBox.select();
      return;
    }
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (e.key === "ArrowLeft") (e.preventDefault(), shiftAll(-1));
    else if (e.key === "ArrowRight") (e.preventDefault(), shiftAll(1));
    else if (e.key === "Escape") onClose?.();
  }
  document.addEventListener("keydown", onKey);

  restore();

  return {
    root,
    actions,
    state,
    limiter,
    ensureCtx,
    renderCell,
    renderStatus,
    setStatus,
    getSelected: () => visibleOrdered().map((r) => r.sid).filter((s) => state.selected.has(s)),
    getSelectedAny: () => [...state.selected],
    clearSelection,
    selectVisible,
    nameOf: (sid) => state.byId.get(sid)?.name || `#${sid}`,
    gradeUrlOf: (sid) => state.byId.get(sid)?.gradeUrl,
    anyCtx: () => state.ctx.values().next().value || null,
    setBusy(sid, on) {
      cells.get(sid)?.el.classList.toggle("gsg-busy", on);
    },
    // Optimistic update right after save_grade: ungraded → graded + score chip now, refetch later confirms.
    markGraded(sid, { score, checked }) {
      state.saved.set(sid, score ?? null);
      state.gradedAt.set(sid, Date.now());
      saveGradedAt(qid, state.gradedAt);
      const row = state.byId.get(sid);
      if (row) (row.graded = true), (row.score = score ?? row.score);
      const ctx = state.ctx.get(sid);
      if (ctx) {
        ctx.graded = true;
        if (score != null) ctx.score = score;
        if (checked) ctx.checked = new Set([...checked].map(String));
      }
      renderCell(sid);
      renderStatus();
      applyFilter();
    },
    destroy() {
      document.removeEventListener("keydown", onKey);
      clearTimeout(findTimer);
      clearTimeout(saveTimer);
      if (indexing) indexing.cancelled = true;
      saveIndex(qid, state.ocr);
      io.disconnect();
      root.remove();
      ocrShutdown(); // frees the OCR workers' memory
    },
  };
}
