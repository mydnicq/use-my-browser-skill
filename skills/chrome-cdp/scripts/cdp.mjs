#!/usr/bin/env node
// cdp - lightweight Chrome DevTools Protocol CLI
// Uses raw CDP over WebSocket, no Puppeteer dependency.
// Requires Node 22+ (built-in WebSocket).
//
// Per-browser persistent daemon: all commands go through one daemon that holds
// a single WebSocket to Chrome and attaches to tabs over it. Chrome's "Allow
// remote debugging?" prompt fires per WebSocket, so it appears once per daemon.
// The daemon auto-exits after CDP_IDLE_MINUTES (default 120) idle.

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { resolve } from 'path';
import { spawn } from 'child_process';
import net from 'net';

const TIMEOUT = 15000;
const NAVIGATION_TIMEOUT = 30000;
const IDLE_TIMEOUT = (Number(process.env.CDP_IDLE_MINUTES) || 120) * 60 * 1000;
const CONSENT_TIMEOUT = 120000; // how long to wait for the user to click Allow
const DAEMON_START_TIMEOUT = 5000;
const DAEMON_CONNECT_DELAY = 100;
const MIN_TARGET_PREFIX_LEN = 8;
const CONSOLE_BUF_MAX = 500;
const NET_BUF_MAX = 500;
const NET_URL_MAX_CHARS = 120;
const IS_WINDOWS = process.platform === 'win32';
if (!IS_WINDOWS) process.umask(0o077);
const RUNTIME_DIR = IS_WINDOWS
  ? resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'cdp')
  : process.env.XDG_RUNTIME_DIR
    ? resolve(process.env.XDG_RUNTIME_DIR, 'cdp')
    : resolve(homedir(), '.cache', 'cdp');
try { mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 }); } catch {}

// One daemon per browser instance. The ws URL embeds a per-launch GUID, so a
// restarted Chrome gets a fresh daemon instead of a dead one.
function daemonPaths(wsUrl) {
  const id = createHash('sha256').update(wsUrl).digest('hex').slice(0, 12);
  return {
    sock: IS_WINDOWS ? `\\\\.\\pipe\\cdp-${id}` : resolve(RUNTIME_DIR, `cdp-${id}.sock`),
    lock: resolve(RUNTIME_DIR, `cdp-${id}.lock`),
  };
}

function getWsUrl() {
  const home = homedir();
  // macOS: ~/Library/Application Support/<name>/DevToolsActivePort
  const macBrowsers = [
    'Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome for Testing',
    'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge',
  ];
  // Linux: ~/.config/<name>/DevToolsActivePort
  const linuxBrowsers = [
    'google-chrome', 'google-chrome-beta', 'chromium',
    'vivaldi', 'vivaldi-snapshot',
    'BraveSoftware/Brave-Browser', 'microsoft-edge',
  ];
  // Linux Flatpak: ~/.var/app/<app-id>/config/<name>/DevToolsActivePort
  const flatpakBrowsers = [
    ['org.chromium.Chromium', 'chromium'],
    ['com.google.Chrome', 'google-chrome'],
    ['com.brave.Browser', 'BraveSoftware/Brave-Browser'],
    ['com.microsoft.Edge', 'microsoft-edge'],
    ['com.vivaldi.Vivaldi', 'vivaldi'],
  ];
  const candidates = [
    process.env.CDP_PORT_FILE,
    ...macBrowsers.flatMap(b => [
      resolve(home, 'Library/Application Support', b, 'DevToolsActivePort'),
      resolve(home, 'Library/Application Support', b, 'Default/DevToolsActivePort'),
    ]),
    ...linuxBrowsers.flatMap(b => [
      resolve(home, '.config', b, 'DevToolsActivePort'),
      resolve(home, '.config', b, 'Default/DevToolsActivePort'),
    ]),
    ...flatpakBrowsers.flatMap(([appId, name]) => [
      resolve(home, '.var/app', appId, 'config', name, 'DevToolsActivePort'),
      resolve(home, '.var/app', appId, 'config', name, 'Default/DevToolsActivePort'),
    ]),
    // Windows: %LOCALAPPDATA%/<name>/User Data/DevToolsActivePort
    ...(IS_WINDOWS ? ['Google/Chrome', 'BraveSoftware/Brave-Browser', 'Microsoft/Edge'].flatMap(b => {
      const base = process.env.LOCALAPPDATA || resolve(home, 'AppData/Local');
      return [
        resolve(base, b, 'User Data/DevToolsActivePort'),
        resolve(base, b, 'User Data/Default/DevToolsActivePort'),
      ];
    }) : []),
  ].filter(Boolean);
  const portFile = candidates.find(p => existsSync(p));
  if (!portFile) throw new Error('No DevToolsActivePort found. Enable remote debugging at chrome://inspect/#remote-debugging');
  const lines = readFileSync(portFile, 'utf8').trim().split('\n');
  if (lines.length < 2 || !lines[0] || !lines[1]) throw new Error(`Invalid DevToolsActivePort file: ${portFile}`);
  const host = process.env.CDP_HOST || '127.0.0.1';
  return `ws://${host}:${lines[0]}${lines[1]}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));


function resolvePrefix(prefix, candidates, noun = 'target', missingHint = '') {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter(candidate => candidate.toUpperCase().startsWith(upper));
  if (matches.length === 0) {
    const hint = missingHint ? ` ${missingHint}` : '';
    throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`);
  }
  return matches[0];
}

