#!/usr/bin/env node

// Browser Lead AstalaVR v6 probe.
// Purpose: classify whether a real Chrome profile can naturally settle a Cloudflare challenge.
// No auth flow, no automated challenge solving, no project build, no cookie values in logs,
// and no media body consumption unless the response is strict bytes=0-0 HTTP 206.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TARGET = process.argv[2] || 'https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao';
const PROFILE_DIR = process.env.JAVR_PROFILES_DIR
  ? path.join(process.env.JAVR_PROFILES_DIR, 'astalavr')
  : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.javr-sourcecut'), 'javr-sourcecut', 'profiles', 'astalavr');
const SETTLE_MS = 25000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function red(code, detail) {
  console.error('RESULT=RED');
  console.error(`FAILURE=${code}`);
  if (detail) console.error(String(detail));
  process.exitCode = 1;
}
function safeUrl(raw) {
  try { const u = new URL(raw); return `${u.origin}${u.pathname}`; }
  catch { return '<invalid-url>'; }
}
function headerValue(headers, wanted) {
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === wanted.toLowerCase());
  return key ? String(headers[key]) : '';
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
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result || {});
        return;
      }
      if (!msg.method) return;
      const key = `${msg.sessionId || ''}:${msg.method}`;
      for (const handler of [...(this.listeners.get(key) || [])]) {
        try { handler(msg.params || {}); } catch {}
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
  on(method, sessionId, handler) {
    const key = `${sessionId || ''}:${method}`;
    const arr = this.listeners.get(key) || [];
    arr.push(handler);
    this.listeners.set(key, arr);
    return () => this.listeners.set(key, (this.listeners.get(key) || []).filter((h) => h !== handler));
  }
}

