#!/usr/bin/env node

// Persistent AstalaVR human-session launcher.
// Reuses an existing Chrome on the fixed local CDP port when possible.
// Otherwise launches the dedicated AstalaVR profile visibly and leaves Chrome running.
// It never logs in, solves Cloudflare, resets the profile, or closes the browser.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CDP = process.env.JAVR_ASTALA_CDP || 'http://127.0.0.1:9222';
const PORT = Number(new URL(CDP).port || 9222);
const TARGET = process.argv[2] || 'https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao';
const PROFILE_DIR = process.env.JAVR_PROFILES_DIR
  ? path.join(process.env.JAVR_PROFILES_DIR, 'astalavr')
  : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.javr-sourcecut'), 'javr-sourcecut', 'profiles', 'astalavr');

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

async function cdpAlive() {
  try {
    const res = await fetch(`${CDP}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function openTargetOnExistingChrome() {
  try {
    const res = await fetch(`${CDP}/json/new?${encodeURIComponent(TARGET)}`, { method: 'PUT' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch {
    return false;
  }
}

console.log(`TARGET=${TARGET}`);
console.log(`PROFILE_DIR=${PROFILE_DIR}`);
console.log(`CDP=${CDP}`);
console.log('MODE=persistent visible human-assisted browser session');

if (await cdpAlive()) {
  console.log('BROWSER_SESSION=existing');
  const opened = await openTargetOnExistingChrome();
  console.log(`TARGET_OPEN_REQUEST=${opened ? 'ok' : 'failed'}`);
  console.log('ACTION=Use the existing visible Chrome window. Complete Cloudflare if shown. KEEP THIS CHROME OPEN.');
  console.log('RESULT=READY_FOR_HUMAN');
  process.exit(0);
}

if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
const browser = findBrowser();
if (!browser) {
  console.error('RESULT=RED');
  console.error('FAILURE=BROWSER_NOT_FOUND');
  process.exit(1);
}

const args = [
  `--user-data-dir=${PROFILE_DIR}`,
  `--remote-debugging-port=${PORT}`,
  '--remote-debugging-address=127.0.0.1',
  '--no-first-run',
  '--no-default-browser-check',
  '--new-window',
  TARGET,
];

const child = spawn(browser, args, {
  detached: true,
  stdio: 'ignore',
  windowsHide: false,
});
child.unref();

const deadline = Date.now() + 10000;
while (Date.now() < deadline) {
  if (await cdpAlive()) break;
  await new Promise((r) => setTimeout(r, 200));
}

if (!(await cdpAlive())) {
  console.error('RESULT=RED');
  console.error('FAILURE=CDP_START_TIMEOUT');
  console.error('Chrome did not expose the fixed CDP port. Do not reset the profile or rerun login automatically.');
  process.exit(1);
}

console.log('BROWSER_SESSION=started');
console.log('ACTION=In the visible Chrome window, complete Cloudflare if shown. Do not close this Chrome afterward.');
console.log('RESULT=READY_FOR_HUMAN');
