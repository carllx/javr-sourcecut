#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_TARGET = "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao";
const targetUrl = process.argv[2] || DEFAULT_TARGET;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function fail(code, message) {
  console.error("RESULT=RED");
  console.error(`FAILURE=${code}`);
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: repoRoot,
    ...options,
  });
  if (result.error) fail("PROCESS_ERROR", `${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail("PROCESS_EXIT", `${command} exited with status ${result.status}`);
}

function runNpm(args) {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
    const quoted = args
      .map((arg) => (/\s|[&|<>^]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg))
      .join(" ");
    run(comspec, ["/d", "/s", "/c", `npm ${quoted}`]);
  } else {
    run("npm", args);
  }
}

function cookieNames(cookieHeader) {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(";")
    .map((part) => part.trim().split("=", 1)[0])
    .filter(Boolean)
    .sort();
}

function safeMediaLabel(urlString) {
  const url = new URL(urlString);
  return `${url.origin}${url.pathname}`;
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {}
}

console.log(`TARGET=${targetUrl}`);
console.log("SECRET_LOGGING=disabled");
console.log("MODE=page-fetch + bytes=0-0 media probe only");
console.log("PROBE_VERSION=v2-windows-safe");

// Build without invoking npm.cmd directly. This avoids Windows spawnSync EINVAL.
const tscEntry = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
if (!fs.existsSync(tscEntry)) {
  fail("TSC_MISSING", `TypeScript compiler not found at ${tscEntry}. Run npm install in the repo first.`);
}
console.log("BUILD=starting");
run(process.execPath, [tscEntry]);
console.log("BUILD=ok");

const distSession = path.join(repoRoot, "dist", "core", "session.js");
const distAstala = path.join(repoRoot, "dist", "adapters", "astalavr", "index.js");
if (!fs.existsSync(distSession) || !fs.existsSync(distAstala)) {
  fail("BUILD_OUTPUT_MISSING", "Expected dist session/AstalaVR modules were not produced.");
}

// Temporary dependency install stays outside the repository.
const probeDeps = path.join(os.tmpdir(), "javr-sourcecut-impit-probe");
fs.mkdirSync(probeDeps, { recursive: true });
const probePackage = path.join(probeDeps, "package.json");
if (!fs.existsSync(probePackage)) {
  fs.writeFileSync(
    probePackage,
    JSON.stringify({ name: "javr-sourcecut-impit-probe", private: true, type: "module" }, null, 2)
  );
}

const probeRequire = createRequire(probePackage);
let impitEntry;
try {
  impitEntry = probeRequire.resolve("impit");
} catch {
  console.log("IMPIT_INSTALL=starting (temporary, outside repository)");
  runNpm(["install", "--prefix", probeDeps, "--no-save", "impit@0.14.3"]);
  try {
    impitEntry = probeRequire.resolve("impit");
  } catch (err) {
    fail("IMPIT_RESOLVE_FAILED", err instanceof Error ? err.message : String(err));
  }
}
console.log("IMPIT_INSTALL=ok");

const [{ BrowserProfileSessionProvider }, { parseAstalaVrHtml }, impitModule] = await Promise.all([
  import(pathToFileURL(distSession).href),
  import(pathToFileURL(distAstala).href),
  import(pathToFileURL(impitEntry).href),
]);

const { Impit } = impitModule;
if (typeof Impit !== "function") fail("IMPIT_API_MISMATCH", "Impit constructor was not exported as expected.");

let session;
try {
  session = await BrowserProfileSessionProvider.fromDedicatedProfile("astalavr");
} catch (err) {
  fail("PROFILE_READ_FAILED", err instanceof Error ? err.message : String(err));
}
if (!session) {
  fail("PROFILE_SESSION_MISSING", "No usable cookies were extracted from the existing AstalaVR profile. No login attempt was made.");
}

const pageCookieHeader = session.getCookieHeaderForUrl(targetUrl);
console.log("PROFILE_SESSION=present");
console.log(`PAGE_COOKIE_NAMES=${cookieNames(pageCookieHeader).join(",") || "none"}`);

const client = new Impit({ browser: "chrome" });
const pageHeaders = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://astalavr.com/",
};
if (pageCookieHeader) pageHeaders.Cookie = pageCookieHeader;

let pageResponse;
try {
  pageResponse = await client.fetch(targetUrl, { method: "GET", redirect: "follow", headers: pageHeaders });
} catch (err) {
  fail("PAGE_TRANSPORT_ERROR", err instanceof Error ? err.message : String(err));
}

console.log(`PAGE_STATUS=${pageResponse.status}`);
console.log(`PAGE_CONTENT_TYPE=${pageResponse.headers.get("content-type") || "unknown"}`);
if (pageResponse.status !== 200) {
  await cancelBody(pageResponse);
  fail("PAGE_NOT_200", "Browser-impersonated transport did not obtain the live page. Do not retry login automatically.");
}

let html;
try {
  html = await pageResponse.text();
} catch (err) {
  fail("PAGE_BODY_ERROR", err instanceof Error ? err.message : String(err));
}

let descriptor;
try {
  descriptor = parseAstalaVrHtml(html, targetUrl);
} catch (err) {
  fail("LIVE_PARSE_FAILED", err instanceof Error ? err.message : String(err));
}

if (!descriptor.renditions?.length) fail("NO_RENDITIONS", "Live page parsed but exposed no Direct MP4 renditions.");

const selected = [...descriptor.renditions].sort(
  (a, b) => (a.height || Number.MAX_SAFE_INTEGER) - (b.height || Number.MAX_SAFE_INTEGER)
)[0];

console.log(`PROVIDER_ASSET_ID=${descriptor.providerAssetId}`);
console.log(`RENDITION_COUNT=${descriptor.renditions.length}`);
console.log(`LOWEST_RENDITION=${selected.formatId}:${selected.resolution}`);
console.log(`MEDIA_TARGET=${safeMediaLabel(selected.directUrl)}`);

const mediaCookieHeader = session.getCookieHeaderForUrl(selected.directUrl);
console.log(`MEDIA_COOKIE_NAMES=${cookieNames(mediaCookieHeader).join(",") || "none"}`);

const mediaHeaders = {
  Accept: "*/*",
  Range: "bytes=0-0",
  Referer: targetUrl,
  Origin: "https://astalavr.com",
  "Sec-Fetch-Site": "same-site",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "video",
};
if (mediaCookieHeader) mediaHeaders.Cookie = mediaCookieHeader;

let mediaResponse;
try {
  mediaResponse = await client.fetch(selected.directUrl, { method: "GET", redirect: "follow", headers: mediaHeaders });
} catch (err) {
  fail("MEDIA_TRANSPORT_ERROR", err instanceof Error ? err.message : String(err));
}

const contentRange = mediaResponse.headers.get("content-range") || "";
const contentLength = mediaResponse.headers.get("content-length") || "";
console.log(`MEDIA_STATUS=${mediaResponse.status}`);
console.log(`MEDIA_CONTENT_RANGE=${contentRange || "missing"}`);
console.log(`MEDIA_CONTENT_LENGTH=${contentLength || "missing"}`);

if (mediaResponse.status !== 206) {
  await cancelBody(mediaResponse);
  fail("MEDIA_NOT_206", "Server did not honor the one-byte Range request. Probe refused to consume the body.");
}
if (!/^bytes\s+0-0\/(\d+)$/i.test(contentRange)) {
  await cancelBody(mediaResponse);
  fail("BAD_CONTENT_RANGE", `Unexpected Content-Range: ${contentRange || "missing"}`);
}

let bodyLength;
try {
  bodyLength = (await mediaResponse.arrayBuffer()).byteLength;
} catch (err) {
  fail("MEDIA_BODY_ERROR", err instanceof Error ? err.message : String(err));
}
console.log(`MEDIA_BODY_BYTES=${bodyLength}`);
if (bodyLength !== 1) fail("BAD_RANGE_BODY_LENGTH", `Expected 1 byte, received ${bodyLength}.`);

console.log("RESULT=GREEN");
console.log("NEXT=Browser-impersonated fetch is viable for evaluation; CDP bulk streaming is not justified yet.");
