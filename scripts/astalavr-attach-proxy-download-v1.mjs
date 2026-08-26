#!/usr/bin/env node

// Attach-only AstalaVR proxy downloader.
// Preconditions:
// - The dedicated AstalaVR Chrome is ALREADY running with --remote-debugging-port=9222.
// - The human has already cleared Cloudflare in that SAME browser process/session.
// - Keep that browser open while this script runs.
//
// This script does NOT login, solve challenges, replay cookies, or close the browser.
// It attaches to the live page, selects the lowest Direct MP4 rendition,
// and streams it through Chrome's authenticated network context via CDP.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const CDP_HTTP = process.env.JAVR_ASTALA_CDP || 'http://127.0.0.1:9222';
const TARGET_FRAGMENT = '/videos/qDAVn/';
const OUTPUT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve('workspace', 'manual-astalavr', 'qDAVn', 'proxy-lowest.mp4');
const MAX_PROXY_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB guard

function fail(code, detail) {
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

function score(source) {
  const text = `${source.quality || ''} ${safeUrl(source.src)}`.toLowerCase();
  const p = text.match(/(\d{3,4})p?/);
  if (p) return Number(p[1]);
  const k = text.match(/([24568])k/);
  if (k) return ({ 2: 1080, 4: 2160, 5: 2560, 6: 2880, 8: 4320 })[Number(k[1])] || 99999;
  return 99999;
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

function headerValue(headers, name) {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return Array.isArray(v) ? v.join(', ') : String(v);
  }
  return undefined;
}

async function main() {
  console.log(`CDP=${CDP_HTTP}`);
  console.log('MODE=attach-only cleared-browser lowest-proxy download');
  console.log('SECRET_LOGGING=disabled');
  console.log(`OUTPUT=${OUTPUT}`);

  if (typeof WebSocket !== 'function') {
    fail('NODE_WEBSOCKET_MISSING', `Node ${process.version} does not expose global WebSocket.`);
    return;
  }

  let version;
  try {
    const res = await fetch(`${CDP_HTTP}/json/version`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    version = await res.json();
  } catch (err) {
    fail('CDP_NOT_AVAILABLE', `No live Chrome found at ${CDP_HTTP}. Launch the dedicated browser first and keep it open. ${err instanceof Error ? err.message : err}`);
    return;
  }

  const wsUrl = version.webSocketDebuggerUrl;
  if (!wsUrl) {
    fail('CDP_WEBSOCKET_MISSING', 'Chrome did not expose webSocketDebuggerUrl.');
    return;
  }

  const ws = new WebSocket(wsUrl);
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
    const { targetInfos = [] } = await cdp.send('Target.getTargets');
    const candidates = targetInfos.filter((t) => t.type === 'page' && String(t.url || '').includes(TARGET_FRAGMENT));
    if (!candidates.length) {
      fail('TARGET_PAGE_NOT_FOUND', 'The designated AstalaVR page is not open in the live Chrome session. Do not restart auth; navigate the existing window to the target page.');
      return;
    }

    const target = candidates[0];
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await Promise.all([
      cdp.send('Page.enable', {}, sessionId),
      cdp.send('Runtime.enable', {}, sessionId),
      cdp.send('Network.enable', {}, sessionId),
    ]);

    const inspect = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const title = document.title || '';
        const href = location.href || '';
        const sources = [...document.querySelectorAll('source')].map((s) => ({
          src: s.src || s.getAttribute('src') || '',
          quality: s.getAttribute('quality') || s.getAttribute('label') || s.getAttribute('res') || ''
        })).filter((x) => /^https?:\\/\\//i.test(x.src) && /\\.mp4(?:\\?|$)/i.test(x.src));
        return { title, href, sources };
      })()`,
      returnByValue: true,
    }, sessionId);

    const page = inspect.result?.value || {};
    const title = String(page.title || '');
    console.log(`PAGE_TITLE=${title.slice(0, 120)}`);
    console.log(`PAGE=${safeUrl(page.href || target.url)}`);
    if (/just a moment|attention required|cloudflare/i.test(title)) {
      fail('CHALLENGE_STILL_PRESENT', 'The same Chrome session is still on a Cloudflare challenge. Complete it in the visible window and rerun this attach-only script without closing Chrome.');
      return;
    }

    const sources = Array.isArray(page.sources) ? page.sources : [];
    console.log(`RENDITION_COUNT=${sources.length}`);
    if (!sources.length) {
      fail('NO_RENDITIONS', 'AstalaVR content page is open but no Direct MP4 <source> elements were found.');
      return;
    }

    sources.sort((a, b) => score(a) - score(b));
    const selected = sources[0];
    console.log(`LOWEST_RENDITION=${selected.quality || 'unknown'}`);
    console.log(`MEDIA_TARGET=${safeUrl(selected.src)}`);

    const frameTree = await cdp.send('Page.getFrameTree', {}, sessionId);
    const frameId = frameTree.frameTree?.frame?.id;
    if (!frameId) {
      fail('FRAME_ID_MISSING', 'Could not determine main frame id.');
      return;
    }

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
    const contentLengthRaw = headerValue(resource.headers, 'content-length');
    const contentLength = contentLengthRaw && /^\d+$/.test(contentLengthRaw) ? Number(contentLengthRaw) : undefined;
    console.log(`CONTENT_TYPE=${contentType}`);
    console.log(`CONTENT_LENGTH=${contentLength ?? 'unknown'}`);

    if (!/^video\//i.test(contentType) && contentType !== 'application/octet-stream') {
      try { await cdp.send('IO.close', { handle: resource.stream }, sessionId, 3000); } catch {}
      fail('UNEXPECTED_CONTENT_TYPE', contentType);
      return;
    }

    if (contentLength && contentLength > MAX_PROXY_BYTES) {
      try { await cdp.send('IO.close', { handle: resource.stream }, sessionId, 3000); } catch {}
      fail('PROXY_TOO_LARGE', `Lowest rendition reports ${contentLength} bytes (> 2 GiB guard). Refusing accidental large transfer.`);
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
        const data = chunk.data || '';
        if (data) {
          const buf = chunk.base64Encoded ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8');
          total += buf.length;
          if (total > MAX_PROXY_BYTES) throw new Error('Transfer exceeded 2 GiB proxy guard.');
          if (!out.write(buf)) await new Promise((resolve) => out.once('drain', resolve));
          if (total % (64 * 1024 * 1024) < buf.length) console.log(`DOWNLOADED_BYTES=${total}`);
        }
        if (chunk.eof) break;
      }
      await new Promise((resolve, reject) => {
        out.end(resolve);
        out.on('error', reject);
      });
      await cdp.send('IO.close', { handle: resource.stream }, sessionId, 3000).catch(() => {});
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
    console.log('NEXT=Open this proxy in LosslessCut. Keep the same Chrome session open if continuing AstalaVR work immediately.');
  } catch (err) {
    fail('ATTACH_PROXY_EXCEPTION', err instanceof Error ? err.message : String(err));
  } finally {
    try { ws.close(); } catch {}
    // Intentionally do NOT close Chrome. Session continuity is the point of this recovery path.
  }
}

await main();
