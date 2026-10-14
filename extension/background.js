// Service worker: opens grader tabs for the content script (window.open from
// a content script gets popup-blocked after the first tab) and creates/closes
// the offscreen document that runs OCR (offscreen.js).

const OFFSCREEN_URL = "offscreen.html";
let creating = null;

async function ensureOffscreen() {
  const ctxs = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (ctxs.length) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS"],
      justification: "Run local Tesseract OCR web workers so the grid's find box can filter page images by text",
    })
    .catch((e) => {
      if (!/single offscreen document/i.test(String(e?.message))) throw e; // lost a race; doc exists
    })
    .finally(() => (creating = null));
  await creating;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === "offscreen") return false; // handled by offscreen.js

  if (msg?.type === "ocrEnsure") {
    ensureOffscreen().then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: e?.message || String(e) })
    );
    return true;
  }
  if (msg?.type === "ocrShutdown") {
    chrome.offscreen
      .closeDocument()
      .catch(() => {})
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg?.type !== "openTabs" || !Array.isArray(msg.urls)) return false;
  (async () => {
    let index = sender.tab ? sender.tab.index + 1 : undefined;
    let opened = 0;
    let error = null;
    for (const url of msg.urls) {
      try {
        await chrome.tabs.create({ url, active: false, index, openerTabId: sender.tab?.id });
        opened++;
        if (index !== undefined) index++;
      } catch (e) {
        console.error("[gsg] tabs.create failed", url, e);
        error = e?.message || String(e);
      }
    }
    sendResponse({ ok: opened > 0, opened, error });
  })();
  return true; // async sendResponse
});
