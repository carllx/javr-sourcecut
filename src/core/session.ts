import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { spawn, execSync } from "node:child_process";

export interface NetscapeCookie {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  expires: number; // Unix epoch seconds (0 = session cookie)
  name: string;
  value: string;
}

export interface SourceSessionProvider {
  readonly hasSession: boolean;
  getCookieHeaderForUrl(targetUrl: string, nowEpochSeconds?: number): string | undefined;
  createSessionFetch(baseFetch?: typeof fetch): typeof fetch;
}

export interface BrowserExecutableInfo {
  type: "chrome" | "edge";
  executablePath: string;
}

export interface ProfileLockInfo {
  pid: number;
  ownerToken: string;
  acquiredAt: string;
  provider: string;
}

/**
 * Checks if a process with the given PID is currently active.
 */
export function isPidRunning(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM"; // Process exists, insufficient permissions to signal
  }
}

/**
 * Process-scoped atomic lock manager for dedicated browser profiles.
 * Uses atomic exclusive file creation (O_CREAT | O_EXCL via "wx") to prevent TOCTOU races.
 * Ensures strict single-owner access and fails closed if profile is currently in use.
 */
export class ProfileLock {
  readonly profileDir: string;
  readonly lockFilePath: string;
  private handle: fs.FileHandle | null = null;
  private ownerToken: string | null = null;

  constructor(profileDir: string) {
    this.profileDir = profileDir;
    this.lockFilePath = path.join(profileDir, ".javr-profile.lock");
  }

  async acquire(maxStaleRetries = 3): Promise<void> {
    await fs.mkdir(this.profileDir, { recursive: true });

    for (let attempt = 0; attempt < maxStaleRetries; attempt++) {
      try {
        // 1. Atomic exclusive file creation
        this.handle = await fs.open(this.lockFilePath, "wx");
        const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        this.ownerToken = token;

        const lockData: ProfileLockInfo = {
          pid: process.pid,
          ownerToken: token,
          acquiredAt: new Date().toISOString(),
          provider: path.basename(this.profileDir),
        };

        await this.handle.writeFile(JSON.stringify(lockData, null, 2), "utf-8");
        return; // Atomically acquired
      } catch (err: any) {
        if (err.code === "EEXIST") {
          // Lock exists: inspect owner PID
          let existingInfo: ProfileLockInfo | null = null;
          try {
            const content = await fs.readFile(this.lockFilePath, "utf-8");
            existingInfo = JSON.parse(content);
          } catch {
            // Unparseable or transient read
          }

          if (existingInfo?.pid && isPidRunning(existingInfo.pid)) {
            throw new Error(
              `Dedicated browser profile at "${this.profileDir}" is currently in use by process PID ${existingInfo.pid} (acquired at ${existingInfo.acquiredAt}). Please close the running browser or wait for process completion.`
            );
          }

          // Existing lock is stale (owner PID dead): remove and retry atomic exclusive create
          try {
            await fs.rm(this.lockFilePath, { force: true });
          } catch {}
          continue;
        }

        throw new Error(
          `Failed to acquire lock for dedicated browser profile at "${this.profileDir}": ${err.message}`
        );
      }
    }

    throw new Error(
      `Failed to acquire lock for dedicated browser profile at "${this.profileDir}" after ${maxStaleRetries} attempts.`
    );
  }

  async release(): Promise<void> {
    if (this.handle) {
      try {
        await this.handle.close();
      } catch {}
      this.handle = null;
    }

    if (!this.ownerToken) {
      return;
    }

    try {
      const content = await fs.readFile(this.lockFilePath, "utf-8");
      const info: ProfileLockInfo = JSON.parse(content);
      // Release safety: only remove if it still belongs to this exact process and ownerToken
      if (info.ownerToken === this.ownerToken && info.pid === process.pid) {
        await fs.rm(this.lockFilePath, { force: true });
      }
    } catch {
      // If file was already removed or modified, safely ignore
    } finally {
      this.ownerToken = null;
    }
  }
}

/**
 * Discovers installed Google Chrome or Microsoft Edge browser executable paths on the system.
 * Chrome is prioritized first, with Edge as fallback.
 */
