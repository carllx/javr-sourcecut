import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

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
      // Might be whitespace-delimited
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

    // Deduplicate by name, preferring the longest/most specific path
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
 * Resolves a SourceSessionProvider from explicit options, environment variables, or default paths.
 */
export async function resolveSessionProvider(options?: {
  cookiesPath?: string;
  cookieString?: string;
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

  // Check default cookies.txt in workspace if present
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
