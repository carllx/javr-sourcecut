import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.resolve(rootDir, "dist");
const userscriptsDir = path.resolve(rootDir, "userscripts");

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}
if (!fs.existsSync(userscriptsDir)) {
  fs.mkdirSync(userscriptsDir, { recursive: true });
}

const USERSCRIPT_HEADER = `// ==UserScript==
// @name         Eporner Companion (javr-sourcecut)
// @namespace    https://github.com/carllx/javr-sourcecut
// @version      0.1.0
// @description  4K+ candidate filtering and AV1 format capability detection for Eporner
// @author       carllx
// @match        https://*.eporner.com/*
// @match        http://*.eporner.com/*
// @icon         https://www.eporner.com/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      eporner.com
// @connect      www.eporner.com
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/carllx/javr-sourcecut/main/userscripts/eporner-companion.user.js
// @downloadURL  https://raw.githubusercontent.com/carllx/javr-sourcecut/main/userscripts/eporner-companion.user.js
// ==/UserScript==

`;

async function build() {
  console.log("🔨 Building Eporner Companion Userscript...");

  const outUserJs = path.join(userscriptsDir, "eporner-companion.user.js");
  const outDevUserJs = path.join(distDir, "eporner-companion.dev.user.js");

  // 1. Bundle TypeScript to IIFE
  await esbuild.build({
    entryPoints: [path.join(__dirname, "src", "index.ts")],
    bundle: true,
    format: "iife",
    target: "es2020",
    banner: {
      js: USERSCRIPT_HEADER,
    },
    outfile: outUserJs,
    minify: false,
    sourcemap: false,
  });

  console.log(`✅ Production userscript generated: ${outUserJs}`);

  // 2. Generate local development wrapper userscript
  // Allows testing local changes without reinstalling the script in Tampermonkey
  const normalizedOutPath = outUserJs.replace(/\\/g, "/");
  const DEV_HEADER = `// ==UserScript==
// @name         Eporner Companion [DEV LIVE] (javr-sourcecut)
// @namespace    https://github.com/carllx/javr-sourcecut
// @version      0.1.0-dev
// @description  Live local development wrapper for Eporner Companion
// @match        https://*.eporner.com/*
// @match        http://*.eporner.com/*
// @icon         https://www.eporner.com/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      eporner.com
// @connect      www.eporner.com
// @run-at       document-end
// @require      file:///${normalizedOutPath}
// ==/UserScript==

// This dev wrapper loads the locally built file automatically.
// Make sure "Allow access to file URLs" is enabled in Tampermonkey Extension Settings.
`;

  fs.writeFileSync(outDevUserJs, DEV_HEADER, "utf-8");
  console.log(`✅ Development live userscript generated: ${outDevUserJs}`);
}

build().catch((err) => {
  console.error("❌ Build failed:", err);
  process.exit(1);
});