export function findBrowserExecutable(): BrowserExecutableInfo {
  if (process.env.JAVR_BROWSER_PATH) {
    const p = process.env.JAVR_BROWSER_PATH;
    if (fsSync.existsSync(p)) {
      return {
        type:
          p.toLowerCase().includes("edge") || p.toLowerCase().includes("msedge")
            ? "edge"
            : "chrome",
        executablePath: p,
      };
    }
  }

  const isWindows = process.platform === "win32";
  const candidatePaths: { type: "chrome" | "edge"; path: string }[] = isWindows
    ? [
        // Chrome
        { type: "chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
        { type: "chrome", path: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" },
        {
          type: "chrome",
          path: path.join(
            process.env.LOCALAPPDATA || "",
            "Google\\Chrome\\Application\\chrome.exe"
          ),
        },
        // Edge
        { type: "edge", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" },
        { type: "edge", path: "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" },
      ]
    : [
        // macOS / Linux
        { type: "chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
        { type: "chrome", path: "/usr/bin/google-chrome" },
        { type: "chrome", path: "/usr/bin/chromium" },
        { type: "chrome", path: "/usr/bin/chromium-browser" },
        { type: "edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
        { type: "edge", path: "/usr/bin/microsoft-edge" },
      ];

  for (const candidate of candidatePaths) {
    if (candidate.path && fsSync.existsSync(candidate.path)) {
      return { type: candidate.type, executablePath: candidate.path };
    }
  }

  throw new Error("No supported Chrome or Edge browser executable found on system.");
}

/**
 * Returns the dedicated user data directory for the given provider profile.
 * Default Windows path: %LOCALAPPDATA%\javr-sourcecut\profiles\<provider>
 */
export function getDedicatedProfileDir(provider = "eporner"): string {
  if (process.env.JAVR_PROFILES_DIR) {
    return path.join(process.env.JAVR_PROFILES_DIR, provider);
  }
  const baseDir =
    process.env.LOCALAPPDATA || path.join(os.homedir(), ".javr-sourcecut");
  return path.join(baseDir, "javr-sourcecut", "profiles", provider);
}

/**
 * Checks whether the profile directory is currently locked by javr-sourcecut or another active process.
 */
export async function isProfileLocked(profileDir: string): Promise<boolean> {
  const lockfilePath = path.join(profileDir, ".javr-profile.lock");
  try {
    const content = await fs.readFile(lockfilePath, "utf-8");
    const info: ProfileLockInfo = JSON.parse(content);
    return Boolean(info.pid && isPidRunning(info.pid));
  } catch {
    return false;
  }
}

/**
 * Parses Netscape/Mozilla tab-separated cookie format content into structured NetscapeCookie objects.
 * Supports #HttpOnly_ prefixes and standard comments/blank lines.
 */
export function parseNetscapeCookies(content: string): NetscapeCookie[] {
  const cookies: NetscapeCookie[] = [];
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;

    // Handle #HttpOnly_ prefix
    if (line.startsWith("#HttpOnly_")) {
      line = line.substring("#HttpOnly_".length);
    } else if (line.startsWith("#")) {
      continue; // Standard comment line
    }

    const parts = line.split("\t");
    if (parts.length < 7) {
      const spaceParts = line.split(/\s+/);
      if (spaceParts.length >= 7) {
        const domain = spaceParts[0].trim();
        const includeSubdomains = spaceParts[1].toUpperCase() === "TRUE" || domain.startsWith(".");
        const cookiePath = spaceParts[2].trim() || "/";
        const secure = spaceParts[3].toUpperCase() === "TRUE";
        const expires = parseInt(spaceParts[4].trim(), 10) || 0;
        const name = spaceParts[5].trim();
        const value = spaceParts.slice(6).join(" ").trim();
        if (name) {
          cookies.push({ domain, includeSubdomains, path: cookiePath, secure, expires, name, value });
        }
      }
      continue;
    }

    const domain = parts[0].trim();
    const includeSubdomains = parts[1].toUpperCase() === "TRUE" || domain.startsWith(".");
    const cookiePath = parts[2].trim() || "/";
    const secure = parts[3].toUpperCase() === "TRUE";
    const expires = parseInt(parts[4].trim(), 10) || 0;
    const name = parts[5].trim();
    const value = parts.slice(6).join("\t").trim();

    if (name) {
      cookies.push({ domain, includeSubdomains, path: cookiePath, secure, expires, name, value });
    }
  }

  return cookies;
}

/**
 * Parses a standard browser `document.cookie` string format (e.g. "name1=val1; name2=val2")
 * into cookies scoped to a target domain.
 */
export function parseDocumentCookieString(cookieString: string, domain = ".eporner.com"): NetscapeCookie[] {
  const cookies: NetscapeCookie[] = [];
  const pairs = cookieString.split(";");

  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const name = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1).trim();
    if (name) {
      cookies.push({
        domain,
        includeSubdomains: true,
        path: "/",
        secure: true,
        expires: 0,
        name,
        value,
      });
    }
  }

  return cookies;
}

/**
 * Checks whether a cookie strictly matches a target URL based on domain, path, secure, and expiry.
 */
export function matchesCookie(
  cookie: NetscapeCookie,
  targetUrl: string,
  nowEpochSeconds = Math.floor(Date.now() / 1000)
): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return false;
  }

  // 1. Expiry check
  if (cookie.expires > 0 && cookie.expires < nowEpochSeconds) {
    return false;
  }

  // 2. Secure protocol check
  if (cookie.secure && parsedUrl.protocol !== "https:") {
    return false;
  }

  // 3. Domain matching
  const hostname = parsedUrl.hostname.toLowerCase();
  let cookieDomain = cookie.domain.toLowerCase();
  if (cookieDomain.startsWith(".")) {
    cookieDomain = cookieDomain.substring(1);
  }

  if (cookie.includeSubdomains || cookie.domain.startsWith(".")) {
    // Matches exact domain or subdomains (e.g. eporner.com or vid-cdn.eporner.com)
    if (hostname !== cookieDomain && !hostname.endsWith("." + cookieDomain)) {
      return false;
    }
  } else {
    // Exact hostname match only
    if (hostname !== cookieDomain) {
      return false;
    }
  }

  // 4. Path matching
  const targetPath = parsedUrl.pathname || "/";
  const cookiePath = cookie.path || "/";
  if (!targetPath.startsWith(cookiePath)) {
    return false;
  }

  return true;
}

