// Grid view: cells, paging, sizing, filtering, selection, graded markers.
import { fetchGradeCtx, makeLimiter } from "./gradescope.js";

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
  };
  const limiter = makeLimiter(5);
  const cells = new Map();

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
    h("option", { value: "score", text: "Sort: score" })
  );
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

  async function ensureCtx(sid, { force = false } = {}) {
    if (!force && state.ctx.has(sid)) return state.ctx.get(sid);
    if (state.loading.has(sid) && !force) return waitFor(sid);
    state.loading.add(sid);
    state.errors.delete(sid);
    renderCell(sid);
    try {
      const ctx = await limiter(() => fetchGradeCtx(state.byId.get(sid).gradeUrl));
      state.ctx.set(sid, ctx);
      if (!state.pageIdx.has(sid)) state.pageIdx.set(sid, 0);
      return ctx;
    } catch (e) {
      state.errors.set(sid, e.message || String(e));
      throw e;
    } finally {
      state.loading.delete(sid);
      renderCell(sid);
      renderStatus();
      applyFilter();
    }
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
    c.overlay.hidden = !rects.length;
    rects.forEach((r, i) => {
      const box = h("div", { class: rects.length === 1 ? "gsg-crop gsg-crop-dim" : "gsg-crop" });
      box.style.left = `${r.x1}%`;
      box.style.top = `${r.y1}%`;
      box.style.width = `${r.x2 - r.x1}%`;
      box.style.height = `${r.y2 - r.y1}%`;
      c.overlay.append(box);
    });
  }

  function visibleOrdered() {
    const list = state.rows.filter((r) => {
      const g = isGraded(r.sid);
      return state.filter === "all" || (state.filter === "graded" ? g === true : g !== true);
    });
    const num = (s) => (s == null || s === "" ? -Infinity : parseFloat(s));
    list.sort((a, b) =>
      state.sort === "score"
        ? num(scoreOf(a.sid)) - num(scoreOf(b.sid)) || a.name.localeCompare(b.name)
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
    status.textContent = `loaded ${loaded}/${n}${errs ? ` (${errs} failed)` : ""} · graded ${graded}/${n} · ${state.selected.size} selected`;
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
    filterSel.value = state.filter;
    sortSel.value = state.sort;
    slider.value = state.cellW;
  }

  // ---------- interactions ----------
  function shiftAll(delta) {
    for (const r of visibleOrdered()) {
      const n = pagesOf(r.sid).length;
      if (!n) continue;
      const cur = state.pageIdx.get(r.sid) ?? 0;
      const nxt = clamp(cur + delta, 0, n - 1);
      if (nxt !== cur) {
        state.pageIdx.set(r.sid, nxt);
        renderCell(r.sid);
      }
    }
  }
  function shiftOne(sid, delta) {
    const n = pagesOf(sid).length;
    if (!n) return;
    state.pageIdx.set(sid, clamp((state.pageIdx.get(sid) ?? 0) + delta, 0, n - 1));
    renderCell(sid);
  }
  function resetPages() {
    state.pageIdx.clear();
    for (const sid of cells.keys()) renderCell(sid);
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
  function setCellW(w) {
    state.cellW = clamp(w, 200, 900);
    root.style.setProperty("--cell-w", `${state.cellW}px`);
    slider.value = state.cellW;
    persist();
  }
  function setShowAll(v) {
    state.showAll = v;
    persist();
    renderAll();
  }
  function setCrop(v) {
    state.crop = v;
    persist();
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
      chrome.storage.sync.set({ cellW: state.cellW, showAll: state.showAll, crop: state.crop });
    } catch {}
  }
  async function restore() {
    try {
      const v = await chrome.storage.sync.get(["cellW", "showAll", "crop"]);
      if (v.cellW) state.cellW = v.cellW;
      if (typeof v.showAll === "boolean") state.showAll = v.showAll;
      if (typeof v.crop === "boolean") state.crop = v.crop;
    } catch {}
    root.style.setProperty("--cell-w", `${state.cellW}px`);
    renderAll();
  }

  function onKey(e) {
    if (!root.isConnected) return;
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
    nameOf: (sid) => state.byId.get(sid)?.name || `#${sid}`,
    gradeUrlOf: (sid) => state.byId.get(sid)?.gradeUrl,
    anyCtx: () => state.ctx.values().next().value || null,
    setBusy(sid, on) {
      cells.get(sid)?.el.classList.toggle("gsg-busy", on);
    },
    destroy() {
      document.removeEventListener("keydown", onKey);
      io.disconnect();
      root.remove();
    },
  };
}