async function main() {
  console.log(`TARGET=${TARGET}`);
  console.log('SECRET_LOGGING=disabled');
  console.log('MODE=real-Chrome challenge-settle + optional bytes=0-0 media probe');
  console.log('PROBE_VERSION=v6-challenge-settle');
  console.log(`SETTLE_MS=${SETTLE_MS}`);
  console.log(`PROFILE_DIR=${PROFILE_DIR}`);

  if (!fs.existsSync(PROFILE_DIR)) { red('PROFILE_MISSING', 'Dedicated AstalaVR profile is missing. Do not rerun auth automatically.'); return; }
  if (typeof WebSocket !== 'function') { red('NODE_WEBSOCKET_MISSING', `Node ${process.version} does not expose global WebSocket.`); return; }
  const browserPath = findBrowser();
  if (!browserPath) { red('BROWSER_NOT_FOUND', 'Chrome/Edge executable not found.'); return; }

  const activePortFile = path.join(PROFILE_DIR, 'DevToolsActivePort');
  await fsp.rm(activePortFile, { force: true }).catch(() => {});

  // Headed browser. We do not click or solve anything; the page gets one chance to settle naturally.
  const proc = spawn(browserPath, [
    `--user-data-dir=${PROFILE_DIR}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: false });
  let exited = false;
  let exitCode = null;
  proc.once('exit', (code) => { exited = true; exitCode = code; });

  let ws;
  let cdp;
  try {
    let port = 0;
    let wsPath = '';
    const startDeadline = Date.now() + 10000;
    while (Date.now() < startDeadline) {
      try {
        const text = await fsp.readFile(activePortFile, 'utf8');
        const lines = text.trim().split(/\r?\n/);
        if (lines.length >= 2) {
          port = Number(lines[0]);
          wsPath = lines[1];
          if (port > 0 && wsPath) break;
        }
      } catch {}
      if (exited) { red('PROFILE_BROWSER_EXITED', `Chrome exited before CDP was available (exit=${exitCode}).`); return; }
      await sleep(100);
    }
    if (!port || !wsPath) { red('CDP_START_TIMEOUT', 'Timed out starting Chrome with the existing profile.'); return; }

    ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket open timed out')), 5000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP WebSocket connection failed')); };
    });
    cdp = new Cdp(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await Promise.all([
      cdp.send('Page.enable', {}, sessionId),
      cdp.send('Network.enable', {}, sessionId),
      cdp.send('Runtime.enable', {}, sessionId),
    ]);

    const docStatuses = [];
    let challengeHeaderSeen = false;
    let lastDocStatus = 0;
    const off = cdp.on('Network.responseReceived', sessionId, (params) => {
      if (params.type !== 'Document') return;
      const url = params.response?.url || '';
      if (!url.startsWith('https://astalavr.com/') && !url.startsWith('https://www.astalavr.com/')) return;
      const status = Number(params.response?.status || 0);
      lastDocStatus = status;
      docStatuses.push(status);
      const mitigated = headerValue(params.response?.headers || {}, 'cf-mitigated');
      if (mitigated.toLowerCase() === 'challenge') challengeHeaderSeen = true;
    });

    const nav = await cdp.send('Page.navigate', { url: TARGET }, sessionId, 15000);
    if (nav.errorText) { off(); red('PAGE_NAVIGATION_ERROR', nav.errorText); return; }

    let settled = null;
    const settleDeadline = Date.now() + SETTLE_MS;
    while (Date.now() < settleDeadline) {
      await sleep(800);
      let evalResult;
      try {
        evalResult = await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const title = document.title || '';
            const text = (document.body?.innerText || '').slice(0, 8000).toLowerCase();
            const href = location.href;
            const sources = [...document.querySelectorAll('source')]
              .map((s) => ({ src: s.src || s.getAttribute('src') || '', quality: s.getAttribute('quality') || s.getAttribute('label') || s.getAttribute('res') || '' }))
              .filter((x) => /^https?:\\/\\//i.test(x.src) && /\\.mp4(?:\\?|$)/i.test(x.src));
            const challengeIframe = !!document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="challenge-platform"]');
            const challengeText = /just a moment|verify you are human|performing security verification|attention required|checking your browser/.test((title + ' ' + text).toLowerCase());
            const interactiveText = /verify you are human|confirm you are human|checkbox/.test(text);
            return { title, href, sources, challengeIframe, challengeText, interactiveText };
          })()`,
          returnByValue: true,
        }, sessionId, 5000);
      } catch {
        continue; // navigation may temporarily replace the execution context
      }
      const value = evalResult.result?.value || {};
      if (Array.isArray(value.sources) && value.sources.length > 0) {
        settled = { kind: 'content', ...value };
        break;
      }
      settled = { kind: 'pending', ...value };
    }
    off();

    console.log(`DOC_STATUS_SEQUENCE=${docStatuses.length ? docStatuses.join('>') : 'none'}`);
    console.log(`CF_MITIGATED_CHALLENGE=${challengeHeaderSeen ? 'yes' : 'no'}`);
    console.log(`FINAL_DOC_STATUS=${lastDocStatus || 'unknown'}`);
    console.log(`FINAL_PAGE=${safeUrl(settled?.href || TARGET)}`);
    console.log(`FINAL_TITLE=${String(settled?.title || '').slice(0, 120)}`);

    const sources = Array.isArray(settled?.sources) ? settled.sources : [];
    console.log(`RENDITION_COUNT=${sources.length}`);
    if (!sources.length) {
      const interactive = Boolean(settled?.interactiveText || settled?.challengeIframe);
      const challenge = Boolean(settled?.challengeText || settled?.challengeIframe || challengeHeaderSeen || lastDocStatus === 403);
      console.log(`CHALLENGE_DETECTED=${challenge ? 'yes' : 'no'}`);
      console.log(`INTERACTIVE_CHALLENGE_HINT=${interactive ? 'yes' : 'no'}`);
      if (challenge) {
        red(
          interactive ? 'INTERACTIVE_CHALLENGE_PRESENT' : 'CHALLENGE_NOT_AUTOSOLVED',
          'Real Chrome did not reach the AstalaVR content page during the single settle window. Stop automation here; do not retry login or challenge automatically.'
        );
      } else {
        red('NO_RENDITIONS_AFTER_SETTLE', 'The page settled without a detectable Cloudflare challenge but exposed no Direct MP4 source.');
      }
      return;
    }

    function score(source) {
      const text = `${source.quality || ''} ${safeUrl(source.src)}`.toLowerCase();
      const p = text.match(/(\d{3,4})p?/);
      if (p) return Number(p[1]);
      const k = text.match(/([24568])k/);
      if (k) return ({ 2: 1080, 4: 2160, 5: 2560, 6: 2880, 8: 4320 })[Number(k[1])] || 99999;
      return 99999;
    }
    sources.sort((a, b) => score(a) - score(b));
    const selected = sources[0];
    console.log(`LOWEST_RENDITION=${selected.quality || 'unknown'}`);
    console.log(`MEDIA_TARGET=${safeUrl(selected.src)}`);

    const mediaExpr = `(async () => {
      try {
        const r = await fetch(${JSON.stringify(selected.src)}, {
          method: 'GET', credentials: 'include', cache: 'no-store', headers: { Range: 'bytes=0-0' }
        });
        const cr = r.headers.get('content-range') || '';
        const cl = r.headers.get('content-length') || '';
        const mitigated = r.headers.get('cf-mitigated') || '';
        const ok = r.status === 206 && /^bytes\\s+0-0\\/(\\d+)$/i.test(cr);
        if (!ok) { try { await r.body?.cancel?.(); } catch {} return { status: r.status, cr, cl, mitigated, bytes: null }; }
        const bytes = (await r.arrayBuffer()).byteLength;
        return { status: r.status, cr, cl, mitigated, bytes };
      } catch (e) { return { error: String(e?.message || e) }; }
    })()`;
    const mediaEval = await cdp.send('Runtime.evaluate', { expression: mediaExpr, awaitPromise: true, returnByValue: true }, sessionId, 20000);
    const media = mediaEval.result?.value || {};
    if (media.error) { red('BROWSER_MEDIA_FETCH_ERROR', media.error); return; }
    console.log(`MEDIA_STATUS=${media.status}`);
    console.log(`MEDIA_CF_MITIGATED=${media.mitigated || 'none'}`);
    console.log(`MEDIA_CONTENT_RANGE=${media.cr || 'missing'}`);
    console.log(`MEDIA_CONTENT_LENGTH=${media.cl || 'missing'}`);
    console.log(`MEDIA_BODY_BYTES=${media.bytes == null ? 'not-consumed' : media.bytes}`);
    if (media.status !== 206) { red('BROWSER_MEDIA_NOT_206', 'Real Chrome page context did not receive strict HTTP 206 for bytes=0-0.'); return; }
    if (!/^bytes\s+0-0\/(\d+)$/i.test(media.cr || '')) { red('BROWSER_BAD_CONTENT_RANGE', media.cr || 'missing Content-Range'); return; }
    if (media.bytes !== 1) { red('BROWSER_BAD_RANGE_BODY', `Expected exactly 1 byte; received ${media.bytes}.`); return; }

    console.log('RESULT=GREEN');
    console.log('NEXT=Real Chrome naturally settled the page and strict media Range works; browser-backed session transport is viable without Cookie replay.');
  } catch (err) {
    red('PROBE_EXCEPTION', err instanceof Error ? err.message : String(err));
  } finally {
    if (cdp) { try { await cdp.send('Browser.close', {}, undefined, 1500); } catch {} }
    try { ws?.close(); } catch {}
    const deadline = Date.now() + 1800;
    while (!exited && Date.now() < deadline) await sleep(50);
    if (!exited) { try { proc.kill(); } catch {} }
  }
}

await main();
