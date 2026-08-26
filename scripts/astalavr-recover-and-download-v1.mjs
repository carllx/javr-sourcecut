#!/usr/bin/env node

// Single recovery path for the fixed AstalaVR acceptance video.
// Run 1: starts/reuses the dedicated Chrome. If Cloudflare is present, exits WAIT_FOR_HUMAN.
// Human clears Cloudflare in that SAME Chrome and keeps it open.
// Run 2: reattaches through DevToolsActivePort and downloads the lowest Direct MP4 proxy.
// No login automation, no cookie replay, no guessed CDP port, no browser restart between human clear and download.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TARGET = 'https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao';
const TARGET_FRAGMENT = '/videos/qDAVn/';
const PROFILE_DIR = process.env.JAVR_PROFILES_DIR
  ? path.join(process.env.JAVR_PROFILES_DIR, 'astalavr')
  : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.javr-sourcecut'), 'javr-sourcecut', 'profiles', 'astalavr');
const ACTIVE_PORT_FILE = path.join(PROFILE_DIR, 'DevToolsActivePort');
const OUTPUT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve('workspace', 'manual-astalavr', 'qDAVn', 'proxy-lowest.mp4');
const MAX_PROXY_BYTES = 2 * 1024 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeUrl(raw) {
  try { const u = new URL(raw); return `${u.origin}${u.pathname}`; }
  catch { return '<invalid-url>'; }
}
function findBrowser() {
  if (process.env.JAVR_BROWSER_PATH && fs.existsSync(process.env.JAVR_BROWSER_PATH)) return process.env.JAVR_BROWSER_PATH;
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/microsoft-edge',
      ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}
function fail(code, detail) {
  console.error('RESULT=RED');
  console.error(`FAILURE=${code}`);
  if (detail) console.error(String(detail));
  process.exitCode = 1;
}
function waitHuman(detail) {
  console.log('RESULT=WAIT_FOR_HUMAN');
  console.log('ACTION=Complete Cloudflare in the visible AstalaVR Chrome. KEEP THAT CHROME OPEN. Then run this exact same script once more.');
  if (detail) console.log(`DETAIL=${detail}`);
}

async function discoverLiveCdp() {
  let text;
  try { text = await fsp.readFile(ACTIVE_PORT_FILE, 'utf8'); }
  catch { return null; }
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const port = Number(lines[0]);
  if (!Number.isFinite(port) || port <= 0) return null;
  const http = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${http}/json/version`);
    if (!res.ok) return null;
    const version = await res.json();
    if (!version.webSocketDebuggerUrl) return null;
    return { http, port, wsUrl: version.webSocketDebuggerUrl };
  } catch { return null; }
}

async function ensureBrowser() {
  let cdp = await discoverLiveCdp();
  if (cdp) return { cdp, started: false };

  await fsp.mkdir(PROFILE_DIR, { recursive: true });
  await fsp.rm(ACTIVE_PORT_FILE, { force: true }).catch(() => {});
  const browser = findBrowser();
  if (!browser) throw new Error('Chrome/Edge executable not found.');

  const child = spawn(browser, [
    `--user-data-dir=${PROFILE_DIR}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    TARGET,
  ], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    cdp = await discoverLiveCdp();
    if (cdp) return { cdp, started: true };
    await sleep(200);
  }
  throw new Error('Chrome started but DevToolsActivePort did not become reachable. Do not reset the profile or rerun login.');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg.id || !this.pending.has(msg.id)) return;
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result || {});
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 15000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
}

function score(source) {
  const text = `${source.quality || ''} ${safeUrl(source.src)}`.toLowerCase();
  const p = text.match(/(\d{3,4})p?/);
  if (p) return Number(p[1]);
  const k = text.match(/([24568])k/);
  if (k) return ({ 2: 1080, 4: 2160, 5: 2560, 6: 2880, 8: 4320 })[Number(k[1])] || 99999;
  return 99999;
}
function headerValue(headers, name) {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === wanted) return Array.isArray(v) ? v.join(', ') : String(v);
  }
  return undefined;
}