/**
 * Extracts URL-scoped cookies from a dedicated persistent Chrome/Edge profile via native CDP.
 * Uses --remote-debugging-port=0 to bind exclusively to localhost (127.0.0.1) on an OS-assigned port.
 * Connects to the page target, queries Network.getCookies for explicit target URLs,
 * and performs graceful browser shutdown via CDP Browser.close.
 */
export async function extractEpornerCookiesFromProfile(
  profileDir: string,
  options?: {
    urls?: string[];
    timeoutMs?: number;
  }
): Promise<NetscapeCookie[]> {
  try {
    const stat = await fs.stat(profileDir);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }

  const lock = new ProfileLock(profileDir);
  await lock.acquire();

  const browser = findBrowserExecutable();
  const targetUrls = options?.urls ?? [
    "https://www.eporner.com",
    "https://eporner.com",
    "https://www.eporner.com/login/",
  ];

  let proc: any = null;
  let browserWs: WebSocket | null = null;
  let pageWs: WebSocket | null = null;

  try {
    const activePortFile = path.join(profileDir, "DevToolsActivePort");
    let port = 0;
    let browserWsPath = "";

    const maxRetries = 4;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      await fs.rm(activePortFile, { force: true }).catch(() => {});

      let procExited = false;
      let exitCode: number | null = null;

      proc = spawn(
        browser.executablePath,
        [
          `--user-data-dir=${profileDir}`,
          "--remote-debugging-port=0",
          "--remote-debugging-address=127.0.0.1",
          "--headless=new",
          "--no-first-run",
          "--no-default-browser-check",
          "about:blank",
        ],
        { stdio: "ignore" }
      );

      proc.once("exit", (code: number | null) => {
        procExited = true;
        exitCode = code;
      });

      const startTime = Date.now();
      const pollTimeout = 6000;
      while (Date.now() - startTime < pollTimeout) {
        if (procExited) {
          if (exitCode === 21 && attempt < maxRetries - 1) {
            // Profile in use by closing background process; wait for OS file lock release and retry
            await new Promise((r) => setTimeout(r, 600));
            break;
          }
          throw new Error(
            `Browser process exited prematurely with code ${exitCode} (profile in use or launch failure).`
          );
        }
        await new Promise((r) => setTimeout(r, 100));
        try {
          const content = await fs.readFile(activePortFile, "utf-8");
          const lines = content.trim().split(/\r?\n/);
          if (lines.length >= 2) {
            port = parseInt(lines[0].trim(), 10);
            browserWsPath = lines[1].trim();
            if (port > 0) break;
          }
        } catch {}
      }

      if (port > 0) {
        break;
      }
    }

    if (port <= 0) {
      throw new Error("Failed to discover assigned DevTools port from DevToolsActivePort on 127.0.0.1.");
    }

    // Connect to browser target WebSocket
    const browserWsUrl = `ws://127.0.0.1:${port}${browserWsPath.startsWith("/") ? browserWsPath : "/" + browserWsPath}`;
    browserWs = new WebSocket(browserWsUrl);
    await new Promise<void>((resolve, reject) => {
      if (!browserWs) return reject(new Error("Browser WebSocket not initialized"));
      browserWs.onopen = () => resolve();
      browserWs.onerror = (err) => reject(new Error(`Browser WebSocket error: ${err}`));
    });

    // Discover or create page target
    const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = (await listRes.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
    const pageTarget = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);

    let pageWsUrl = pageTarget?.webSocketDebuggerUrl;
    if (!pageWsUrl) {
      // Create new page target via browser target
      const newPageRes = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
      const newPage = (await newPageRes.json()) as { webSocketDebuggerUrl?: string };
      pageWsUrl = newPage.webSocketDebuggerUrl;
    }

    if (!pageWsUrl) {
      throw new Error("Failed to locate or create a Page target in headless browser.");
    }

    // Connect to Page target WebSocket
    pageWs = new WebSocket(pageWsUrl);
    await new Promise<void>((resolve, reject) => {
      if (!pageWs) return reject(new Error("Page WebSocket not initialized"));
      pageWs.onopen = () => resolve();
      pageWs.onerror = (err) => reject(new Error(`Page WebSocket connection failed: ${err}`));
    });

    // Query Network.getCookies with explicit URL scope
    const cookiesResponse = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP Network.getCookies timed out")), 4000);
      if (!pageWs) return reject(new Error("Page WebSocket closed"));
      pageWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data.toString());
          if (msg.id === 101) {
            clearTimeout(timer);
            resolve(msg);
          }
        } catch {}
      };
      pageWs.send(
        JSON.stringify({
          id: 101,
          method: "Network.getCookies",
          params: { urls: targetUrls },
        })
      );
    });

    const rawCookies: any[] = cookiesResponse?.result?.cookies ?? [];
    const cookies: NetscapeCookie[] = [];

    for (const c of rawCookies) {
      const domain = c.domain?.toLowerCase() ?? "";
      // Strict domain filter: only Eporner domains are accepted into the session jar
      if (domain !== "eporner.com" && !domain.endsWith(".eporner.com")) {
        continue;
      }

      cookies.push({
        domain: c.domain,
        includeSubdomains: c.domain?.startsWith(".") ?? true,
        path: c.path || "/",
        secure: Boolean(c.secure),
        expires: typeof c.expires === "number" && c.expires > 0 ? Math.floor(c.expires) : 0,
        name: c.name,
        value: c.value,
      });
    }

    return cookies;
  } finally {
    if (pageWs) {
      try {
        pageWs.close();
      } catch {}
    }

    // Graceful browser shutdown via CDP Browser.close
    if (browserWs && browserWs.readyState === WebSocket.OPEN) {
      try {
        const exitPromise = new Promise<void>((resolve) => {
          proc.once("exit", () => resolve());
          proc.once("close", () => resolve());
        });
        browserWs.send(JSON.stringify({ id: 999, method: "Browser.close" }));

        // Await graceful process exit with 2s timeout
        await Promise.race([
          exitPromise,
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
        try {
          browserWs.close();
        } catch {}
      } catch {}
    }

    // Fallback force kill only if process has not exited
    try {
      if (proc && !proc.killed) {
        if (process.platform === "win32" && proc.pid) {
          try {
            execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "ignore" });
          } catch {}
        }
        proc.kill();
      }
    } catch {}

    await lock.release();
  }
}

