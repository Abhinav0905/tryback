// Minimal Chrome DevTools Protocol driver for local scripts (demo recording, gate tuning,
// screenshots). No Puppeteer dependency: spawns a local Chrome/Chromium with
// --remote-debugging-port and talks to one page target over the global WebSocket.
//
//   const browser = await launchChrome({ width: 1440, height: 900 });
//   const page = await browser.newPage();
//   await page.goto("http://localhost:3000/demo");
//   await page.waitForSelector("text=Start a return");
//   await page.screenshotToFile("shot.png");
//   await browser.close();
//
// Selectors: plain CSS, or "text=Some visible text" (first visible element whose
// trimmed textContent contains it, preferring buttons/links/labels). Selectors can be
// scoped into a same-origin iframe with `{ frame: "iframe#phone" }`.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((p): p is string => Boolean(p));

export function findChrome(): string | null {
  return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface LaunchOptions {
  headless?: boolean;
  width?: number;
  height?: number;
  /** Device pixel ratio for the page viewport (2 = retina-quality frames). */
  deviceScaleFactor?: number;
  /** Extra Chrome flags. */
  args?: string[];
  /** Fake camera + auto-allow permission prompts (getUserMedia works headless). */
  fakeMedia?: boolean;
}

type Json = Record<string, unknown>;
type Listener = (params: Json, sessionId?: string) => void;

class Connection {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; method: string }>();
  private listeners = new Map<string, Set<Listener>>();
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: Json;
        error?: { message: string; data?: string };
        method?: string;
        params?: Json;
        sessionId?: string;
      };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ""}`));
        else p.resolve(msg.result ?? {});
        return;
      }
      if (msg.method) {
        for (const l of this.listeners.get(msg.method) ?? []) l(msg.params ?? {}, msg.sessionId);
      }
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`CDP connection closed during ${p.method}`));
      this.pending.clear();
    });
  }

  static async open(url: string): Promise<Connection> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error(`Could not connect to ${url}`)), { once: true });
    });
    return new Connection(ws);
  }

  send<T extends Json = Json>(method: string, params: Json = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`CDP connection closed (${method})`));
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: Json) => void, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, l: Listener): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(l);
    return () => set!.delete(l);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export interface Browser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
  port: number;
}

export async function launchChrome(opts: LaunchOptions = {}): Promise<Browser> {
  const chrome = findChrome();
  if (!chrome) throw new Error("Chrome/Chromium not found. Install Google Chrome or set CHROME_PATH.");
  const port = await freePort();
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "tryback-chrome-"));
  const width = opts.width ?? 1440;
  const height = opts.height ?? 900;
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--hide-scrollbars",
    "--mute-audio",
    ...(opts.headless === false ? [] : ["--headless=new"]),
    ...(opts.fakeMedia ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] : []),
    ...(opts.args ?? []),
    "about:blank",
  ];
  const proc: ChildProcess = spawn(chrome, args, { stdio: "ignore" });
  let browserWs: string | null = null;
  for (let i = 0; i < 80 && !browserWs; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      browserWs = ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
    } catch {
      await sleep(150);
    }
  }
  if (!browserWs) {
    proc.kill("SIGKILL");
    throw new Error("Chrome did not expose a DevTools endpoint");
  }
  const conn = await Connection.open(browserWs);

  const browser: Browser = {
    port,
    async newPage() {
      const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      const page = new Page(conn, sessionId, targetId);
      await page.init({ width, height, deviceScaleFactor: opts.deviceScaleFactor ?? 1 });
      return page;
    },
    async close() {
      try {
        await conn.send("Browser.close");
      } catch {
        /* already gone */
      }
      conn.close();
      await sleep(200);
      if (proc.exitCode === null) proc.kill("SIGKILL");
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
  return browser;
}

export interface ScopedOptions {
  /** CSS selector of a same-origin iframe to run the selector inside. */
  frame?: string;
  timeoutMs?: number;
}

/** In-page helper source: resolves "text=" and CSS selectors, optionally inside an iframe. */
const FIND_FN = `(function(sel, frameSel){
  var doc = document;
  if (frameSel) {
    var fr = document.querySelector(frameSel);
    if (!fr || !fr.contentDocument) return null;
    doc = fr.contentDocument;
  }
  function visible(el){
    var r = el.getBoundingClientRect();
    var cs = (el.ownerDocument.defaultView || window).getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.01;
  }
  if (sel.indexOf('text=') === 0) {
    var want = sel.slice(5).trim().toLowerCase();
    var pref = doc.querySelectorAll('button, a, label, [role=button], [role=tab], [role=option], [role=radio], [role=checkbox], summary');
    var i, el;
    for (i = 0; i < pref.length; i++) { el = pref[i]; if (visible(el) && (el.textContent||'').replace(/\\s+/g,' ').trim().toLowerCase().indexOf(want) !== -1) return el; }
    var all = doc.querySelectorAll('body *');
    var best = null;
    for (i = 0; i < all.length; i++) {
      el = all[i];
      if (!visible(el)) continue;
      var t = (el.textContent||'').replace(/\\s+/g,' ').trim().toLowerCase();
      if (t.indexOf(want) !== -1 && (!best || best.contains(el))) best = el;
    }
    return best;
  }
  var els = doc.querySelectorAll(sel);
  for (var j = 0; j < els.length; j++) if (visible(els[j])) return els[j];
  return null;
})`;

/**
 * In-page JS expression that evaluates to the element a selector resolves to (same rules as
 * Page.waitForSelector/click: "text=…" or CSS, optionally inside `frame`), or null.
 * For callers that need the element itself, e.g. to animate a scroll before clicking.
 */
export function findElementExpression(selector: string, frame?: string): string {
  return `${FIND_FN}(${JSON.stringify(selector)}, ${JSON.stringify(frame ?? null)})`;
}

export class Page {
  constructor(
    private conn: Connection,
    readonly sessionId: string,
    readonly targetId: string,
  ) {}

  consoleErrors: string[] = [];

  async init(v: { width: number; height: number; deviceScaleFactor: number }) {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("DOM.enable");
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: v.width,
      height: v.height,
      deviceScaleFactor: v.deviceScaleFactor,
      mobile: false,
    });
    this.on("Runtime.exceptionThrown", (p) => {
      const d = p.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      this.consoleErrors.push(d?.exception?.description ?? d?.text ?? "exception");
    });
    this.on("Runtime.consoleAPICalled", (p) => {
      if (p.type === "error") {
        const args = (p.args as { value?: unknown; description?: string }[]) ?? [];
        this.consoleErrors.push(args.map((a) => String(a.value ?? a.description ?? "")).join(" "));
      }
    });
  }

  send<T extends Json = Json>(method: string, params: Json = {}): Promise<T> {
    return this.conn.send<T>(method, params, this.sessionId);
  }

  on(method: string, l: (params: Json) => void): () => void {
    return this.conn.on(method, (params, sid) => {
      if (sid === this.sessionId) l(params);
    });
  }

  waitForEvent(method: string, timeoutMs = 30_000, predicate: (p: Json) => boolean = () => true): Promise<Json> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const off = this.on(method, (p) => {
        if (!predicate(p)) return;
        clearTimeout(t);
        off();
        resolve(p);
      });
    });
  }

  /** Evaluate an expression (awaits promises) and return its JSON value. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const res = await this.send<{ result: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    );
    if (res.exceptionDetails) {
      throw new Error(`evaluate failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result.value as T;
  }

  async goto(url: string, timeoutMs = 45_000): Promise<void> {
    const loaded = this.waitForEvent("Page.loadEventFired", timeoutMs);
    await this.send("Page.navigate", { url });
    await loaded;
  }

  async waitForFunction(expression: string, timeoutMs = 30_000, pollMs = 100): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(`(() => { try { return (${expression}); } catch (e) { return false; } })()`);
        if (last) return last;
      } catch {
        /* navigation in progress */
      }
      await sleep(pollMs);
    }
    throw new Error(`Timed out waiting for: ${expression.slice(0, 120)}`);
  }

  private findExpr(selector: string, frame?: string): string {
    return `${FIND_FN}(${JSON.stringify(selector)}, ${JSON.stringify(frame ?? null)})`;
  }

  async exists(selector: string, o: ScopedOptions = {}): Promise<boolean> {
    return this.evaluate<boolean>(`!!${this.findExpr(selector, o.frame)}`).catch(() => false);
  }

  async waitForSelector(selector: string, o: ScopedOptions = {}): Promise<void> {
    await this.waitForFunction(`!!${this.findExpr(selector, o.frame)}`, o.timeoutMs ?? 30_000);
  }

  /** Viewport-space centre of an element (accounts for iframe offset). */
  async center(selector: string, o: ScopedOptions = {}): Promise<{ x: number; y: number }> {
    await this.waitForSelector(selector, o);
    const pt = await this.evaluate<{ x: number; y: number } | null>(`(() => {
      const el = ${this.findExpr(selector, o.frame)};
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      let x = r.left + r.width / 2, y = r.top + r.height / 2;
      ${o.frame ? `const fr = document.querySelector(${JSON.stringify(o.frame)}); const fb = fr.getBoundingClientRect();
      // The iframe may be CSS-transformed (e.g. a scaled phone frame): map through its scale.
      const sx = fr.offsetWidth ? fb.width / fr.offsetWidth : 1, sy = fr.offsetHeight ? fb.height / fr.offsetHeight : 1;
      x = fb.left + (fr.clientLeft + x) * sx; y = fb.top + (fr.clientTop + y) * sy;` : ""}
      return { x, y };
    })()`);
    if (!pt) throw new Error(`Element not found: ${selector}`);
    return pt;
  }

  async mouseMove(x: number, y: number, steps = 1, from?: { x: number; y: number }): Promise<void> {
    const start = from ?? { x, y };
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x + (x - start.x) * t, y: start.y + (y - start.y) * t });
      if (steps > 1) await sleep(12);
    }
  }

  /** Real mouse click at the element's centre (fires pointer/mouse/click events like a user). */
  async click(selector: string, o: ScopedOptions = {}): Promise<void> {
    const { x, y } = await this.center(selector, o);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /** Focus an input and type text key by key (React-friendly). */
  async type(selector: string, text: string, o: ScopedOptions & { delayMs?: number; clear?: boolean } = {}): Promise<void> {
    await this.click(selector, o);
    if (o.clear) {
      await this.evaluate(`(() => { const el = ${this.findExpr(selector, o.frame)}; if (el && 'select' in el) el.select(); })()`);
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    }
    for (const ch of text) {
      await this.send("Input.insertText", { text: ch });
      if (o.delayMs) await sleep(o.delayMs);
    }
  }

  async press(key: "Enter" | "Tab" | "Escape" | "ArrowLeft" | "ArrowRight"): Promise<void> {
    const codes: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowRight: 39 };
    const base = { key, code: key, windowsVirtualKeyCode: codes[key] };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(key === "Enter" ? { text: "\r" } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** Attach local files to an <input type=file> (works inside same-origin iframes too). */
  async setFiles(selector: string, files: string[], o: ScopedOptions = {}): Promise<void> {
    await this.waitForFunction(`!!${this.findExprAny(selector, o.frame)}`, o.timeoutMs ?? 30_000);
    const { result } = await this.send<{ result: { objectId?: string } }>("Runtime.evaluate", {
      expression: this.findExprAny(selector, o.frame),
    });
    if (!result.objectId) throw new Error(`File input not found: ${selector}`);
    const { node } = await this.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { objectId: result.objectId });
    await this.send("DOM.setFileInputFiles", { files: files.map((f) => path.resolve(f)), backendNodeId: node.backendNodeId });
  }

  /** Like findExpr but does not require visibility (file inputs are usually hidden). */
  private findExprAny(selector: string, frame?: string): string {
    return `(function(){ var d = document; ${frame ? `var fr = document.querySelector(${JSON.stringify(frame)}); if (!fr || !fr.contentDocument) return null; d = fr.contentDocument;` : ""} return d.querySelector(${JSON.stringify(selector)}); })()`;
  }

  async screenshot(o: { format?: "png" | "jpeg"; quality?: number } = {}): Promise<Buffer> {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: o.format ?? "png",
      ...(o.format === "jpeg" ? { quality: o.quality ?? 90 } : {}),
    });
    return Buffer.from(data, "base64");
  }

  async screenshotToFile(file: string, o: { format?: "png" | "jpeg"; quality?: number } = {}): Promise<void> {
    writeFileSync(file, await this.screenshot(o));
  }

  async close(): Promise<void> {
    try {
      await this.conn.send("Target.closeTarget", { targetId: this.targetId });
    } catch {
      /* ignore */
    }
  }
}

/** Wait until `url` answers 2xx (or until timeout). */
export async function waitForHttp(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`Server at ${url} did not come up within ${Math.round(timeoutMs / 1000)} s`);
}
