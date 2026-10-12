// Batch grading panel: pick rubric items, project the score, apply to all selected.
import { saveGrade, projectScore, scoringType, makeLimiter } from "./gradescope.js";

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
const fmt = (n) => (n == null ? "?" : Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ""));

export function createRubricPanel({ grid }) {
  const saveLimiter = makeLimiter(3);
  let refCtx = null;
  let chosen = new Set();

  const list = h("div", { class: "gsg-rubric-list" });
  const points = h("input", { type: "number", step: "0.5", class: "gsg-input", placeholder: "keep existing" });
  const comment = h("textarea", { class: "gsg-input gsg-textarea", rows: 2, placeholder: "keep existing" });
  const projected = h("div", { class: "gsg-projected" });
  const results = h("div", { class: "gsg-results" });
  const title = h("h3", { class: "gsg-panel-title" });
  const applyBtn = h("button", { class: "gsg-btn gsg-primary", text: "Apply to selected", onclick: () => apply() });
  const panel = h(
    "div",
    { class: "gsg-panel", hidden: "" },
    h("div", { class: "gsg-panel-head" }, title, h("button", { class: "gsg-btn gsg-mini", text: "✕", onclick: () => close() })),
    h("div", { class: "gsg-hint", text: "Replace mode: chosen items get checked, every other rubric item gets unchecked on each selected submission." }),
    list,
    h("label", { class: "gsg-field" }, h("span", { text: "Point adjustment" }), points),
    h("label", { class: "gsg-field" }, h("span", { text: "Comment" }), comment),
    projected,
    h("div", { class: "gsg-panel-actions" }, applyBtn),
    results
  );
  points.addEventListener("input", renderProjected);
  comment.addEventListener("input", renderProjected);

  async function open() {
    const sids = grid.getSelected();
    if (!sids.length) return grid.setStatus("Select at least one student first");
    panel.hidden = false;
    results.replaceChildren();
    title.textContent = `Grade ${sids.length} selected`;
    applyBtn.textContent = `Apply to ${sids.length} selected`;
    list.replaceChildren(h("div", { class: "gsg-hint", text: "loading rubric…" }));
    try {
      refCtx = grid.state.ctx.get(sids[0]) || (await grid.ensureCtx(sids[0]));
    } catch (e) {
      list.replaceChildren(h("div", { class: "gsg-err", text: `Could not load rubric: ${e.message}` }));
      return;
    }
    renderRubric();
  }
  function close() {
    panel.hidden = true;
  }

  function renderRubric() {
    list.replaceChildren();
    if (!refCtx.rubricItems.length) {
      list.append(h("div", { class: "gsg-err", text: "This question has no rubric items." }));
      return;
    }
    const st = scoringType(refCtx);
    list.append(
      h("div", {
        class: "gsg-hint",
        text: st === "positive" ? "Positive scoring: items add points." : `Negative scoring: starts at full marks, items deduct.${st ? "" : " (scoring type not reported; assuming negative)"}`,
      })
    );
    refCtx.rubricItems.forEach((ri, i) => {
      const id = String(ri.id);
      const item = h(
        "div",
        { class: "gsg-rubric-item", role: "checkbox", tabindex: "0", "aria-checked": String(chosen.has(id)), "data-id": id },
        h("span", { class: "gsg-tick" }),
        h("kbd", { class: "gsg-rubric-key", text: i < 9 ? String(i + 1) : "" }),
        h("span", { class: "gsg-rubric-desc", text: ri.description || "(no description)" }),
        h("span", { class: "gsg-rubric-w", text: `${st === "positive" ? "+" : "−"}${fmt(parseFloat(ri.weight) || 0)}` })
      );
      item.addEventListener("click", () => toggleItem(id));
      item.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") (e.preventDefault(), toggleItem(id));
      });
      list.append(item);
    });
    renderChosen();
  }
  function toggleItem(id) {
    chosen.has(id) ? chosen.delete(id) : chosen.add(id);
    renderChosen();
  }
  function renderChosen() {
    for (const el of list.querySelectorAll(".gsg-rubric-item")) {
      const on = chosen.has(el.dataset.id);
      el.classList.toggle("gsg-chosen", on);
      el.setAttribute("aria-checked", String(on));
    }
    renderProjected();
  }
  // number keys toggle rubric items while the panel is open
  document.addEventListener("keydown", (e) => {
    if (panel.hidden || !refCtx) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (/^[1-9]$/.test(e.key)) {
      const ri = refCtx.rubricItems[+e.key - 1];
      if (ri) (e.preventDefault(), toggleItem(String(ri.id)));
    }
  });
  function renderProjected() {
    if (!refCtx) return;
    const s = projectScore(refCtx, chosen, points.value === "" ? null : points.value);
    const total = refCtx.question?.weight;
    const n = chosen.size;
    const w = new Map(refCtx.rubricItems.map((ri) => [String(ri.id), parseFloat(ri.weight) || 0]));
    const sum = [...chosen].reduce((a, id) => a + (w.get(id) || 0), 0);
    const sign = scoringType(refCtx) === "positive" ? "+" : "−";
    projected.replaceChildren(
      h("div", { class: "gsg-projected-score" }, s == null ? "?" : fmt(s), total != null ? h("span", { class: "gsg-projected-total", text: ` / ${fmt(parseFloat(total))}` }) : null),
      h("div", { class: "gsg-projected-sub", text: n ? `${n} item${n === 1 ? "" : "s"} chosen · ${sign}${fmt(sum)}${points.value !== "" ? ` · adj ${points.value}` : ""}` : "no rubric item chosen yet" })
    );
    projected.classList.toggle("gsg-projected-empty", n === 0);
    applyBtn.disabled = n === 0 && points.value === "" && comment.value.trim() === "";
    applyBtn.textContent = `Apply to ${grid.getSelected().length} selected`;
  }

  async function apply() {
    const sids = grid.getSelected();
    if (!sids.length) return;
    if (!refCtx?.rubricItems.length) return;
    if (sids.length > 20 && !confirm(`Apply this grade to ${sids.length} submissions?`)) return;
    applyBtn.disabled = true;
    results.replaceChildren(h("div", { class: "gsg-hint", text: `Saving 0/${sids.length}…` }));
    const payload = {
      checkedIds: [...chosen],
      points: points.value === "" ? undefined : parseFloat(points.value),
      comments: comment.value.trim() === "" ? undefined : comment.value,
    };
    let done = 0;
    const fails = [];
    await Promise.all(
      sids.map((sid) =>
        saveLimiter(async () => {
          grid.setBusy(sid, true);
          try {
            const ctx = await grid.ensureCtx(sid);
            await saveGrade(ctx, payload);
            await grid.ensureCtx(sid, { force: true }); // refresh marker + score
          } catch (e) {
            fails.push({ sid, err: e.message || String(e) });
          } finally {
            grid.setBusy(sid, false);
            done++;
            results.firstChild.textContent = `Saving ${done}/${sids.length}…`;
          }
        })
      )
    );
    applyBtn.disabled = false;
    results.replaceChildren(
      h("div", { class: fails.length ? "gsg-err" : "gsg-ok", text: `${sids.length - fails.length}/${sids.length} saved${fails.length ? `, ${fails.length} failed:` : "."}` }),
      ...fails.map((f) =>
        h("div", { class: "gsg-err" }, h("a", { href: grid.gradeUrlOf(f.sid), target: "_blank", rel: "noopener", text: grid.nameOf(f.sid) }), ` — ${f.err}`)
      )
    );
    grid.renderStatus();
  }

  return { el: panel, open, close };
}
