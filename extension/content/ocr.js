// Content-side OCR client. Talks to the offscreen document (offscreen.js),
// which hosts the tesseract.js workers; background.js only creates/closes it.
import { makeLimiter } from "./gradescope.js";

let ensured = false;
const limiter = makeLimiter(4); // offscreen scheduler has 2 workers; keep a little queued
const inflight = new Map(); // key → Promise<string>

async function ensure() {
  const r = await chrome.runtime.sendMessage({ type: "ocrEnsure" });
  if (!r?.ok) throw new Error(r?.error || "could not start OCR document");
  ensured = true;
}

async function send(msg) {
  if (!ensured) await ensure();
  let r = await chrome.runtime.sendMessage({ target: "offscreen", ...msg });
  if (r === undefined) {
    // nobody answered: offscreen document was reaped → recreate once
    ensured = false;
    await ensure();
    r = await chrome.runtime.sendMessage({ target: "offscreen", ...msg });
  }
  if (r === undefined) throw new Error("OCR document did not answer — vendor files missing? run scripts/fetch-vendor.sh and reload the extension");
  if (!r?.ok) throw new Error(r?.error || "OCR failed");
  return r;
}

export function friendlyOcrError(e) {
  const m = String(e?.message || e);
  if (/invalidated|Receiving end does not exist|message port closed/i.test(m)) return "extension was updated → reload this page";
  return m;
}

// Load workers + model ahead of the first query. Errors surface via the returned promise.
export const ocrWarm = () => send({ type: "ocrWarm" }).then(() => true);

export const ocrShutdown = () => chrome.runtime.sendMessage({ type: "ocrShutdown" }).catch(() => {});

// rect: {x,y,w,h} in percent of the image, or null for the whole page.
// Resolves {text, words}; words = [[text, x0%, y0%, x1%, y1%, lineIdx], …] over the full image.
// cancelled(): checked when the job reaches the front of the queue; a cancelled
// job rejects with err.cancelled = true and never contacts the offscreen doc.
export function ocrPage({ key, url, rect }, { cancelled } = {}) {
  if (inflight.has(key)) return inflight.get(key);
  const p = limiter(async () => {
    if (cancelled?.()) throw Object.assign(new Error("cancelled"), { cancelled: true });
    const r = await send({ type: "ocr", url, rect });
    return { text: r.text || "", words: Array.isArray(r.words) ? r.words : [] };
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export const ocrInflight = () => inflight.size;

// ---- persisted index (chrome.storage.local, one entry per question) ----
// Only successful results are stored, compactly as {t: text, w: words}; keys are the
// ocr job keys (sid|page|crop). Older entries may be plain strings (text only).
const indexKey = (qid) => `ocrIndex:${qid}`;

// Times (epoch ms) we graded submissions from the panel, per question, so "Sort: recently graded"
// survives reload. Grade pages may not carry a timestamp; this is the source we control.
const gradedKey = (qid) => `gradedAt:${qid}`;
export async function loadGradedAt(qid) {
  if (!qid) return new Map();
  try {
    const v = await chrome.storage.local.get(gradedKey(qid));
    return new Map(Object.entries(v[gradedKey(qid)] || {}).filter(([, t]) => Number.isFinite(t)));
  } catch {
    return new Map();
  }
}
export async function saveGradedAt(qid, map) {
  if (!qid) return;
  try {
    await chrome.storage.local.set({ [gradedKey(qid)]: Object.fromEntries(map) });
  } catch {}
}

export async function loadIndex(qid) {
  if (!qid) return new Map();
  try {
    const v = await chrome.storage.local.get(indexKey(qid));
    return new Map(
      Object.entries(v[indexKey(qid)] || {}).map(([k, e]) => [
        k,
        typeof e === "string" ? { text: e, words: [] } : { text: e?.t || "", words: Array.isArray(e?.w) ? e.w : [] },
      ])
    );
  } catch {
    return new Map();
  }
}

export async function saveIndex(qid, ocr) {
  if (!qid) return;
  const obj = {};
  for (const [k, v] of ocr) if (typeof v.text === "string") obj[k] = { t: v.text, w: v.words || [] };
  try {
    await chrome.storage.local.set({ [indexKey(qid)]: obj });
  } catch (e) {
    console.warn("[gsg] could not persist OCR index", e);
  }
}
