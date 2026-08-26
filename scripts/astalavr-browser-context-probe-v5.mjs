#!/usr/bin/env node

// Browser Lead standalone AstalaVR v5 probe.
// Uses the existing dedicated Chrome profile and REAL Chrome network stack via CDP.
// No auth flow, no project build, no cookie values in logs, no full media download.
// Media probe is exactly Range: bytes=0-0 and body is consumed only for strict 206 bytes 0-0/N.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TARGET = process.argv[2] || 'https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao';
const PROFILE_DIR = process.env.JAVR_PROFILES_DIR
  ? path.join(process.env.JAVR_PROFILES_DIR, 'astalavr')
  : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.javr-sourcecut'), 'javr-sourcecut', 'profiles', 'astalavr');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function red(code, detail) {
  console.error('RESULT=RED');
  console.error(`FAILURE=${code}`);
  if (detail) console.error(String(detail));
  process.exitCode = 1;
}
function safeUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}
function findBrowser() {
  if (process.env.JAVR_BROWSER_PATH && fs.existsSync(process.env.JAVR_BROWSER_PATH)) {
    return process.env.JAVR_BROWSER_PATH;
  }
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
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else pending.resolve(msg.result || {});
        return;
      }
      if (msg.method) {
        const key = `${msg.sessionId || ''}:${msg.method}`;
        const handlers = this.listeners.get(key) || [];
        for (const handler of [...handlers]) handler(msg.params || {});
      }
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 10000) {
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
  once(method, sessionId, timeoutMs = 15000, predicate = () => true) {
    const key = `${sessionId || ''}:${method}`;
    return new Promise((resolve, reject) => {
      const handler = (params) => {
        if (!predicate(params)) return;
        cleanup();
        resolve(params);
      };
      const cleanup = () => {
        clearTimeout(timer);
        const arr = this.listeners.get(key) || [];
        this.listeners.set(key, arr.filter((h) => h !== handler));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${method} event timed out`));
      }, timeoutMs);
      const arr = this.listeners.get(key) || [];
      arr.push(handler);
      this.listeners.set(key, arr);
    });
  }
}

async function main() {
  console.log(`TARGET=${TARGET}`);
  console.log('SECRET_LOGGING=disabled');
  console.log('MODE=real-Chrome existing-profile page navigation + in-page bytes=0-0 media fetch');
  console.log('PROBE_VERSION=v5-browser-context');
  console.log(`PROFILE_DIR=${PROFILE_DIR}`);

  if (!fs.existsSync(PROFILE_DIR)) {
    red('PROFILE_MISSING', 'Dedicated AstalaVR profile directory does not exist. Do not rerun auth automatically.');
    return;
  }
  if (typeof WebSocket !== 'function') {
    red('NODE_WEBSOCKET_MISSING', `Node ${process.version} does not expose global WebSocket.`);
    return;
  }
  const browserPath = findBrowser();
  if (!browserPath) {
    red('BROWSER_NOT_FOUND', 'Chrome/Edge executable not found.');
    return;
  }

  const activePortFile = path.join(PROFILE_DIR, 'DevToolsActivePort');
  await fsp.rm(activePortFile, { force: true }).catch(() => {});

  // Deliberately use a normal headed Chrome process (off-screen on Windows) rather than headless.
  // This keeps the browser network stack close to the profile that received cf_clearance.
  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    'about:blank',
  ];
  if (process.platform === 'win32') {
    args.unshift('--window-position=-32000,-32000', '--window-size=800,600');
  }
  const proc = spawn(browserPath, args, { stdio: 'ignore', windowsHide: false });
  let exited = false;
  let exitCode = null;
  proc.once('exit', (code) => { exited = true; exitCode = code; });

  let ws;
  let cdp;
  try {
    let port = 0;
    let wsPath = '';
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const text = await fsp.readFile(activePortFile, 'utf8');
        const lines = text.trim().split(/\r?\n/);
        if (lines.length >= 2) {
          port = Number(lines[0]);
          wsPath = lines[1];
          if (port > 0 && wsPath) break;
        }
      } catch {}
      if (exited) {
        red('PROFILE_BROWSER_EXITED', `Chrome exited before CDP was available (exit=${exitCode}). Do not rerun auth.`);
        return;
      }
      await sleep(100);
    }
    if (!port || !wsPath) {
      red('CDP_START_TIMEOUT', 'Timed out starting Chrome with the existing profile. Do not rerun auth.');
      return;
    }

    ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket open timed out')), 5000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP WebSocket connection failed')); };
    });
    cdp = new Cdp(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.sessionId;
    await Promise.all([
      cdp.send('Page.enable', {}, sessionId),
      cdp.send('Network.enable', {}, sessionId),
      cdp.send('Runtime.enable', {}, sessionId),
    ]);

    const documentResponse = cdp.once(
      'Network.responseReceived',
      sessionId,
      20000,
      (params) => params.type === 'Document' && safeUrl(params.response?.url || '') === safeUrl(TARGET)
    );
    const loaded = cdp.once('Page.loadEventFired', sessionId, 25000);
    const nav = await cdp.send('Page.navigate', { url: TARGET }, sessionId, 15000);
    if (nav.errorText) {
      red('PAGE_NAVIGATION_ERROR', nav.errorText);
      return;
    }

    let doc;
    try { doc = await documentResponse; }
    catch (err) {
      red('PAGE_RESPONSE_TIMEOUT', err instanceof Error ? err.message : String(err));
      return;
    }
    const pageStatus = Number(doc.response?.status || 0);
    console.log(`PAGE_STATUS=${pageStatus}`);
    console.log(`PAGE_MIME=${doc.response?.mimeType || 'unknown'}`);
    console.log(`PAGE_PROTOCOL=${doc.response?.protocol || 'unknown'}`);
    if (pageStatus !== 200) {
      red('BROWSER_PAGE_NOT_200', 'Real Chrome using the existing profile did not obtain HTTP 200. No login attempt will be made automatically.');
      return;
    }

    try { await loaded; } catch {}
    await sleep(1200);

    const inspectExpr = `(() => {
      const sources = [...document.querySelectorAll('source')].map((s) => ({
        src: s.src || s.getAttribute('src') || '',
        quality: s.getAttribute('quality') || s.getAttribute('label') || s.getAttribute('res') || ''
      })).filter(x => /^https?:\\/\\//i.test(x.src) && /\\.mp4(?:\\?|$)/i.test(x.src));
      return { title: document.title, href: location.href, sources };
    })()`;
    const inspected = await cdp.send('Runtime.evaluate', { expression: inspectExpr, returnByValue: true }, sessionId);
    const value = inspected.result?.value || {};
    console.log(`PAGE_TITLE=${String(value.title || '').slice(0, 120)}`);
    console.log(`PAGE_FINAL=${safeUrl(value.href || TARGET)}`);
    const sources = Array.isArray(value.sources) ? value.sources : [];
    console.log(`RENDITION_COUNT=${sources.length}`);
    if (!sources.length) {
      const title = String(value.title || '').toLowerCase();
      const code = title.includes('just a moment') || title.includes('attention required') ? 'BROWSER_CHALLENGE_PAGE' : 'NO_RENDITIONS';
      red(code, 'Real Chrome returned HTTP 200 but no Direct MP4 <source> was present. Do not rerun login automatically.');
      return;
    }

    function score(source) {
      const text = `${source.quality || ''} ${safeUrl(source.src)}`.toLowerCase();
      const p = text.match(/(\\d{3,4})p?/);
      if (p) return Number(p[1]);
      const k = text.match(/([24568])k/);
      if (k) return ({ 2: 1080, 4: 2160, 5: 2560, 6: 2880, 8: 4320 })[Number(k[1])] || 99999;
      return 99999;
    }
    sources.sort((a, b) => score(a) - score(b));
    const selected = sources[0];
    console.log(`LOWEST_RENDITION=${selected.quality || 'unknown'}`);
    console.log(`MEDIA_TARGET=${safeUrl(selected.src)}`);

    // Fetch inside the already authenticated AstalaVR page. Range is CORS-safelisted for a single byte range.
    // Do not read any body unless status/content-range prove exact one-byte partial content.
    const mediaExpr = `(async () => {
      const url = ${JSON.stringify(selected.src)};
      try {
        const r = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: { Range: 'bytes=0-0' }
        });
        const cr = r.headers.get('content-range') || '';
        const cl = r.headers.get('content-length') || '';
        const ok = r.status === 206 && /^bytes\\s+0-0\\/(\\d+)$/i.test(cr);
        if (!ok) {
          try { await r.body?.cancel?.(); } catch {}
          return { status: r.status, cr, cl, bytes: null };
        }
        const bytes = (await r.arrayBuffer()).byteLength;
        return { status: r.status, cr, cl, bytes };
      } catch (e) {
        return { error: String(e && e.message ? e.message : e) };
      }
    })()`;
    const mediaEval = await cdp.send('Runtime.evaluate', { expression: mediaExpr, awaitPromise: true, returnByValue: true }, sessionId, 20000);
    const media = mediaEval.result?.value || {};
    if (media.error) {
      red('BROWSER_MEDIA_FETCH_ERROR', media.error);
      return;
    }
    console.log(`MEDIA_STATUS=${media.status}`);
    console.log(`MEDIA_CONTENT_RANGE=${media.cr || 'missing'}`);
    console.log(`MEDIA_CONTENT_LENGTH=${media.cl || 'missing'}`);
    console.log(`MEDIA_BODY_BYTES=${media.bytes == null ? 'not-consumed' : media.bytes}`);
    if (media.status !== 206) {
      red('BROWSER_MEDIA_NOT_206', 'Real Chrome page context did not receive strict HTTP 206 for bytes=0-0.');
      return;
    }
    if (!/^bytes\s+0-0\/(\d+)$/i.test(media.cr || '')) {
      red('BROWSER_BAD_CONTENT_RANGE', media.cr || 'missing Content-Range');
      return;
    }
    if (media.bytes !== 1) {
      red('BROWSER_BAD_RANGE_BODY', `Expected exactly 1 byte; received ${media.bytes}.`);
      return;
    }

    console.log('RESULT=GREEN');
    console.log('NEXT=Real Chrome profile context proves page access and strict media Range; production should use a browser-backed session transport seam, not Cookie replay/impersonation.');
  } catch (err) {
    red('PROBE_EXCEPTION', err instanceof Error ? err.message : String(err));
  } finally {
    if (cdp) {
      try { await cdp.send('Browser.close', {}, undefined, 2000); } catch {}
    }
    try { ws?.close(); } catch {}
    const deadline = Date.now() + 1800;
    while (!exited && Date.now() < deadline) await sleep(50);
    if (!exited) {
      try { proc.kill(); } catch {}
    }
  }
}

await main();
