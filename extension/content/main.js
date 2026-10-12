import { parseRoute, collectRows } from "./rows.js";
import { createGrid } from "./grid.js";
import { createRubricPanel } from "./rubric.js";

const route = parseRoute();
if (route) init();

function waitForRows(timeoutMs = 6000) {
  return new Promise((resolve) => {
    const tryNow = () => {
      const r = collectRows(route);
      if (r.rows.length) return resolve(r), true;
      return false;
    };
    if (tryNow()) return;
    const mo = new MutationObserver(() => tryNow() && mo.disconnect());
    mo.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => (mo.disconnect(), resolve(collectRows(route))), timeoutMs);
  });
}

async function init() {
  const { rows } = await waitForRows();
  const toggle = document.createElement("button");
  toggle.className = "gsg-btn gsg-fab";
  toggle.textContent = rows.length ? `Grid view (${rows.length})` : "Grid view (0 rows found)";
  toggle.title = rows.length ? "Open grid view of all submissions for this question" : "No submission rows found on this page; see README";
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
    const fresh = collectRows(route).rows; // re-scrape: list may have re-rendered
    grid = createGrid({ rows: fresh.length ? fresh : rows, onClose: close });
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
    grid.actions.append(openTabs, gradeSel);
    grid.actions.addEventListener("gsg:selection", (e) => {
      const n = e.detail.count;
      openTabs.disabled = gradeSel.disabled = n === 0;
      gradeSel.textContent = n ? `Grade selected (${n})` : "Grade selected";
    });
    openTabs.disabled = gradeSel.disabled = true;

    document.documentElement.classList.add("gsg-active");
    document.body.append(grid.root, panel.el);
    toggle.hidden = true;
  });
}
