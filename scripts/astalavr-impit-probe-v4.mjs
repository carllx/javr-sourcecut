#!/usr/bin/env node

// Browser Lead Windows-safe launcher for the standalone AstalaVR v3 probe.
// Installs impit into the OS temp directory by invoking npm-cli.js through node.exe,
// then imports v3 via a file:// URL. It does not build/typecheck the project and does not launch auth.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const IMPIT_VERSION = '0.14.3';
const root = path.join(os.tmpdir(), 'javr-sourcecut-impit-probe');
fs.mkdirSync(root, { recursive: true });
const pkg = path.join(root, 'package.json');
if (!fs.existsSync(pkg)) {
  fs.writeFileSync(pkg, JSON.stringify({ name: 'javr-sourcecut-impit-probe', private: true, type: 'module' }, null, 2));
}

const req = createRequire(pkg);
let installed = false;
try {
  req.resolve('impit');
  installed = true;
} catch {}

if (!installed) {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js') : null,
  ].filter(Boolean);
  const npmCli = candidates.find((p) => fs.existsSync(p));
  if (!npmCli) {
    console.error('RESULT=RED');
    console.error('FAILURE=NPM_CLI_NOT_FOUND');
    console.error(`NODE_EXEC=${process.execPath}`);
    process.exit(1);
  }

  console.log(`IMPIT_BOOTSTRAP=starting:${IMPIT_VERSION}`);
  console.log(`NPM_CLI=${npmCli}`);
  const result = spawnSync(
    process.execPath,
    [npmCli, 'install', '--prefix', root, '--no-save', `impit@${IMPIT_VERSION}`],
    { stdio: 'inherit', windowsHide: true }
  );
  if (result.error || result.status !== 0) {
    console.error('RESULT=RED');
    console.error('FAILURE=IMPIT_BOOTSTRAP_FAILED');
    console.error(result.error?.message || `npm-cli exited ${result.status}`);
    process.exit(1);
  }
}

console.log('IMPIT_BOOTSTRAP=ok');
const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, 'astalavr-impit-probe-v3.mjs')).href);
