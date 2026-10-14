// Smoke test: load the unpacked extension in Chrome, create the offscreen doc via the
// service worker, and OCR a synthetic image through the real message path.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EXT = new URL("../../extension", import.meta.url).pathname;
const PORT = 9333;
const headless = process.argv.includes("--headful") ? [] : ["--headless=new"];
const profile = mkdtempSync(join(tmpdir(), "gsg-profile-"));

const chrome = spawn(CHROME, [
  ...headless,
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--load-extension=${EXT}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions-except=" + EXT,
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
chrome.stderr.on("data", (d) => (stderr += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function version() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return await r.json();
    } catch {
      await sleep(200);
    }
  }
  throw new Error("chrome did not start\n" + stderr);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else this.events.push(m);
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(sessionId, expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
}

try {
  const { webSocketDebuggerUrl } = await version();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const cdp = new CDP(ws);

  const findTarget = async (pred, tries = 50) => {
    for (let i = 0; i < tries; i++) {
      const { targetInfos } = await cdp.send("Target.getTargets");
      const t = targetInfos.find(pred);
      if (t) return t;
      await sleep(200);
    }
    const { targetInfos } = await cdp.send("Target.getTargets");
    throw new Error("target not found; have: " + JSON.stringify(targetInfos.map((t) => [t.type, t.url])));
  };
  const attach = async (t) => (await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;

  // several built-in component extensions also have a background.js SW: pick ours by manifest name
  let swS = null, sw = null;
  for (let i = 0; i < 50 && !swS; i++) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    for (const t of targetInfos.filter((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"))) {
      const s = await attach(t);
      const name = await cdp.eval(s, `chrome.runtime.getManifest().name`).catch(() => null);
      if (name === "Gradescope Grid Grader") { swS = s; sw = t; break; }
      await cdp.send("Target.detachFromTarget", { sessionId: s }).catch(() => {});
    }
    if (!swS) await sleep(200);
  }
  if (!swS) throw new Error("extension service worker not found");
  console.log("service worker:", sw.url);
  await cdp.send("Runtime.enable", {}, swS);

  console.log("chrome keys:", await cdp.eval(swS, `JSON.stringify({keys: Object.keys(chrome).sort(), perms: chrome.runtime.getManifest().permissions, hasOffscreen: typeof chrome.offscreen})`));
  // 1. create offscreen doc through the real handler
  const ensure = await cdp.eval(swS, `new Promise(r => chrome.runtime.onMessage.dispatch ? r('n/a') : r(null)).then(async () => {
    const ctxs0 = await chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"]});
    await chrome.offscreen.createDocument({url:"offscreen.html", reasons:["WORKERS"], justification:"smoke"});
    const ctxs1 = await chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"]});
    return {before: ctxs0.length, after: ctxs1.length};
  })`);
  console.log("offscreen contexts:", ensure);

  const off = await findTarget((t) => t.url.endsWith("offscreen.html"));
  console.log("offscreen target:", off.type, off.url);
  const offS = await attach(off);
  await cdp.send("Runtime.enable", {}, offS);
  await cdp.send("Log.enable", {}, offS);

  // 2. warm via message from SW (real path: target:'offscreen')
  const t0 = Date.now();
  const warm = await cdp.eval(swS, `chrome.runtime.sendMessage({target:"offscreen", type:"ocrWarm"})`);
  console.log("warm:", warm, `${Date.now() - t0}ms`);

  // 3. synthetic image (printed text) as data URL, OCR with and without crop
  const png = await cdp.eval(offS, `(async () => {
    const c = new OffscreenCanvas(1000, 400);
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0,0,1000,400);
    g.fillStyle = "#000"; g.font = "48px Helvetica";
    g.fillText("Hello grid view 12345", 40, 100);
    g.fillText("Second line BOTTOM", 40, 320);
    const b = await c.convertToBlob({type:"image/png"});
    const buf = new Uint8Array(await b.arrayBuffer());
    let s = ""; for (const x of buf) s += String.fromCharCode(x);
    return "data:image/png;base64," + btoa(s);
  })()`);
  const t1 = Date.now();
  const full = await cdp.eval(swS, `chrome.runtime.sendMessage({target:"offscreen", type:"ocr", url: ${JSON.stringify(png)}, rect: null})`);
  console.log("full-page OCR:", JSON.stringify(full), `${Date.now() - t1}ms`);
  const t2 = Date.now();
  const crop = await cdp.eval(swS, `chrome.runtime.sendMessage({target:"offscreen", type:"ocr", url: ${JSON.stringify(png)}, rect: {x:0,y:0,w:100,h:40}})`);
  console.log("cropped OCR (top 40%):", JSON.stringify(crop), `${Date.now() - t2}ms`);

  // 4. cross-origin fetch under host_permissions (any amazonaws URL; expect HTTP error, not CORS/TypeError)
  const xo = await cdp.eval(swS, `chrome.runtime.sendMessage({target:"offscreen", type:"ocr", url: "https://s3.amazonaws.com/does-not-exist-gsg/x.png", rect: null})`);
  console.log("amazonaws fetch:", JSON.stringify(xo));
  const blocked = await cdp.eval(swS, `chrome.runtime.sendMessage({target:"offscreen", type:"ocr", url: "https://example.com/x.png", rect: null})`);
  console.log("non-permitted host fetch:", JSON.stringify(blocked));

  // 5. shutdown path
  const down = await cdp.eval(swS, `chrome.offscreen.closeDocument().then(() => chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"]})).then(c => c.length)`);
  console.log("offscreen contexts after close:", down);

  const logs = cdp.events.filter((e) => e.method === "Log.entryAdded" || e.method === "Runtime.exceptionThrown").map((e) => JSON.stringify(e.params).slice(0, 300));
  if (logs.length) console.log("console/log events:\n" + logs.join("\n"));
  // word boxes: percent of the full image; "Second"/"BOTTOM" sit in the lower half; cropped run still reports full-image coords
  const inRange = (w) => w.slice(1, 5).every((v) => v >= 0 && v <= 100) && w[3] > w[1] && w[4] > w[2];
  const second = full?.words?.find((w) => /^second/i.test(w[0]));
  const hello = full?.words?.find((w) => /^hello/i.test(w[0]));
  const cropHello = crop?.words?.find((w) => /^hello/i.test(w[0]));
  console.log("words:", JSON.stringify({ n: full?.words?.length, hello, second, cropHello, lines: [...new Set((full?.words || []).map((w) => w[5]))] }));
  const wordsOk =
    full?.words?.length >= 7 && full.words.every(inRange) && hello && second && hello[5] === 0 && second[5] === 1 &&
    second[2] > 50 && hello[4] < 40 && cropHello && Math.abs(cropHello[1] - hello[1]) < 1.5 && Math.abs(cropHello[2] - hello[2]) < 1.5;
  console.log("word boxes ok:", wordsOk);
  const ok = full?.ok && /hello grid view 12345/i.test(full.text) && /second line/i.test(full.text) && crop?.ok && /hello/i.test(crop.text) && !/second/i.test(crop.text) && wordsOk;
  console.log(ok ? "SMOKE OK" : "SMOKE FAIL");
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error("SMOKE ERROR:", e.message);
  if (stderr) console.error(stderr.split("\n").filter((l) => /extension|CSP|Refused|error/i.test(l)).slice(0, 20).join("\n"));
  process.exitCode = 1;
} finally {
  chrome.kill();
}
