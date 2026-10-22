// Searchable text per student: typed answers + OCR of the pages on display.
// Pure helpers; grid.js owns the state these read.

// Crop rects for one page → single {x,y,w,h} in % (bounding box if several), or null.
export function cropRectFor(cropRects, page, cropOn) {
  if (!cropOn) return null;
  const rs = (cropRects || []).filter((r) => String(r.page_number ?? r.page) === String(page.number));
  if (!rs.length) return null;
  const x1 = Math.min(...rs.map((r) => +r.x1)), y1 = Math.min(...rs.map((r) => +r.y1));
  const x2 = Math.max(...rs.map((r) => +r.x2)), y2 = Math.max(...rs.map((r) => +r.y2));
  if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export const rectKey = (rect) => (rect ? [rect.x, rect.y, rect.w, rect.h].map((n) => Math.round(n)).join(",") : "full");

// The OCR job for one page: {key, sid, url, rect}.
export function jobForPage(sid, page, cropRects, cropOn) {
  const rect = cropRectFor(cropRects, page, cropOn);
  return { key: `${sid}|${page.id ?? page.number}|${rectKey(rect)}`, sid, url: page.url, rect };
}

// One OCR job per page the cell can show.
export function ocrJobsFor(sid, pages, cropRects, cropOn) {
  return pages.map((p) => jobForPage(sid, p, cropRects, cropOn));
}

// Boxes (% of the image) of the OCR'd words that overlap any range matched by `matchers`
// in the page text. Word offsets replay offscreen.js's join rule: " " within a line, "\n"
// between lines. entry = {text, words: [[w, x0, y0, x1, y1, line], …]}.
export function pageHits(entry, matchers) {
  const words = entry?.words;
  if (!words?.length || !matchers?.length) return [];
  const ranges = matchers.flatMap((f) => f(entry.text || ""));
  if (!ranges.length) return [];
  const hits = [];
  let pos = 0, prevLine = null;
  for (const [w, x0, y0, x1, y1, line] of words) {
    if (prevLine !== null) pos += 1; // separator (" " or "\n")
    const start = pos, end = pos + w.length;
    if (ranges.some(([s, e]) => start < e && end > s)) hits.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    pos = end;
    prevLine = line;
  }
  return hits;
}

// → { text, status } with status ∈ "unloaded" | "pending" | "ready".
// ocr: Map<key, {text?: string, err?: string}>; failed jobs count as done (empty text).
// answer=false drops the typed answer (page-scoped find: typed answers belong to no page).
export function combineText({ ctx, jobs, ocrOn, ocr, answer = true }) {
  if (!ctx) return { text: "", status: "unloaded" };
  const parts = [];
  if (answer && ctx.answerText) parts.push(ctx.answerText);
  let status = "ready";
  if (ocrOn) {
    for (const j of jobs) {
      const r = ocr.get(j.key);
      if (!r) status = "pending";
      else if (r.text) parts.push(r.text);
    }
  }
  return { text: parts.join("\n"), status };
}