function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map(id => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
    const prefixes = new Set(targetIds.map(id => id.slice(0, len).toUpperCase()));
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}

// ---------------------------------------------------------------------------
// CDP WebSocket client
// ---------------------------------------------------------------------------

class CDP {
  #ws; #id = 0; #pending = new Map(); #eventHandlers = new Map(); #closeHandlers = [];

  // Chrome holds the WebSocket upgrade open until the user answers the
  // "Allow remote debugging?" prompt, and rejects it if they click Deny.
  async connect(wsUrl, timeoutMs = TIMEOUT) {
    return new Promise((res, rej) => {
      this.#ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        rej(new Error(`no answer to Chrome's "Allow remote debugging?" prompt within ${timeoutMs / 1000}s`));
        this.#ws.close();
      }, timeoutMs);
      this.#ws.onopen = () => { clearTimeout(timer); res(); };
      this.#ws.onerror = (e) => {
        clearTimeout(timer);
        rej(new Error('WebSocket error (Chrome not running, remote debugging off, or Allow denied): ' + (e.message || e.type)));
      };
      this.#ws.onclose = () => this.#closeHandlers.forEach(h => h());
      this.#ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve, reject } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        } else if (msg.method && this.#eventHandlers.has(msg.method)) {
          for (const handler of [...this.#eventHandlers.get(msg.method)]) {
            handler(msg.params || {}, msg);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.#ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, TIMEOUT);
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method)) this.#eventHandlers.set(method, new Set());
    const handlers = this.#eventHandlers.get(method);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventHandlers.delete(method);
    };
  }

  // Pass sessionId to ignore the same event coming from other tabs
  waitForEvent(method, timeout = TIMEOUT, sessionId) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params, msg) => {
        if (settled) return;
        if (sessionId && msg.sessionId !== sessionId) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
      },
    };
  }

  onClose(handler) { this.#closeHandlers.push(handler); }
  close() { this.#ws.close(); }
}

// ---------------------------------------------------------------------------
// Command implementations — return strings, take (cdp, sessionId)
// ---------------------------------------------------------------------------

async function getPages(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('chrome://'));
}

function formatPageList(pages) {
  const prefixLen = getDisplayPrefixLength(pages.map(p => p.targetId));
  return pages.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const title = p.title.substring(0, 54).padEnd(54);
    return `${id}  ${title}  ${p.url}`;
  }).join('\n');
}

function shouldShowAxNode(node, compact = false) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
}

function formatAxNode(node, depth) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
  return line;
}

function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  return children;
}

async function snapshotStr(cdp, sid, compact = false) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sid);
  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const lines = [];
  const visited = new Set();
  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, compact)) lines.push(formatAxNode(node, depth));
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1);
    }
  }

  const roots = nodes.filter(node => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  return lines.join('\n');
}

async function evalStr(cdp, sid, expression) {
  await cdp.send('Runtime.enable', {}, sid);
  const result = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  const val = result.result.value;
  return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? '');
}

async function shotStr(cdp, sid, filePath, targetId) {
  // Get device scale factor so we can report coordinate mapping
  let dpr = 1;
  try {
    const metrics = await cdp.send('Page.getLayoutMetrics', {}, sid);
    dpr = metrics.visualViewport?.clientWidth
      ? metrics.cssVisualViewport?.clientWidth
        ? Math.round((metrics.visualViewport.clientWidth / metrics.cssVisualViewport.clientWidth) * 100) / 100
        : 1
      : 1;
    // Simpler: deviceScaleFactor is on the root Page metrics
    const { deviceScaleFactor } = await cdp.send('Emulation.getDeviceMetricsOverride', {}, sid).catch(() => ({}));
    if (deviceScaleFactor) dpr = deviceScaleFactor;
  } catch {}
  // Fallback: try to get DPR from JS
  if (dpr === 1) {
    try {
      const raw = await evalStr(cdp, sid, 'window.devicePixelRatio');
      const parsed = parseFloat(raw);
      if (parsed > 0) dpr = parsed;
    } catch {}
  }

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  const out = filePath || resolve(RUNTIME_DIR, `screenshot-${(targetId || 'unknown').slice(0, 8)}.png`);
  writeFileSync(out, Buffer.from(data, 'base64'));

  const lines = [out];
  lines.push(`Screenshot saved. Device pixel ratio (DPR): ${dpr}`);
  lines.push(`Coordinate mapping:`);
  lines.push(`  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`);
  lines.push(`  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`);
  if (dpr !== 1) {
    lines.push(`  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100/dpr)/100}`);
  }
  return lines.join('\n');
}

async function htmlStr(cdp, sid, selector) {
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
    : `document.documentElement.outerHTML`;
  return evalStr(cdp, sid, expr);
}

