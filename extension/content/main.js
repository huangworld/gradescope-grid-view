import { parseRoute, collectRows } from "./rows.js";
import { collectRegradeRows } from "./regrades.js";
import { createGrid } from "./grid.js";
import { createRubricPanel } from "./rubric.js";
import { clearComment, makeLimiter } from "./gradescope.js";

// Blank the comment on every selected GRADED submission. Ungraded ones are skipped on purpose:
// save_grade on them would mark them graded (full marks under negative scoring).
async function clearComments(grid, btn) {
  const sids = grid.getSelected();
  if (!sids.length) return grid.setStatus("Select at least one student first", true);
  if (!confirm(`Clear the comment on ${sids.length} selected submission${sids.length === 1 ? "" : "s"}?\nRubric items and point adjustments are kept. Ungraded ones are skipped.`)) return;
  btn.disabled = true;
  const limiter = makeLimiter(3);
  let done = 0, cleared = 0, skipped = 0;
  const fails = [];
  grid.setStatus(`Clearing comments 0/${sids.length}…`);
  await Promise.all(
    sids.map((sid) =>
      limiter(async () => {
        grid.setBusy(sid, true);
        try {
          const ctx = await grid.ensureCtx(sid, { force: true }); // fresh checked items / points / comment
          if (ctx.graded !== true || !(ctx.evaluation?.comments || "").trim()) return void skipped++;
          await clearComment(ctx);
          await grid.ensureCtx(sid, { force: true });
          cleared++;
        } catch (e) {
          fails.push(`${grid.nameOf(sid)}: ${e.message || e}`);
        } finally {
          grid.setBusy(sid, false);
          done++;
          grid.setStatus(`Clearing comments ${done}/${sids.length}…`);
        }
      })
    )
  );
  btn.disabled = false;
  const tail = fails.length ? ` · ${fails.length} failed: ${fails.join("; ")}` : "";
  grid.setStatus(`Comments cleared on ${cleared}, skipped ${skipped} (ungraded / already empty)${tail}`, fails.length > 0);
}

// question page → one row per submission; regrade page → one row per request
const collect = (route) => (route.kind === "regrade" ? collectRegradeRows(route) : collectRows(route));
const fabLabel = (rows) => {
  if (!rows.length) return "Grid view (0 rows found)";
  if (route.kind !== "regrade") return `Grid view (${rows.length})`;
  const open = rows.filter((r) => r.completed !== true).length;
  return `Grid view (${open} open / ${rows.length} requests)`;
};

const route = parseRoute();
if (route) init();

function waitForRows(timeoutMs = 6000) {
  return new Promise((resolve) => {
    const tryNow = () => {
      const r = collect(route);
      if (r.rows.length) return resolve(r), true;
      return false;
    };
    if (tryNow()) return;
    const mo = new MutationObserver(() => tryNow() && mo.disconnect());
    mo.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => (mo.disconnect(), resolve(collect(route))), timeoutMs);
  });
}

async function init() {
  const { rows } = await waitForRows();
  const toggle = document.createElement("button");
  toggle.className = "gsg-btn gsg-fab";
  toggle.textContent = fabLabel(rows);
  toggle.title = !rows.length
    ? "No submission rows found on this page; see README"
    : route.kind === "regrade"
      ? "Open grid view of the regrade requests on this page (one question at a time)"
      : "Open grid view of all submissions for this question";
  document.body.append(toggle);

  let grid = null;
  let panel = null;
  const close = () => {
    grid?.destroy();
    panel?.el.remove();
    grid = panel = null;
    document.documentElement.classList.remove("gsg-active");
    toggle.hidden = false;
  };
  toggle.addEventListener("click", () => {
    if (grid) return close();
    const fresh = collect(route).rows; // re-scrape: list may have re-rendered
    grid = createGrid({
      rows: fresh.length ? fresh : rows,
      onClose: close,
      mode: route.kind,
      storageKey: route.kind === "regrade" ? `regrade:${route.aid}` : route.qid,
    });
    panel = createRubricPanel({ grid });

    const openTabs = document.createElement("button");
    openTabs.className = "gsg-btn";
    openTabs.textContent = "Open in tabs";
    openTabs.addEventListener("click", async () => {
      const urls = grid.getSelected().map((sid) => grid.gradeUrlOf(sid));
      if (!urls.length) return grid.setStatus("Select at least one student first", true);
      if (urls.length > 15 && !confirm(`Open ${urls.length} tabs?`)) return;
      try {
        const res = await chrome.runtime.sendMessage({ type: "openTabs", urls });
        if (!res?.ok) throw new Error(res?.error || "no response from background worker");
        grid.setStatus(`Opened ${res.opened} tab${res.opened === 1 ? "" : "s"}`);
      } catch (e) {
        // Typical causes: extension reloaded but page not (context invalidated), worker not registered.
        console.warn("[gsg] background openTabs failed, falling back to window.open:", e);
        let n = 0;
        for (const u of urls) if (window.open(u, "_blank", "noopener")) n++;
        const hint = /invalidated/i.test(String(e?.message)) ? "extension was updated → reload this page" : `${e?.message || e}; allow popups for gradescope.com`;
        grid.setStatus(n === urls.length ? `Opened ${n} tabs (fallback)` : `Opened ${n}/${urls.length} — ${hint}`, n !== urls.length);
      }
    });
    const gradeSel = document.createElement("button");
    gradeSel.className = "gsg-btn gsg-primary";
    gradeSel.textContent = "Grade selected";
    gradeSel.addEventListener("click", () => panel.open());
    const clearCmt = document.createElement("button");
    clearCmt.className = "gsg-btn";
    clearCmt.textContent = "Clear comments";
    clearCmt.title = "Blank the comment on every selected graded submission; rubric items and points stay as they are";
    clearCmt.addEventListener("click", () => clearComments(grid, clearCmt));
    grid.actions.append(openTabs, clearCmt, gradeSel);
    grid.actions.addEventListener("gsg:selection", (e) => {
      const n = e.detail.count;
      openTabs.disabled = gradeSel.disabled = clearCmt.disabled = n === 0;
      gradeSel.textContent = n ? `Grade selected (${n})` : "Grade selected";
    });
    openTabs.disabled = gradeSel.disabled = clearCmt.disabled = true;

    document.documentElement.classList.add("gsg-active");
    document.body.append(grid.root, panel.el);
    toggle.hidden = true;
  });
}
