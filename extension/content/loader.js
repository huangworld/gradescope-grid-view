// content_scripts can't be ES modules directly; bootstrap the module graph.
(async () => {
  try {
    await import(chrome.runtime.getURL("content/main.js"));
  } catch (e) {
    console.error("[gsg] failed to load extension modules", e);
  }
})();