async function waitForDocumentReady(cdp, sid, timeoutMs = NAVIGATION_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let lastState = '';
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await evalStr(cdp, sid, 'document.readyState');
      lastState = state;
      if (state === 'complete') return;
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }

  if (lastState) {
    throw new Error(`Timed out waiting for navigation to finish (last readyState: ${lastState})`);
  }
  if (lastError) {
    throw new Error(`Timed out waiting for navigation to finish (${lastError.message})`);
  }
  throw new Error('Timed out waiting for navigation to finish');
}

async function navStr(cdp, sid, url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      throw new Error(`Only http/https URLs allowed, got: ${url}`);
  } catch (e) {
    if (e.message.startsWith('Only')) throw e;
    throw new Error(`Invalid URL: ${url}`);
  }
  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT, sid);
  const result = await cdp.send('Page.navigate', { url }, sid);
  if (result.errorText) {
    loadEvent.cancel();
    throw new Error(result.errorText);
  }
  if (result.loaderId) {
    await loadEvent.promise;
  } else {
    loadEvent.cancel();
  }
  await waitForDocumentReady(cdp, sid, 5000);
  return `Navigated to ${url}`;
}

async function netStr(cdp, sid) {
  const raw = await evalStr(cdp, sid, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.substring(0, 120), type: e.initiatorType,
    duration: Math.round(e.duration), size: e.transferSize
  })))`);
  return JSON.parse(raw).map(e =>
    `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`
  ).join('\n');
}

// Click element by CSS selector
async function clickStr(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  return `Clicked <${r.tag}> "${r.text}"`;
}

// Click at CSS pixel coordinates using Input.dispatchMouseEvent
async function clickXyStr(cdp, sid, x, y) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  const base = { x: cx, y: cy, button: 'left', clickCount: 1, modifiers: 0 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sid);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sid);
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sid);
  return `Clicked at CSS (${cx}, ${cy})`;
}

// Type text using Input.insertText (works in cross-origin iframes, unlike eval)
async function typeStr(cdp, sid, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdp.send('Input.insertText', { text }, sid);
  return `Typed ${text.length} characters`;
}

// Load-more: repeatedly click a button/selector until it disappears
async function loadAllStr(cdp, sid, selector, intervalMs = 1500) {
  if (!selector) throw new Error('CSS selector required');
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000; // 5-minute hard cap
  while (Date.now() < deadline) {
    const exists = await evalStr(cdp, sid,
      `!!document.querySelector(${JSON.stringify(selector)})`
    );
    if (exists !== 'true') break;
    const clickExpr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()
    `;
    const clicked = await evalStr(cdp, sid, clickExpr);
    if (clicked !== 'true') break;
    clicks++;
    await sleep(intervalMs);
  }
  return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
}

const LOG_DISPLAY_MAX_CHARS = 200;

// Format buffered network entries.
//
// Flags (all optional, combinable):
//   failed           : only requests that failed (any error)
//   blocked          : only requests blocked by the browser/extension (ERR_BLOCKED_BY_CLIENT)
//   method=GET|POST  : filter by HTTP method
//   status=N         : filter by exact HTTP status code
//   grep=<text>      : case-insensitive substring match on URL
//   last=N           : show only the last N entries (applied after other filters)
//
// Output columns: [idx] [time] [method] [status] [type] url  (+ error if failed)
function netlogStr(buf, ...flags) {
  let entries = [...buf];

  for (const flag of flags) {
    if (!flag) continue;
    if (flag === 'failed') {
      entries = entries.filter(e => e.failed);
    } else if (flag === 'blocked') {
      entries = entries.filter(e => e.errorText && e.errorText.includes('ERR_BLOCKED_BY_CLIENT'));
    } else if (flag.startsWith('method=')) {
      const m = flag.slice(7).toUpperCase();
      entries = entries.filter(e => e.method === m);
    } else if (flag.startsWith('status=')) {
      const s = parseInt(flag.slice(7), 10);
      entries = entries.filter(e => e.status === s);
    } else if (flag.startsWith('grep=')) {
      const needle = flag.slice(5).toLowerCase();
      entries = entries.filter(e => e.url.toLowerCase().includes(needle));
    } else if (flag.startsWith('last=')) {
      const n = parseInt(flag.slice(5), 10);
      if (!isNaN(n) && n > 0) entries = entries.slice(-n);
    }
  }

  if (entries.length === 0) {
    const desc = flags.filter(Boolean).join(' ');
    return desc ? `No entries matching [${desc}] in network buffer.` : 'Network buffer is empty (daemon just attached, or no requests yet).';
  }

  return entries.map(e => {
    const time = e.ts.slice(11, 19);
    const method = (e.method || '?').padEnd(6);
    const status = (e.status != null ? String(e.status) : e.failed ? 'FAIL' : '---').padEnd(5);
    const type = (e.type || '').padEnd(12);
    const url = e.url.length > NET_URL_MAX_CHARS
      ? e.url.slice(0, NET_URL_MAX_CHARS) + `… (use: netdetail ${e.idx})`
      : e.url;
    const suffix = e.failed ? `  \u2717 ${e.errorText || ''}${e.blockedReason ? ` [${e.blockedReason}]` : ''}` : '';
    return `[${e.idx}] [${time}] [${method}] [${status}] [${type}] ${url}${suffix}`;
  }).join('\n');
}