async function main() {
  console.log(`TARGET=${TARGET}`);
  console.log(`PROFILE_DIR=${PROFILE_DIR}`);
  console.log(`OUTPUT=${OUTPUT}`);
  console.log('MODE=single-path human-clear then same-Chrome proxy download');
  console.log('SECRET_LOGGING=disabled');

  if (typeof WebSocket !== 'function') {
    fail('NODE_WEBSOCKET_MISSING', `Node ${process.version} does not expose global WebSocket.`);
    return;
  }

  let ensured;
  try { ensured = await ensureBrowser(); }
  catch (err) { fail('BROWSER_START_FAILED', err instanceof Error ? err.message : String(err)); return; }

  const { cdp: live, started } = ensured;
  console.log(`BROWSER_SESSION=${started ? 'started' : 'existing'}`);
  console.log(`CDP_DISCOVERED=${live.http}`);

  // If we just started Chrome, give it a moment to create/navigate the target page.
  if (started) await sleep(1500);

  let targets = [];
  try {
    const res = await fetch(`${live.http}/json/list`);
    if (res.ok) targets = await res.json();
  } catch {}

  let pageTarget = targets.find((t) => t.type === 'page' && String(t.url || '').includes(TARGET_FRAGMENT));
  if (!pageTarget) {
    try {
      const res = await fetch(`${live.http}/json/new?${encodeURIComponent(TARGET)}`, { method: 'PUT' });
      if (res.ok) pageTarget = await res.json();
    } catch {}
    if (!pageTarget) {
      waitHuman('The dedicated Chrome is running, but the fixed qDAVn page was not attached. Navigate that same visible Chrome to the fixed target URL, then rerun this script.');
      return;
    }
    await sleep(1500);
  }

  const ws = new WebSocket(live.wsUrl);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket open timed out')), 5000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP WebSocket open failed')); };
    });
  } catch (err) {
    fail('CDP_CONNECT_FAILED', err instanceof Error ? err.message : String(err));
    return;
  }

  const cdp = new Cdp(ws);
  try {
    const all = await cdp.send('Target.getTargets');
    let info = (all.targetInfos || []).find((t) => t.type === 'page' && String(t.url || '').includes(TARGET_FRAGMENT));
    if (!info) {
      waitHuman('The fixed qDAVn page is not open in the live Chrome. Navigate that same window to the target and rerun this script.');
      return;
    }

    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
    await Promise.all([
      cdp.send('Page.enable', {}, sessionId),
      cdp.send('Runtime.enable', {}, sessionId),
      cdp.send('Network.enable', {}, sessionId),
    ]);

    const inspect = await cdp.send('Runtime.evaluate', {
      expression: `(() => ({
        title: document.title || '',
        href: location.href || '',
        sources: [...document.querySelectorAll('source')].map(s => ({
          src: s.src || s.getAttribute('src') || '',
          quality: s.getAttribute('quality') || s.getAttribute('label') || s.getAttribute('res') || ''
        })).filter(x => /^https?:\\/\\//i.test(x.src) && /\\.mp4(?:\\?|$)/i.test(x.src))
      }))()`,
      returnByValue: true,
    }, sessionId);

    const page = inspect.result?.value || {};
    const title = String(page.title || '');
    console.log(`PAGE_TITLE=${title.slice(0, 120)}`);
    console.log(`PAGE=${safeUrl(page.href || TARGET)}`);

    if (/just a moment|attention required|cloudflare/i.test(title)) {
      waitHuman('Cloudflare is still present. Complete it manually in this same visible Chrome. Do not close or restart Chrome.');
      return;
    }

    const sources = Array.isArray(page.sources) ? page.sources : [];
    console.log(`RENDITION_COUNT=${sources.length}`);
    if (!sources.length) {
      waitHuman('The real content page is not ready yet or Direct MP4 sources are not present. Keep this Chrome open, confirm the video page is fully loaded, then rerun this same script.');
      return;
    }

    sources.sort((a, b) => score(a) - score(b));
    const selected = sources[0];
    console.log(`LOWEST_RENDITION=${selected.quality || 'unknown'}`);
    console.log(`MEDIA_TARGET=${safeUrl(selected.src)}`);

    if (fs.existsSync(OUTPUT)) {
      const stat = await fsp.stat(OUTPUT);
      if (stat.size > 0) {
        console.log(`PROXY_FILE=${OUTPUT}`);
        console.log(`DOWNLOADED_BYTES=${stat.size}`);
        console.log('RESULT=GREEN');
        console.log('NEXT=Proxy already exists; open it in LosslessCut.');
        return;
      }
    }

    const frameTree = await cdp.send('Page.getFrameTree', {}, sessionId);
    const frameId = frameTree.frameTree?.frame?.id;
    if (!frameId) { fail('FRAME_ID_MISSING', 'Could not determine main frame id.'); return; }

    const loaded = await cdp.send('Network.loadNetworkResource', {
      frameId,
      url: selected.src,
      options: { disableCache: true, includeCredentials: true },
    }, sessionId, 30000);

    const resource = loaded.resource || {};
    console.log(`RESOURCE_SUCCESS=${resource.success === true ? 'yes' : 'no'}`);
    console.log(`RESOURCE_STATUS=${resource.httpStatusCode ?? 'unknown'}`);
    if (!resource.success || !resource.stream) {
      fail('RESOURCE_LOAD_FAILED', resource.netError || `HTTP ${resource.httpStatusCode ?? 'unknown'}`);
      return;
    }

    const contentType = headerValue(resource.headers, 'content-type') || 'unknown';
    const rawLength = headerValue(resource.headers, 'content-length');
    const contentLength = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined;
    console.log(`CONTENT_TYPE=${contentType}`);
    console.log(`CONTENT_LENGTH=${contentLength ?? 'unknown'}`);
    if (contentLength && contentLength > MAX_PROXY_BYTES) {
      try { await cdp.send('IO.close', { handle: resource.stream }, sessionId, 3000); } catch {}
      fail('PROXY_TOO_LARGE', `Lowest rendition is ${contentLength} bytes (>2 GiB guard).`);
      return;
    }

    await fsp.mkdir(path.dirname(OUTPUT), { recursive: true });
    const tmp = `${OUTPUT}.part`;
    await fsp.rm(tmp, { force: true }).catch(() => {});
    const out = fs.createWriteStream(tmp, { flags: 'wx' });
    let total = 0;
    try {
      while (true) {
        const chunk = await cdp.send('IO.read', { handle: resource.stream, size: 1024 * 1024 }, sessionId, 30000);
        if (chunk.data) {
          const buf = chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data, 'utf8');
          total += buf.length;
          if (total > MAX_PROXY_BYTES) throw new Error('Transfer exceeded 2 GiB guard.');
          if (!out.write(buf)) await new Promise((resolve) => out.once('drain', resolve));
          if (total % (64 * 1024 * 1024) < buf.length) console.log(`DOWNLOADED_BYTES=${total}`);
        }
        if (chunk.eof) break;
      }
      await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });
      try { await cdp.send('IO.close', { handle: resource.stream }, sessionId, 3000); } catch {}
      await fsp.rename(tmp, OUTPUT);
    } catch (err) {
      out.destroy();
      await fsp.rm(tmp, { force: true }).catch(() => {});
      try { await cdp.send('IO.close', { handle: resource.stream }, sessionId, 3000); } catch {}
      fail('PROXY_STREAM_FAILED', err instanceof Error ? err.message : String(err));
      return;
    }

    console.log(`DOWNLOADED_BYTES=${total}`);
    console.log(`PROXY_FILE=${OUTPUT}`);
    console.log('RESULT=GREEN');
    console.log('NEXT=Open this proxy in LosslessCut. Keep Chrome open if continuing AstalaVR work now.');
  } catch (err) {
    fail('RECOVERY_DOWNLOAD_EXCEPTION', err instanceof Error ? err.message : String(err));
  } finally {
    try { ws.close(); } catch {}
    // Intentionally never closes Chrome.
  }
}

await main();