export class NetscapeCookieFileSessionProvider implements SourceSessionProvider {
  readonly hasSession = true;
  private cookies: NetscapeCookie[];

  constructor(cookies: NetscapeCookie[]) {
    this.cookies = cookies;
  }

  static async fromFile(filePath: string): Promise<NetscapeCookieFileSessionProvider> {
    const resolvedPath = path.resolve(filePath);
    const content = await fs.readFile(resolvedPath, "utf-8");
    const cookies = parseNetscapeCookies(content);
    return new NetscapeCookieFileSessionProvider(cookies);
  }

  static fromDocumentCookie(cookieStr: string, domain = ".eporner.com"): NetscapeCookieFileSessionProvider {
    const cookies = parseDocumentCookieString(cookieStr, domain);
    return new NetscapeCookieFileSessionProvider(cookies);
  }

  getCookieHeaderForUrl(targetUrl: string, nowEpochSeconds = Math.floor(Date.now() / 1000)): string | undefined {
    const matching = this.cookies.filter((c) => matchesCookie(c, targetUrl, nowEpochSeconds));
    if (matching.length === 0) return undefined;

    const map = new Map<string, string>();
    for (const c of matching) {
      map.set(c.name, c.value);
    }

    const headerParts: string[] = [];
    for (const [name, val] of map.entries()) {
      headerParts.push(`${name}=${val}`);
    }

    return headerParts.join("; ");
  }

