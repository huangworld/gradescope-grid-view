// Service worker: opens grader tabs for the content script (window.open from
// a content script gets popup-blocked after the first tab).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