// Format buffered console entries.
//
// Flags (all optional, combinable):
//   level filter : all (default) | errors | warn | info | log | debug | exception
//   source filter: source=console | source=exception | source=browser
//   tail         : last=N  (show only the last N entries, applied after other filters)
//   text search  : grep=<substring>  (case-insensitive)
//
// Each entry text is truncated to LOG_DISPLAY_MAX_CHARS.
// Truncated entries show their index and a hint — use logdetail <N> to get the full text.
//
// Examples:
//   logs <t>                          all entries
//   logs <t> errors                   error + exception levels
//   logs <t> warn                     warnings only
//   logs <t> source=browser           browser-generated messages only
//   logs <t> last=20                  last 20 entries
//   logs <t> errors last=10           last 10 errors
//   logs <t> grep=TypeError           entries containing "TypeError"
//   logs <t> errors source=console grep=fetch last=5
function logsStr(buf, ...flags) {
  let entries = [...buf];

  for (const flag of flags) {
    if (!flag) continue;
    if (flag.startsWith('source=')) {
      const src = flag.slice(7);
      entries = entries.filter(e => e.source === src);
    } else if (flag.startsWith('last=')) {
      const n = parseInt(flag.slice(5), 10);
      if (!isNaN(n) && n > 0) entries = entries.slice(-n);
    } else if (flag.startsWith('grep=')) {
      const needle = flag.slice(5).toLowerCase();
      entries = entries.filter(e => e.text.toLowerCase().includes(needle));
    } else if (flag === 'errors') {
      entries = entries.filter(e => e.level === 'error' || e.level === 'exception');
    } else if (flag !== 'all') {
      entries = entries.filter(e => e.level === flag);
    }
  }

  if (entries.length === 0) {
    const desc = flags.filter(Boolean).join(' ');
    return desc ? `No entries matching [${desc}] in console buffer.` : 'Console buffer is empty (daemon just attached, or no output yet).';
  }
  return entries.map(e => {
    const time = e.ts.slice(11, 19);
    const level = e.level.padEnd(9);
    const source = e.source.padEnd(9);
    const truncated = e.text.length > LOG_DISPLAY_MAX_CHARS;
    const text = truncated
      ? e.text.slice(0, LOG_DISPLAY_MAX_CHARS) + `… (+${e.text.length - LOG_DISPLAY_MAX_CHARS} chars, use: logdetail ${e.idx})`
      : e.text;
    return `[${e.idx}] [${time}] [${level}] [${source}] ${text}`;
  }).join('\n');
}

// Send a raw CDP command and return the result as JSON
async function evalRawStr(cdp, sid, method, paramsJson) {
  if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch { throw new Error(`Invalid JSON params: ${paramsJson}`); }
  }
  const result = await cdp.send(method, params, sid);
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Browser daemon
// ---------------------------------------------------------------------------
//
// One daemon per browser holds ONE WebSocket to Chrome and attaches to tabs
// over it (flatten sessions). Chrome's "Allow remote debugging?" prompt fires
// per WebSocket connection, so this keeps it to one prompt per daemon lifetime.

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// The lock file holds the pid of the daemon that owns this browser. It makes
// concurrent CLI spawns safe: losers exit before ever dialing Chrome.
function acquireDaemonLock(lockPath) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let pid = NaN;
    let ageMs = Infinity;
    try {
      pid = parseInt(readFileSync(lockPath, 'utf8'), 10);
      ageMs = Date.now() - statSync(lockPath).mtimeMs;
    } catch {}
    if (pid ? isProcessAlive(pid) : ageMs < 5000) return false;
    try { unlinkSync(lockPath); } catch {}
  }
  return false;
}

function releaseDaemonLock(lockPath) {
  try {
    if (readFileSync(lockPath, 'utf8') === String(process.pid)) unlinkSync(lockPath);
  } catch {}
}

