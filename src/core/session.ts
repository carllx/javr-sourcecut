import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { spawn } from "node:child_process";

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
 * Checks whether the profile directory is currently locked by a running browser instance.
 */
export async function isProfileLocked(profileDir: string): Promise<boolean> {
  const lockfilePath = path.join(profileDir, "lockfile");
  try {
    const handle = await fs.open(lockfilePath, "r+");
    await handle.close();
    return false;
  } catch (err: any) {
    if (err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES") {
      return true;
    }
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
 * Bound strictly to localhost (127.0.0.1).
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

  if (await isProfileLocked(profileDir)) {
    throw new Error(
      `Dedicated browser profile at "${profileDir}" is currently locked or in use. Please close the browser window before resuming.`
    );
  }

  const browser = findBrowserExecutable();
  const targetUrls = options?.urls ?? [
    "https://www.eporner.com",
    "https://eporner.com",
    "https://www.eporner.com/login/",
  ];

  // Pick an ephemeral port on 127.0.0.1
  const port = Math.floor(Math.random() * 500) + 9400;

  const proc = spawn(
    browser.executablePath,
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  try {
    let versionJson: { webSocketDebuggerUrl?: string } | null = null;
    const timeout = options?.timeoutMs ?? 6000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      await new Promise((r) => setTimeout(r, 150));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) {
          versionJson = (await res.json()) as { webSocketDebuggerUrl?: string };
          break;
        }
      } catch {
        // continue polling
      }
    }

    if (!versionJson?.webSocketDebuggerUrl) {
      throw new Error("Failed to connect to browser CDP debugger endpoint on 127.0.0.1.");
    }

    const ws = new WebSocket(versionJson.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (err) => reject(new Error(`WebSocket connection failed: ${err}`));
    });

    const cookiesResponse = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP Network.getCookies timed out")), 4000);
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data.toString());
          if (msg.id === 101) {
            clearTimeout(timer);
            resolve(msg);
          }
        } catch {}
      };
      ws.send(
        JSON.stringify({
          id: 101,
          method: "Network.getCookies",
          params: { urls: targetUrls },
        })
      );
    });

    ws.close();

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
    proc.kill("SIGKILL");
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
    if (err.message?.includes("locked or in use")) {
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

  if (await isProfileLocked(profileDir)) {
    throw new Error(
      `Dedicated browser profile at "${profileDir}" is currently open or locked. Please close any open browser windows for this profile.`
    );
  }

  const browser = findBrowserExecutable();
  const port = Math.floor(Math.random() * 500) + 9400;

  console.log(`\nLaunching visible ${browser.type.toUpperCase()} with dedicated profile:`);
  console.log(` Profile: ${profileDir}`);
  console.log(` Browser: ${browser.executablePath}`);
  console.log(`\nPlease log into Eporner in the opened browser window. When finished, you may close the browser.`);

  const proc = spawn(
    browser.executablePath,
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      loginUrl,
    ],
    { stdio: "ignore" }
  );

  await new Promise<void>((resolve) => {
    proc.on("close", () => resolve());
  });

  console.log(`\nBrowser session profile saved.`);
  console.log(`Dedicated profile directory: ${profileDir}\n`);

  return { profileDir, browserType: browser.type };
}

/**
 * Resets ONLY the javr-sourcecut dedicated provider profile.
 */
export async function resetAuthProfile(provider = "eporner"): Promise<string> {
  const profileDir = getDedicatedProfileDir(provider);
  if (await isProfileLocked(profileDir)) {
    throw new Error(
      `Dedicated browser profile at "${profileDir}" is currently open. Please close the browser window before resetting.`
    );
  }
  await fs.rm(profileDir, { recursive: true, force: true });
  console.log(`Dedicated ${provider} browser profile reset: ${profileDir}`);
  return profileDir;
}