  createSessionFetch(baseFetch: typeof fetch = fetch): typeof fetch {
    return async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const urlStr =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const cookieHeader = this.getCookieHeaderForUrl(urlStr);

      const headers = new Headers(
        init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined)
      );
      if (cookieHeader && !headers.has("Cookie")) {
        headers.set("Cookie", cookieHeader);
      }

      return baseFetch(input, {
        ...init,
        headers,
      });
    };
  }

  toJSON() {
    return {
      hasSession: this.hasSession,
      providerType: "NetscapeCookieFileSessionProvider",
      cookieCount: this.cookies.length,
      domains: Array.from(new Set(this.cookies.map((c) => c.domain))),
    };
  }
}

export class BrowserProfileSessionProvider implements SourceSessionProvider {
  readonly hasSession = true;
  readonly browserType: "chrome" | "edge";
  readonly profileDir: string;
  private cookies: NetscapeCookie[];

  constructor(
    cookies: NetscapeCookie[],
    profileDir: string,
    browserType: "chrome" | "edge" = "chrome"
  ) {
    this.cookies = cookies;
    this.profileDir = profileDir;
    this.browserType = browserType;
  }

  static async fromDedicatedProfile(
    providerName = "eporner",
    profileDir = getDedicatedProfileDir(providerName)
  ): Promise<BrowserProfileSessionProvider | null> {
    try {
      const stat = await fs.stat(profileDir);
      if (!stat.isDirectory()) return null;
    } catch {
      return null;
    }

    const browser = findBrowserExecutable();
    const cookies = await extractEpornerCookiesFromProfile(profileDir);
    if (cookies.length === 0) {
      return null;
    }

    return new BrowserProfileSessionProvider(cookies, profileDir, browser.type);
  }

  getCookieHeaderForUrl(targetUrl: string, nowEpochSeconds = Math.floor(Date.now() / 1000)): string | undefined {
    const matching = this.cookies.filter((c) => matchesCookie(c, targetUrl, nowEpochSeconds));
    if (matching.length === 0) return undefined;

    const map = new Map<string, string>();
    for (const c of matching) {
      map.set(c.name, c.value);
    }

    const headerParts: string[] = [];
    for (const [name, val] of map.entries()) {
      headerParts.push(`${name}=${val}`);
    }

    return headerParts.join("; ");
  }

  createSessionFetch(baseFetch: typeof fetch = fetch): typeof fetch {
    return async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const urlStr =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const cookieHeader = this.getCookieHeaderForUrl(urlStr);

      const headers = new Headers(
        init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined)
      );
      if (cookieHeader && !headers.has("Cookie")) {
        headers.set("Cookie", cookieHeader);
      }

      return baseFetch(input, {
        ...init,
        headers,
      });
    };
  }

  toJSON() {
    return {
      hasSession: this.hasSession,
      providerType: "BrowserProfileSessionProvider",
      browserType: this.browserType,
      profileDir: this.profileDir,
      cookieCount: this.cookies.length,
      domains: Array.from(new Set(this.cookies.map((c) => c.domain))),
    };
  }
}