async function runDaemon() {
  const wsUrl = getWsUrl();
  const { sock, lock } = daemonPaths(wsUrl);
  if (!acquireDaemonLock(lock)) process.exit(0); // another daemon owns this browser

  const cdp = new CDP();
  let connected = false;
  const ready = cdp.connect(wsUrl, CONSENT_TIMEOUT).then(() => { connected = true; });
  ready.catch((e) => {
    process.stderr.write(`Daemon: cannot connect to Chrome: ${e.message}\n`);
    // Give pending clients a moment to receive the error before exiting
    setTimeout(shutdown, 500);
  });

  // ---------------------------------------------------------------------------
  // Per-tab state: session + console/network buffers
  // ---------------------------------------------------------------------------
  const tabs = new Map();          // targetId -> tab
  const tabsBySession = new Map(); // sessionId -> tab

  function createTab(targetId) {
    const tab = {
      targetId,
      sessionId: null,
      consoleBuf: [],
      logIdx: 0,
      netBuf: [],
      netByRequestId: new Map(),
      netIdx: 0,
    };
    tab.pushLog = (entry) => {
      entry.idx = tab.logIdx++;
      tab.consoleBuf.push(entry);
      if (tab.consoleBuf.length > CONSOLE_BUF_MAX) tab.consoleBuf.shift();
    };
    tab.pushNet = (entry) => {
      entry.idx = tab.netIdx++;
      tab.netBuf.push(entry);
      tab.netByRequestId.set(entry.requestId, entry);
      if (tab.netBuf.length > NET_BUF_MAX) {
        const evicted = tab.netBuf.shift();
        tab.netByRequestId.delete(evicted.requestId);
      }
    };
    return tab;
  }

  async function attachTab(tab) {
    const res = await cdp.send('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
    tab.sessionId = res.sessionId;
    tabsBySession.set(tab.sessionId, tab);

    // Enable domains and subscribe to all three console streams
    try {
      await cdp.send('Runtime.enable', {}, tab.sessionId);
      await cdp.send('Log.enable', {}, tab.sessionId);
    } catch (e) {
      process.stderr.write(`Daemon: console stream enable failed: ${e.message}\n`);
    }
    try {
      await cdp.send('Network.enable', {}, tab.sessionId);
    } catch (e) {
      process.stderr.write(`Daemon: Network.enable failed: ${e.message}\n`);
    }
  }

  // Attach lazily on first use; concurrent commands share one attach
  async function getTab(targetId) {
    let tab = tabs.get(targetId);
    if (!tab) {
      tab = createTab(targetId);
      tab.attaching = attachTab(tab);
      tabs.set(targetId, tab);
    }
    try {
      await tab.attaching;
    } catch (e) {
      dropTab(tab);
      throw new Error(`attach failed: ${e.message}`);
    }
    return tab;
  }

  function dropTab(tab) {
    if (tabs.get(tab.targetId) === tab) tabs.delete(tab.targetId);
    if (tab.sessionId) tabsBySession.delete(tab.sessionId);
  }

  // Route session-scoped events to the tab they belong to
  function onTabEvent(method, handler) {
    cdp.onEvent(method, (params, msg) => {
      const tab = tabsBySession.get(msg.sessionId);
      if (tab) handler(tab, params);
    });
  }

  // ---------------------------------------------------------------------------
  // Network request buffer — mirrors what you see in DevTools Network tab
  // ---------------------------------------------------------------------------
  onTabEvent('Network.requestWillBeSent', (tab, params) => {
    tab.pushNet({
      ts: new Date(params.wallTime * 1000).toISOString(),
      requestId: params.requestId,
      method: params.request.method,
      url: params.request.url,
      type: params.type || '',
      requestHeaders: params.request.headers || {},
      requestBody: params.request.postData || null,
      status: null,
      failed: false,
      errorText: null,
      blockedReason: null,
    });
  });

  onTabEvent('Network.responseReceived', (tab, params) => {
    const entry = tab.netByRequestId.get(params.requestId);
    if (entry) entry.status = params.response.status;
  });

  onTabEvent('Network.loadingFailed', (tab, params) => {
    const entry = tab.netByRequestId.get(params.requestId);
    if (entry) {
      entry.failed = true;
      entry.errorText = params.errorText || null;
      entry.blockedReason = params.blockedReason || null;
    }
  });

  // ---------------------------------------------------------------------------
  // Console log buffer — mirrors what you see in DevTools console
  // ---------------------------------------------------------------------------

  // Serialize a RemoteObject arg eagerly.
  // Primitives: use value directly.
  // Objects: JSON.stringify via callFunctionOn while objectId is still alive.
  // Falls back to CDP preview if callFunctionOn fails (context already gone).
  async function serializeArg(arg, sessionId) {
    if (arg.value !== undefined) return String(arg.value);
    if (arg.objectId) {
      try {
        const res = await cdp.send('Runtime.callFunctionOn', {
          objectId: arg.objectId,
          functionDeclaration: 'function() { try { return JSON.stringify(this, null, 2); } catch(e) { return String(this); } }',
          returnByValue: true,
        }, sessionId);
        if (res.result?.value !== undefined) return res.result.value;
      } catch { /* objectId released — fall through to preview */ }
    }
    if (arg.preview?.properties?.length) {
      const props = arg.preview.properties.map(p => `${p.name}: ${p.value}`).join(', ');
      return `${arg.description} { ${props}${arg.preview.overflow ? ', ...' : ''} }`;
    }
    return arg.description ?? arg.type;
  }

  // 1. console.log / .warn / .error / .info / .debug / etc.
  onTabEvent('Runtime.consoleAPICalled', async (tab, params) => {
    const parts = await Promise.all(params.args.map(arg => serializeArg(arg, tab.sessionId)));
    tab.pushLog({
      ts: new Date(params.timestamp).toISOString(),
      level: params.type,
      source: 'console',
      text: parts.join(' '),
    });
  });

  // 2. Unhandled JS exceptions and promise rejections
  onTabEvent('Runtime.exceptionThrown', (tab, params) => {
    const ex = params.exceptionDetails;
    const text = ex.exception?.description ?? ex.text ?? 'Unknown exception';
    tab.pushLog({ ts: new Date(params.timestamp).toISOString(), level: 'exception', source: 'exception', text });
  });

  // 3. Browser-generated messages: network errors, CSP violations, deprecations, etc.
  onTabEvent('Log.entryAdded', (tab, params) => {
    const e = params.entry;
    tab.pushLog({ ts: new Date(e.timestamp).toISOString(), level: e.level, source: 'browser', text: e.text });
  });

  // Forget a tab when it closes or its session detaches; the daemon stays up
  cdp.onEvent('Target.detachedFromTarget', (params) => {
    const tab = tabsBySession.get(params.sessionId);
    if (tab) dropTab(tab);
  });
  cdp.onEvent('Target.targetDestroyed', (params) => {
    const tab = tabs.get(params.targetId);
    if (tab) dropTab(tab);
  });

  // Shutdown helpers
  let alive = true;
  function shutdown() {
    if (!alive) return;
    alive = false;
    server.close();
    if (!IS_WINDOWS) try { unlinkSync(sock); } catch {}
    releaseDaemonLock(lock);
    if (connected) cdp.close();
    process.exit(0);
  }

  // Exit if Chrome disconnects (quit, restart, remote debugging toggled off).
  // Registered after connect so a failed connect can still report its error.
  ready.then(() => cdp.onClose(() => shutdown()), () => {});
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Idle timer
  let idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  }

  async function resolveTarget(prefix) {
    if (!prefix) throw new Error('target ID required. Run "cdp list" first.');
    const pages = await getPages(cdp);
    return resolvePrefix(prefix, pages.map(p => p.targetId), 'target', 'Run "cdp list".');
  }

  // Handle a command
  async function handleCommand({ cmd, target, args = [] }, notify) {
    resetIdle();
    if (!connected) {
      notify({ status: 'waiting-for-allow' });
      try {
        await ready;
      } catch (e) {
        return { ok: false, error: `Cannot connect to Chrome: ${e.message}` };
      }
    }
    try {
      let result;
      switch (cmd) {
        case 'list': {
          const pages = await getPages(cdp);
          result = formatPageList(pages);
          break;
        }
        case 'list_raw': {
          const pages = await getPages(cdp);
          result = JSON.stringify(pages);
          break;
        }
        case 'open': {
          const url = args[0] || 'about:blank';
          const { targetId } = await cdp.send('Target.createTarget', { url });
          const pages = await getPages(cdp);
          const ids = pages.some(p => p.targetId === targetId) ? pages.map(p => p.targetId) : [...pages.map(p => p.targetId), targetId];
          result = `Opened new tab: ${targetId.slice(0, getDisplayPrefixLength(ids))}  ${url}`;
          break;
        }
        case 'close': {
          const targetId = await resolveTarget(target);
          await cdp.send('Target.closeTarget', { targetId });
          const tab = tabs.get(targetId);
          if (tab) dropTab(tab);
          result = `Closed tab ${target}`;
          break;
        }
        case 'stop': {
          if (!target) return { ok: true, result: 'Daemon stopped', stopAfter: true };
          const targetId = await resolveTarget(target);
          const tab = tabs.get(targetId);
          if (!tab) { result = `Not attached to ${target}`; break; }
          dropTab(tab);
          if (tab.sessionId) await cdp.send('Target.detachFromTarget', { sessionId: tab.sessionId }).catch(() => {});
          result = `Detached from ${target}`;
          break;
        }
        default: {
          if (!NEEDS_TARGET.has(cmd)) return { ok: false, error: `Unknown command: ${cmd}` };
          const tab = await getTab(await resolveTarget(target));
          result = await handleTabCommand(tab, cmd, args);
        }
      }
      return { ok: true, result: result ?? '' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function handleTabCommand(tab, cmd, args) {
    const sid = tab.sessionId;
    switch (cmd) {
      case 'snap': case 'snapshot': return snapshotStr(cdp, sid, true);
      case 'eval': return evalStr(cdp, sid, args[0]);
      case 'shot': case 'screenshot': return shotStr(cdp, sid, args[0], tab.targetId);
      case 'html': return htmlStr(cdp, sid, args[0]);
      case 'nav': case 'navigate': return navStr(cdp, sid, args[0]);
      case 'net': case 'network': return netStr(cdp, sid);
      case 'click': return clickStr(cdp, sid, args[0]);
      case 'clickxy': return clickXyStr(cdp, sid, args[0], args[1]);
      case 'type': return typeStr(cdp, sid, args[0]);
      case 'loadall': return loadAllStr(cdp, sid, args[0], args[1] ? parseInt(args[1]) : 1500);
      case 'evalraw': return evalRawStr(cdp, sid, args[0], args[1]);
      case 'netlog': return netlogStr(tab.netBuf, ...args);
      case 'netdetail': {
        const n = parseInt(args[0], 10);
        const entry = tab.netBuf.find(e => e.idx === n);
        if (!entry) return `No entry with index ${n} in network buffer.`;
        return JSON.stringify(entry, null, 2);
      }
      case 'logs': return logsStr(tab.consoleBuf, ...args);
      case 'logdetail': {
        const n = parseInt(args[0], 10);
        const entry = tab.consoleBuf.find(e => e.idx === n);
        if (!entry) return `No entry with index ${n} in buffer.`;
        return `[${entry.idx}] [${entry.ts.slice(11, 19)}] [${entry.level}] [${entry.source}]\n${entry.text}`;
      }
    }
  }

  // Unix socket server — NDJSON protocol
  // Wire format: each message is one JSON object followed by \n (newline-delimited JSON).
  // Request:  { "id": <number>, "cmd": "<command>", "target": "<prefix>", "args": ["arg1", ...] }
  // Response: { "id": <number>, "ok": <boolean>, "result": "<string>" }
  //           or { "id": <number>, "ok": false, "error": "<message>" }
  // Notice:   { "id": <number>, "status": "waiting-for-allow" } (sent before the response
  //           while Chrome's "Allow remote debugging?" prompt is unanswered)
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('error', () => {});
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          conn.write(JSON.stringify({ ok: false, error: 'Invalid JSON request', id: null }) + '\n');
          continue;
        }
        const notify = (msg) => conn.write(JSON.stringify({ ...msg, id: req.id }) + '\n');
        handleCommand(req, notify).then((res) => {
          const payload = JSON.stringify({ ...res, id: req.id }) + '\n';
          if (res.stopAfter) conn.end(payload, shutdown);
          else conn.write(payload);
        });
      }
    });
  });

  server.on('error', (e) => {
    process.stderr.write(`Daemon server listen failed: ${e.message}\n`);
    releaseDaemonLock(lock);
    process.exit(1);
  });

  // We hold the lock, so any socket file left behind is stale
  if (!IS_WINDOWS) try { unlinkSync(sock); } catch {}
  // Listen before Chrome answers so CLIs can queue up behind a single prompt
  server.listen(sock);
}

