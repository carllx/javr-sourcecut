#!/usr/bin/env node

// One-shot human-assisted AstalaVR recovery/download for the fixed qDAVn acceptance video.
// The Node process stays alive while the human clears Cloudflare so the SAME Chrome/CDP session survives.
// No login automation, no cookie replay, no guessed CDP port, no browser restart between challenge and download.

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
const HUMAN_WINDOW_MS = 10 * 60 * 1000;
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

async function waitForCdp(child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const live = await discoverLiveCdp();
    if (live) return live;
    if (child && child.exitCode != null) throw new Error(`Chrome exited before CDP became ready (exit=${child.exitCode}).`);
    await sleep(150);
  }
  throw new Error('Chrome did not expose DevToolsActivePort within 15 seconds.');
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
  send(method, params = {}, timeoutMs = 15000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function connectPage(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Page CDP WebSocket open timed out')), 5000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('Page CDP WebSocket open failed')); };
  });
  const cdp = new Cdp(ws);
  await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Network.enable')]);
  return { ws, cdp };
}

async function listPages(http) {
  const res = await fetch(`${http}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list returned HTTP ${res.status}`);
  const list = await res.json();
  return Array.isArray(list) ? list.filter((t) => t.type === 'page') : [];
}

async function createTarget(http) {
  const res = await fetch(`${http}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`CDP /json/new returned HTTP ${res.status}`);
  return res.json();
}

async function getOrCreateTarget(http) {
  let pages = await listPages(http);
  let target = pages.find((t) => String(t.url || '').includes(TARGET_FRAGMENT));
  if (target) return target;
  target = await createTarget(http);
  if (!target.webSocketDebuggerUrl) throw new Error('Created page target did not expose webSocketDebuggerUrl.');
  return target;
}

async function inspectPage(cdp) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `(() => ({
      title: document.title || '',
      href: location.href || '',
      readyState: document.readyState || '',
      sources: [...document.querySelectorAll('source')].map(s => ({
        src: s.src || s.getAttribute('src') || '',
        quality: s.getAttribute('quality') || s.getAttribute('label') || s.getAttribute('res') || ''
      })).filter(x => /^https?:\\/\\//i.test(x.src) && /\\.mp4(?:\\?|$)/i.test(x.src))
    }))()`,
    returnByValue: true,
  });
  return result.result?.value || {};
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

async function downloadLowest(cdp, sources) {
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

  const frameTree = await cdp.send('Page.getFrameTree');
  const frameId = frameTree.frameTree?.frame?.id;
  if (!frameId) throw new Error('Could not determine main frame id.');

  const loaded = await cdp.send('Network.loadNetworkResource', {
    frameId,
    url: selected.src,
    options: { disableCache: true, includeCredentials: true },
  }, 30000);

  const resource = loaded.resource || {};
  console.log(`RESOURCE_SUCCESS=${resource.success === true ? 'yes' : 'no'}`);
  console.log(`RESOURCE_STATUS=${resource.httpStatusCode ?? 'unknown'}`);
  if (!resource.success || !resource.stream) throw new Error(resource.netError || `HTTP ${resource.httpStatusCode ?? 'unknown'}`);

  const contentType = headerValue(resource.headers, 'content-type') || 'unknown';
  const rawLength = headerValue(resource.headers, 'content-length');
  const contentLength = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined;
  console.log(`CONTENT_TYPE=${contentType}`);
  console.log(`CONTENT_LENGTH=${contentLength ?? 'unknown'}`);
  if (contentLength && contentLength > MAX_PROXY_BYTES) {
    try { await cdp.send('IO.close', { handle: resource.stream }, 3000); } catch {}
    throw new Error(`Lowest rendition is ${contentLength} bytes (>2 GiB guard).`);
  }

  await fsp.mkdir(path.dirname(OUTPUT), { recursive: true });
  const tmp = `${OUTPUT}.part`;
  await fsp.rm(tmp, { force: true }).catch(() => {});
  const out = fs.createWriteStream(tmp, { flags: 'wx' });
  let total = 0;
  try {
    while (true) {
      const chunk = await cdp.send('IO.read', { handle: resource.stream, size: 1024 * 1024 }, 30000);
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
    try { await cdp.send('IO.close', { handle: resource.stream }, 3000); } catch {}
    await fsp.rename(tmp, OUTPUT);
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true }).catch(() => {});
    try { await cdp.send('IO.close', { handle: resource.stream }, 3000); } catch {}
    throw err;
  }

  console.log(`DOWNLOADED_BYTES=${total}`);
  console.log(`PROXY_FILE=${OUTPUT}`);
  console.log('RESULT=GREEN');
  console.log('NEXT=Open this proxy in LosslessCut.');
}

async function main() {
  console.log(`TARGET=${TARGET}`);
  console.log(`PROFILE_DIR=${PROFILE_DIR}`);
  console.log(`OUTPUT=${OUTPUT}`);
  console.log('MODE=one-process same-Chrome human-clear then proxy download');
  console.log('SECRET_LOGGING=disabled');

  if (typeof WebSocket !== 'function') {
    fail('NODE_WEBSOCKET_MISSING', `Node ${process.version} does not expose global WebSocket.`);
    return;
  }

  let child = null;
  let live = await discoverLiveCdp();
  if (!live) {
    await fsp.mkdir(PROFILE_DIR, { recursive: true });
    await fsp.rm(ACTIVE_PORT_FILE, { force: true }).catch(() => {});
    const browser = findBrowser();
    if (!browser) { fail('BROWSER_NOT_FOUND', 'Chrome/Edge executable not found.'); return; }
    child = spawn(browser, [
      `--user-data-dir=${PROFILE_DIR}`,
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      '--new-window',
      'about:blank',
    ], { stdio: 'ignore', windowsHide: false });
    child.once('exit', (code) => console.log(`BROWSER_PROCESS_EXIT=${code}`));
    try { live = await waitForCdp(child); }
    catch (err) { fail('BROWSER_START_FAILED', err instanceof Error ? err.message : String(err)); return; }
    console.log('BROWSER_SESSION=started');
  } else {
    console.log('BROWSER_SESSION=existing');
  }
  console.log(`CDP_DISCOVERED=${live.http}`);

  let target;
  try { target = await getOrCreateTarget(live.http); }
  catch (err) { fail('TARGET_CREATE_FAILED', err instanceof Error ? err.message : String(err)); return; }

  let pageConn;
  try { pageConn = await connectPage(target.webSocketDebuggerUrl); }
  catch (err) { fail('PAGE_ATTACH_FAILED', err instanceof Error ? err.message : String(err)); return; }
  const { ws, cdp } = pageConn;

  try {
    const initial = await inspectPage(cdp);
    if (!String(initial.href || '').includes(TARGET_FRAGMENT)) {
      const nav = await cdp.send('Page.navigate', { url: TARGET });
      if (nav.errorText) throw new Error(nav.errorText);
      console.log('NAVIGATE=qDAVn');
    }

    const deadline = Date.now() + HUMAN_WINDOW_MS;
    let lastState = '';
    let announcedHuman = false;
    while (Date.now() < deadline) {
      if (child && child.exitCode != null) throw new Error(`Chrome exited while waiting for the page (exit=${child.exitCode}).`);
      const page = await inspectPage(cdp);
      const title = String(page.title || '');
      const href = String(page.href || '');
      const sources = Array.isArray(page.sources) ? page.sources : [];
      const state = `${safeUrl(href)}|${title}|${sources.length}`;
      if (state !== lastState) {
        console.log(`PAGE=${safeUrl(href)}`);
        console.log(`PAGE_TITLE=${title.slice(0, 120)}`);
        console.log(`PAGE_READY_STATE=${page.readyState || 'unknown'}`);
        console.log(`RENDITION_COUNT=${sources.length}`);
        lastState = state;
      }

      if (href.includes(TARGET_FRAGMENT) && sources.length > 0 && !/just a moment|attention required|cloudflare/i.test(title)) {
        await downloadLowest(cdp, sources);
        if (child) child.unref();
        return;
      }

      if (!announcedHuman && (/just a moment|attention required|cloudflare/i.test(title) || href.includes(TARGET_FRAGMENT))) {
        console.log('RESULT=WAITING_FOR_HUMAN');
        console.log('ACTION=Use the visible Chrome. If Cloudflare is shown, complete it manually. DO NOT close Chrome; this same command will continue automatically afterward.');
        announcedHuman = true;
      }

      await sleep(1000);
    }

    fail('HUMAN_WINDOW_EXPIRED', 'The fixed qDAVn content page did not become ready within the single human-assisted window. Do not run auth or reset the profile.');
  } catch (err) {
    fail('LIVE_SESSION_DOWNLOAD_FAILED', err instanceof Error ? err.message : String(err));
  } finally {
    try { ws.close(); } catch {}
    if (child && process.exitCode) child.unref();
  }
}

await main();
