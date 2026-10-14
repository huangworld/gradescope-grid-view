// Offscreen document: hosts tesseract.js web workers and OCRs page images for
// the content script's find box. Everything (worker, wasm core, English model)
// is served from extension/vendor/ — nothing is fetched from a CDN.
import Tesseract from "./vendor/tesseract.esm.min.js";

const { createWorker, createScheduler } = Tesseract;
const N_WORKERS = 2;
const CREATE_TIMEOUT_MS = 30000;
let schedulerP = null;

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);

function getScheduler() {
  if (schedulerP) return schedulerP;
  schedulerP = (async () => {
    const s = createScheduler();
    const opts = {
      workerPath: chrome.runtime.getURL("vendor/worker.min.js"),
      corePath: chrome.runtime.getURL("vendor/tesseract-core"), // dir; worker appends <variant>.wasm.js
      langPath: chrome.runtime.getURL("vendor/lang"), // → vendor/lang/eng.traineddata.gz
      gzip: true,
      workerBlobURL: false, // MV3 CSP can't allow blob: workers; load worker.min.js by URL
      cacheMethod: "none", // model is local; skip the IndexedDB copy
      errorHandler: (e) => console.error("[gsg][ocr] worker error", e),
    };
    await Promise.all(
      Array.from({ length: N_WORKERS }, async () => {
        s.addWorker(await withTimeout(createWorker("eng", 1, opts), CREATE_TIMEOUT_MS, "createWorker"));
      })
    );
    console.debug("[gsg][ocr] scheduler ready,", N_WORKERS, "workers");
    return s;
  })().catch((e) => {
    schedulerP = null;
    throw e;
  });
  return schedulerP;
}

// rect: {x,y,w,h} in percent of the image, or null for the whole page.
async function ocr({ url, rect }) {
  const res = await fetch(url); // host_permissions make this a plain cross-origin fetch
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  try {
    const pct = (v, whole) => Math.round((v / 100) * whole);
    const sx = rect ? pct(rect.x, bmp.width) : 0;
    const sy = rect ? pct(rect.y, bmp.height) : 0;
    const sw = Math.max(1, rect ? pct(rect.w, bmp.width) : bmp.width);
    const sh = Math.max(1, rect ? pct(rect.h, bmp.height) : bmp.height);
    const scale = sw < 1200 ? 2 : 1; // small crops OCR better upscaled
    const canvas = new OffscreenCanvas(sw * scale, sh * scale);
    canvas.getContext("2d").drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const scheduler = await getScheduler();
    const { data } = await scheduler.addJob("recognize", blob, {}, { text: true, blocks: true });
    // Word boxes in percent of the FULL image (independent of crop/scale), and the text rebuilt
    // from those words (" " within a line, "\n" between lines) so text offsets map onto boxes.
    const X = (x) => +(((sx + x / scale) / bmp.width) * 100).toFixed(2);
    const Y = (y) => +(((sy + y / scale) / bmp.height) * 100).toFixed(2);
    const words = [];
    const lines = [];
    let li = 0;
    for (const b of data?.blocks || [])
      for (const p of b.paragraphs || [])
        for (const l of p.lines || []) {
          const lw = (l.words || []).filter((w) => w.text && w.text.trim());
          if (!lw.length) continue;
          for (const w of lw) words.push([w.text.trim(), X(w.bbox.x0), Y(w.bbox.y0), X(w.bbox.x1), Y(w.bbox.y1), li]);
          lines.push(lw.map((w) => w.text.trim()).join(" "));
          li++;
        }
    return { text: lines.join("\n"), words };
  } finally {
    bmp.close();
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;
  const reply = (p) => {
    p.then(
      (v) => sendResponse({ ok: true, ...v }),
      (e) => (console.warn("[gsg][ocr]", msg.type, e), sendResponse({ ok: false, error: e?.message || String(e) }))
    );
    return true; // async sendResponse
  };
  if (msg.type === "ocr") return reply(ocr(msg));
  if (msg.type === "ocrWarm") return reply(getScheduler().then(() => ({})));
  if (msg.type === "ocrPing") return (sendResponse({ ok: true }), false);
  return false;
});