// ---------------------------------------------------------------------------
// CLI ↔ daemon communication
// ---------------------------------------------------------------------------

function connectToSocket(sp) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sp);
    conn.on('connect', () => resolve(conn));
    conn.on('error', reject);
  });
}

async function getOrStartDaemon({ spawnIfMissing = true } = {}) {
  const { sock } = daemonPaths(getWsUrl());
  // Try existing daemon
  try { return await connectToSocket(sock); } catch {}
  if (!spawnIfMissing) return null;

  // Spawn daemon. If several CLIs race here, the daemon lock lets only one
  // of the spawned daemons dial Chrome; the rest exit immediately.
  const child = spawn(process.execPath, [process.argv[1], '_daemon'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // The daemon listens before connecting to Chrome, so this is quick
  const deadline = Date.now() + DAEMON_START_TIMEOUT;
  while (Date.now() < deadline) {
    await sleep(DAEMON_CONNECT_DELAY);
    try { return await connectToSocket(sock); } catch {}
  }
  throw new Error(`Daemon failed to start (runtime dir: ${RUNTIME_DIR})`);
}

function sendCommand(conn, req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;

    const cleanup = () => {
      conn.off('data', onData);
      conn.off('error', onError);
      conn.off('end', onEnd);
      conn.off('close', onClose);
    };

    const onData = (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const msg = JSON.parse(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
        if (msg.status === 'waiting-for-allow') {
          process.stderr.write('Waiting for "Allow remote debugging?" approval in Chrome...\n');
          continue;
        }
        settled = true;
        cleanup();
        resolve(msg);
        conn.end();
        return;
      }
    };

    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    conn.on('data', onData);
    conn.on('error', onError);
    conn.on('end', onEnd);
    conn.on('close', onClose);
    req.id = 1;
    conn.write(JSON.stringify(req) + '\n');
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `cdp - lightweight Chrome DevTools Protocol CLI (no Puppeteer)

Usage: cdp <command> [args]

  list                              List open pages (shows unique target prefixes)
  snap  <target>                    Accessibility tree snapshot
  eval  <target> <expr>             Evaluate JS expression
  shot  <target> [file]             Screenshot (default: screenshot-<target>.png in runtime dir); prints coordinate mapping
  html  <target> [selector]         Get HTML (full page or CSS selector)
  nav   <target> <url>              Navigate to URL and wait for load completion
  net   <target>                    Network performance entries
  click   <target> <selector>       Click an element by CSS selector
  clickxy <target> <x> <y>          Click at CSS pixel coordinates (see coordinate note below)
  type    <target> <text>           Type text at current focus via Input.insertText
                                    Works in cross-origin iframes unlike eval-based approaches
  loadall <target> <selector> [ms]  Repeatedly click a "load more" button until it disappears
                                    Optional interval in ms between clicks (default 1500)
  evalraw <target> <method> [json]  Send a raw CDP command; returns JSON result
                                    e.g. evalraw <t> "DOM.getDocument" '{}'
  logs      <target> [flags...]      Show buffered console output; entries truncated to 200 chars
                                    Flags (combinable): all | errors | warn | info | log | debug | exception
                                                        source=console | source=exception | source=browser
                                                        last=N  grep=<text>
  logdetail <target> <N>            Full text of entry N (index shown in logs output)
  netlog    <target> [flags...]      Show buffered network requests captured since the tab was attached
                                    Flags (combinable): failed | blocked | method=GET|POST|...
                                                        status=N (exact) | grep=<url-text> | last=N
  netdetail <target> <N>            Full JSON details of network entry N
  open  [url]                       Open a new tab (default: about:blank)
  close <target>                    Close a tab
  stop  [target]                    Detach from one tab, or stop the daemon

<target> is a unique targetId prefix from "cdp list". If a prefix is ambiguous,
use more characters.

COORDINATE SYSTEM
  shot captures the viewport at the device's native resolution.
  The screenshot image size = CSS pixels × DPR (device pixel ratio).
  For CDP Input events (clickxy, etc.) you need CSS pixels, not image pixels.

    CSS pixels = screenshot image pixels / DPR

  shot prints the DPR and an example conversion for the current page.
  Typical Retina (DPR=2): CSS px ≈ screenshot px × 0.5
  If your viewer rescales the image further, account for that scaling too.

EVAL SAFETY NOTE
  Avoid index-based DOM selection (querySelectorAll(...)[i]) across multiple
  eval calls when the list can change between calls (e.g. after clicking
  "Ignore" buttons on a feed — indices shift). Prefer stable selectors or
  collect all data in a single eval.

DAEMON
  All commands go through one background daemon per browser. It holds a single
  WebSocket to Chrome, so the "Allow remote debugging?" prompt appears once per
  daemon, not per tab or per command. The daemon exits after ${IDLE_TIMEOUT / 60000} min of
  inactivity (set CDP_IDLE_MINUTES to change), when Chrome disconnects, or on
  "cdp stop". If the prompt is not answered within ${CONSENT_TIMEOUT / 1000}s the command fails.

DAEMON IPC (for advanced use / scripting)
  The daemon listens on a Unix socket in ${RUNTIME_DIR}.
  Protocol: newline-delimited JSON (one JSON object per line, UTF-8).
    Request:  {"id":<number>, "cmd":"<command>", "target":"<prefix>", "args":["arg1",...]}
    Response: {"id":<number>, "ok":true,  "result":"<string>"}
           or {"id":<number>, "ok":false, "error":"<message>"}
    Notice:   {"id":<number>, "status":"waiting-for-allow"}  (precedes the response)
  Commands mirror the CLI. Use evalraw to send arbitrary CDP methods.
`;

const NEEDS_TARGET = new Set([
  'snap','snapshot','eval','shot','screenshot','html','nav','navigate',
  'net','network','click','clickxy','type','loadall','evalraw','logs','logdetail','netlog','netdetail',
]);

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  // Daemon mode (internal)
  if (cmd === '_daemon') { await runDaemon(); return; }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE); process.exit(0);
  }

  let req;
  if (cmd === 'list' || cmd === 'ls') {
    req = { cmd: 'list' };
  } else if (cmd === 'open') {
    req = { cmd: 'open', args: [args[0] || 'about:blank'] };
  } else if (cmd === 'close') {
    if (!args[0]) { console.error('Error: target ID required. Run "cdp list" first.'); process.exit(1); }
    req = { cmd: 'close', target: args[0] };
  } else if (cmd === 'stop') {
    // Never spawn a daemon just to stop it — that would trigger a prompt
    const conn = await getOrStartDaemon({ spawnIfMissing: false });
    if (!conn) { console.log('No daemon running'); return; }
    const response = await sendCommand(conn, { cmd: 'stop', target: args[0] });
    if (response.ok) console.log(response.result);
    else { console.error('Error:', response.error); process.exitCode = 1; }
    return;
  } else if (NEEDS_TARGET.has(cmd)) {
    // Page commands — need target prefix
    const target = args[0];
    if (!target) {
      console.error('Error: target ID required. Run "cdp list" first.');
      process.exit(1);
    }

    const cmdArgs = args.slice(1);

    if (cmd === 'eval') {
      const expr = cmdArgs.join(' ');
      if (!expr) { console.error('Error: expression required'); process.exit(1); }
      cmdArgs.splice(0, cmdArgs.length, expr);
    } else if (cmd === 'type') {
      // Join all remaining args as text (allows spaces)
      const text = cmdArgs.join(' ');
      if (!text) { console.error('Error: text required'); process.exit(1); }
      cmdArgs.splice(0, cmdArgs.length, text);
    } else if (cmd === 'evalraw') {
      // args: [method, ...jsonParts] — join json parts in case of spaces
      if (!cmdArgs[0]) { console.error('Error: CDP method required'); process.exit(1); }
      if (cmdArgs.length > 2) cmdArgs.splice(1, cmdArgs.length - 1, cmdArgs.slice(1).join(' '));
    }

    if ((cmd === 'nav' || cmd === 'navigate') && !cmdArgs[0]) {
      console.error('Error: URL required');
      process.exit(1);
    }

    req = { cmd, target, args: cmdArgs };
  } else {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  const conn = await getOrStartDaemon();
  const response = await sendCommand(conn, req);

  if (response.ok) {
    if (response.result) console.log(response.result);
  } else {
    console.error('Error:', response.error);
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