export class NoopSessionProvider implements SourceSessionProvider {
  readonly hasSession = false;

  getCookieHeaderForUrl(): undefined {
    return undefined;
  }

  createSessionFetch(baseFetch: typeof fetch = fetch): typeof fetch {
    return baseFetch;
  }
}

/**
 * Resolves a SourceSessionProvider according to authoritative precedence:
 * A. Explicit cookies file (--cookies <path> or JAVR_COOKIES_FILE) -> NetscapeCookieFileSessionProvider
 * B. Dedicated browser profile exists (e.g. %LOCALAPPDATA%\javr-sourcecut\profiles\eporner) -> BrowserProfileSessionProvider
 * C. Local default cookies.txt in workspace -> NetscapeCookieFileSessionProvider
 * D. Otherwise -> NoopSessionProvider
 */
export async function resolveSessionProvider(options?: {
  cookiesPath?: string;
  cookieString?: string;
  profileDir?: string;
}): Promise<SourceSessionProvider> {
  if (options?.cookieString) {
    return NetscapeCookieFileSessionProvider.fromDocumentCookie(options.cookieString);
  }

  const explicitPath = options?.cookiesPath || process.env.JAVR_COOKIES_FILE;
  if (explicitPath) {
    try {
      return await NetscapeCookieFileSessionProvider.fromFile(explicitPath);
    } catch (err: any) {
      throw new Error(`Failed to load cookies file from "${explicitPath}": ${err.message}`);
    }
  }

  // B. Dedicated persistent browser profile
  const profileDir = options?.profileDir ?? getDedicatedProfileDir("eporner");
  try {
    const browserProvider = await BrowserProfileSessionProvider.fromDedicatedProfile("eporner", profileDir);
    if (browserProvider) {
      return browserProvider;
    }
  } catch (err: any) {
    // If profile is locked, rethrow lock safety error
    if (err.message?.includes("currently in use by process PID") || err.message?.includes("Failed to acquire lock")) {
      throw err;
    }
  }

  // C. Default cookies.txt in workspace
  try {
    const defaultCookies = path.resolve(process.cwd(), "cookies.txt");
    const stat = await fs.stat(defaultCookies);
    if (stat.isFile()) {
      return await NetscapeCookieFileSessionProvider.fromFile(defaultCookies);
    }
  } catch {
    // Ignore default file absence
  }

  return new NoopSessionProvider();
}

/**
 * Interactive CLI helper to launch a visible dedicated browser for one-time visual login.
 */
export async function launchAuthBrowser(
  provider = "eporner",
  loginUrl = "https://www.eporner.com/login/"
): Promise<{ profileDir: string; browserType: string }> {
  const profileDir = getDedicatedProfileDir(provider);
  await fs.mkdir(profileDir, { recursive: true });

  const lock = new ProfileLock(profileDir);
  await lock.acquire();

  const browser = findBrowserExecutable();

  console.log(`\nLaunching visible ${browser.type.toUpperCase()} with dedicated profile:`);
  console.log(` Profile: ${profileDir}`);
  console.log(` Browser: ${browser.executablePath}`);
  console.log(`\nPlease log into Eporner in the opened browser window. When finished, you may close the browser.`);

  const proc = spawn(
    browser.executablePath,
    [
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      loginUrl,
    ],
    { stdio: "ignore" }
  );

  try {
    await new Promise<void>((resolve) => {
      proc.on("close", () => resolve());
    });
  } finally {
    await lock.release();
  }

  console.log(`\nBrowser session profile saved.`);
  console.log(`Dedicated profile directory: ${profileDir}\n`);

  return { profileDir, browserType: browser.type };
}

/**
 * Resets ONLY the javr-sourcecut dedicated provider profile.
 */
export async function resetAuthProfile(provider = "eporner"): Promise<string> {
  const profileDir = getDedicatedProfileDir(provider);
  const lock = new ProfileLock(profileDir);
  await lock.acquire();
  try {
    await fs.rm(profileDir, { recursive: true, force: true });
  } finally {
    await lock.release();
  }
  console.log(`Dedicated ${provider} browser profile reset: ${profileDir}`);
  return profileDir;
}
