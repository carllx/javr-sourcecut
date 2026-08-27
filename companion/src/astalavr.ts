export interface AstalaVrRenditionSummary {
  formatId: string;
  resolution: string;
  height: number;
  vcodec: string;
  mimeType: string;
  mediaHostname: string;
  fullDirectUrl: string;
}

export type AstalaVrPageStatus =
  | "WAITING_FOR_REAL_PAGE"
  | "WAITING_FOR_VIDEO_DOM"
  | "REAL_PAGE_ACTIVE";

export interface AstalaVrPageDetection {
  status: AstalaVrPageStatus;
  isChallenge: boolean;
  isRealPage: boolean;
  videoId: string | null;
}

const ASTALAVR_URL_PATTERNS = [
  /(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)?astalavr\.com\/(?:[a-z]{2}\/)?videos\/([a-zA-Z0-9]+)/i,
];

export function extractAstalaVrVideoId(url: string): string | null {
  for (const pattern of ASTALAVR_URL_PATTERNS) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

export function detectAstalaVrPage(doc: Document = document, currentUrl?: string): AstalaVrPageDetection {
  const title = (doc.title || "").trim();
  const bodyText = doc.body ? (doc.body.innerText || doc.body.textContent || "") : "";

  // Cloudflare challenge detection patterns
  const isChallenge =
    title.includes("Just a moment...") ||
    title.includes("Attention Required! | Cloudflare") ||
    bodyText.includes("Checking your browser before accessing") ||
    bodyText.includes("Verify you are human") ||
    bodyText.includes("Enable JavaScript and cookies to continue") ||
    Boolean(doc.querySelector("#challenge-running, #cf-please-wait, #cf-challenge-running"));

  const urlToCheck = currentUrl || (typeof window !== "undefined" ? window.location.href : "");
  const videoIdFromUrl = extractAstalaVrVideoId(urlToCheck);
  const mainVideo = doc.querySelector("main[data-video-id], main");
  const videoId =
    videoIdFromUrl ||
    mainVideo?.getAttribute("data-video-id") ||
    (doc.querySelector("meta[property='og:url']")?.getAttribute("content")
      ? extractAstalaVrVideoId(doc.querySelector("meta[property='og:url']")!.getAttribute("content")!)
      : null);

  const dl8Video = doc.querySelector("dl8-video");

  let status: AstalaVrPageStatus;
  if (isChallenge) {
    status = "WAITING_FOR_REAL_PAGE";
  } else if (!dl8Video) {
    status = "WAITING_FOR_VIDEO_DOM";
  } else {
    status = "REAL_PAGE_ACTIVE";
  }

  return {
    status,
    isChallenge,
    isRealPage: status === "REAL_PAGE_ACTIVE",
    videoId: videoId || null,
  };
}

export function parseAstalaVrDomRenditions(root: ParentNode = document, baseHref?: string): AstalaVrRenditionSummary[] {
  const renditions: AstalaVrRenditionSummary[] = [];
  const sources = root.querySelectorAll("dl8-video source");
  const href = baseHref || (typeof window !== "undefined" ? window.location.href : "https://astalavr.com");

  for (const source of Array.from(sources)) {
    const rawSrc = source.getAttribute("src");
    if (!rawSrc) continue;

    const qualityAttr = source.getAttribute("quality") || "";
    const typeAttr = source.getAttribute("type") || "";
    let mediaHostname = "unknown";
    let fullDirectUrl = rawSrc;

    try {
      const parsed = new URL(rawSrc, href);
      mediaHostname = parsed.hostname;
      fullDirectUrl = parsed.toString();
    } catch {
      if (rawSrc.startsWith("//")) {
        mediaHostname = rawSrc.split("/")[2] || "unknown";
        fullDirectUrl = "https:" + rawSrc;
      } else if (rawSrc.startsWith("http")) {
        try {
          const u = new URL(rawSrc);
          mediaHostname = u.hostname;
        } catch {}
      }
    }

    let filename = "";
    try {
      const parsed = new URL(fullDirectUrl);
      filename = parsed.pathname.split("/").pop() || "";
    } catch {
      filename = fullDirectUrl.split("?")[0].split("/").pop() || "";
    }

    let height = 0;
    const heightMatch = filename.match(/(\d+)[pP]/i) || qualityAttr.match(/(\d+)[pP]?/i);
    if (heightMatch && heightMatch[1]) {
      height = parseInt(heightMatch[1], 10);
    } else if (/4[kK]/i.test(qualityAttr)) {
      height = 2160;
    }

    // Determine codec from DOM attributes if provided, otherwise "unknown"
    let vcodec = "unknown";
    if (typeAttr.includes("codecs=")) {
      const codecMatch = typeAttr.match(/codecs=["']?([^"';]+)["']?/i);
      if (codecMatch && codecMatch[1]) {
        vcodec = codecMatch[1];
      }
    } else if (typeAttr.includes("avc1") || typeAttr.includes("h264")) {
      vcodec = "h264";
    } else if (typeAttr.includes("av01") || typeAttr.includes("av1")) {
      vcodec = "av1";
    } else if (typeAttr.includes("vp9")) {
      vcodec = "vp9";
    } else if (typeAttr.includes("hvc1") || typeAttr.includes("hevc") || typeAttr.includes("h265")) {
      vcodec = "hevc";
    }

    const mimeType = typeAttr || "unknown";
    const resolution = height > 0 ? (height + "p") : (qualityAttr || "unknown");
    const formatId = resolution + "-" + vcodec;

    // Deduplicate identical fullDirectUrl
    if (!renditions.some((r) => r.fullDirectUrl === fullDirectUrl)) {
      renditions.push({
        formatId,
        resolution,
        height,
        vcodec,
        mimeType,
        mediaHostname,
        fullDirectUrl,
      });
    }
  }

  // Sort ascending by height
  renditions.sort((a, b) => a.height - b.height);
  return renditions;
}

export interface BrowserMediaTestResult {
  pass: boolean;
  duration?: number;
  errorCode?: number | string;
}

export function testBrowserMedia720p(
  directUrl: string,
  timeoutMs: number = 10000,
  doc?: Document
): Promise<BrowserMediaTestResult> {
  return new Promise((resolve) => {
    let resolved = false;
    const targetDoc = doc || (typeof document !== "undefined" ? document : null);
    if (!targetDoc) {
      resolve({ pass: false, errorCode: "NO_DOCUMENT" });
      return;
    }
    const video = targetDoc.createElement("video");
    video.preload = "metadata";

    const cleanup = () => {
      video.removeAttribute("src");
      video.load();
      video.remove();
    };

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve({ pass: false, errorCode: "TIMEOUT" });
      }
    }, timeoutMs);

    video.onloadedmetadata = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        const duration = video.duration;
        cleanup();
        resolve({ pass: true, duration });
      }
    };

    video.onerror = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        const errorCode = video.error ? video.error.code : "UNKNOWN_ERROR";
        cleanup();
        resolve({ pass: false, errorCode });
      }
    };

    try {
      video.src = directUrl;
      video.load();
    } catch {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        cleanup();
        resolve({ pass: false, errorCode: "LOAD_EXCEPTION" });
      }
    }
  });
}

export interface ActivePlayerInspection {
  activePlayerFound: boolean;
  tagName?: string;
  readyState?: number;
  networkState?: number;
  paused?: boolean;
  duration?: number;
  videoWidth?: number;
  videoHeight?: number;
  currentSrcKind: "DIRECT_CDN" | "BLOB" | "OTHER" | "EMPTY";
  currentSrcHost?: string;
  currentSrcPath?: string;
  currentSrcHasToken?: boolean;
  matchedCachedRendition: "720p" | "1440p" | "2048p" | "NONE";
}

export function inspectActivePlayer(
  doc: Document = document,
  cachedRenditions: AstalaVrRenditionSummary[] = []
): ActivePlayerInspection {
  const dl8VideoEl = doc.querySelector("dl8-video");
  let candidateEl: Element | null = null;

  if (dl8VideoEl) {
    // 1. Check light DOM child <video> inside <dl8-video>
    const innerVideo = dl8VideoEl.querySelector("video");
    if (innerVideo) {
      candidateEl = innerVideo;
    } else if (dl8VideoEl.shadowRoot) {
      // 2. Check open shadowRoot <video> inside <dl8-video>
      const shadowVideo = dl8VideoEl.shadowRoot.querySelector("video");
      if (shadowVideo) {
        candidateEl = shadowVideo;
      }
    }

    // 3. If no inner video found, check if <dl8-video> custom element exposes media-like properties
    if (!candidateEl) {
      const elAsAny = dl8VideoEl as any;
      if (
        typeof elAsAny.currentSrc === "string" ||
        typeof elAsAny.src === "string" ||
        typeof elAsAny.readyState === "number"
      ) {
        candidateEl = dl8VideoEl;
      }
    }
  }

  if (!candidateEl || typeof (candidateEl as any).tagName !== "string") {
    return {
      activePlayerFound: false,
      currentSrcKind: "EMPTY",
      matchedCachedRendition: "NONE",
    };
  }

  const v = candidateEl as HTMLVideoElement;
  const rawSrc = v.currentSrc || v.src || v.getAttribute("src") || "";

  let currentSrcKind: "DIRECT_CDN" | "BLOB" | "OTHER" | "EMPTY" = "EMPTY";
  let currentSrcHost: string | undefined;
  let currentSrcPath: string | undefined;
  let currentSrcHasToken: boolean | undefined;
  let matchedCachedRendition: "720p" | "1440p" | "2048p" | "NONE" = "NONE";

  if (!rawSrc) {
    currentSrcKind = "EMPTY";
  } else if (rawSrc.startsWith("blob:")) {
    currentSrcKind = "BLOB";
  } else {
    try {
      const parsed = new URL(rawSrc, typeof window !== "undefined" ? window.location.href : "https://astalavr.com");
      currentSrcHost = parsed.hostname;
      currentSrcPath = parsed.pathname;
      currentSrcHasToken = parsed.searchParams.has("token") || parsed.search.includes("token=");

      if (parsed.hostname.includes("astalavr.com") || parsed.hostname.includes("cdn")) {
        currentSrcKind = "DIRECT_CDN";
      } else {
        currentSrcKind = "OTHER";
      }

      // Match origin + pathname against cached renditions
      const playerOriginPath = (parsed.origin + parsed.pathname).toLowerCase();
      for (const r of cachedRenditions) {
        try {
          const rParsed = new URL(r.fullDirectUrl);
          const rOriginPath = (rParsed.origin + rParsed.pathname).toLowerCase();
          if (playerOriginPath === rOriginPath) {
            if (r.resolution === "720p" || r.height === 720) {
              matchedCachedRendition = "720p";
            } else if (r.resolution === "1440p" || r.height === 1440) {
              matchedCachedRendition = "1440p";
            } else if (r.resolution === "2048p" || r.height === 2048) {
              matchedCachedRendition = "2048p";
            }
            break;
          }
        } catch {}
      }
    } catch {
      currentSrcKind = "OTHER";
    }
  }

  return {
    activePlayerFound: true,
    tagName: v.tagName.toUpperCase(),
    readyState: v.readyState,
    networkState: v.networkState,
    paused: v.paused,
    duration: typeof v.duration === "number" && !isNaN(v.duration) ? v.duration : undefined,
    videoWidth: typeof v.videoWidth === "number" ? v.videoWidth : undefined,
    videoHeight: typeof v.videoHeight === "number" ? v.videoHeight : undefined,
    currentSrcKind,
    currentSrcHost,
    currentSrcPath,
    currentSrcHasToken,
    matchedCachedRendition,
  };
}

export interface PlaybackResourceItem {
  initiatorType: string;
  host: string;
  path: string;
  hasToken: boolean;
  matchedRendition: "720p" | "1440p" | "2048p" | "NONE";
  exactCachedUrlMatch: "YES" | "NO";
  queryMatch: "YES" | "NO";
  tokenMatch: "YES" | "NO" | "UNAVAILABLE";
  sameFullUrlAsPreviousMatch: "YES" | "NO" | "N/A";
  durationMs: number;
  transferSize?: number;
  encodedBodySize?: number;
}

export interface PlaybackResourcesInspection {
  dl8VideoFound: boolean;
  dl8ShadowRoot: "OPEN" | "UNAVAILABLE";
  resourceMatchCount: number;
  resources: PlaybackResourceItem[];
}

export function inspectPlaybackResources(
  doc: Document = document,
  cachedRenditions: AstalaVrRenditionSummary[] = [],
  perf: Performance = typeof performance !== "undefined" ? performance : ({} as any)
): PlaybackResourcesInspection {
  const dl8VideoEl = doc.querySelector("dl8-video");
  const dl8VideoFound = Boolean(dl8VideoEl);
  const dl8ShadowRoot: "OPEN" | "UNAVAILABLE" =
    dl8VideoEl && dl8VideoEl.shadowRoot ? "OPEN" : "UNAVAILABLE";

  const entries =
    perf && typeof perf.getEntriesByType === "function"
      ? (perf.getEntriesByType("resource") as PerformanceResourceTiming[])
      : [];

  const matchedResources: PlaybackResourceItem[] = [];
  const rawMatchedUrls: string[] = [];

  for (const entry of entries) {
    const rawUrl = entry.name;
    if (!rawUrl || typeof rawUrl !== "string") continue;

    try {
      const parsed = new URL(rawUrl, typeof window !== "undefined" ? window.location.href : "https://astalavr.com");
      const host = parsed.hostname;
      const path = parsed.pathname;
      const entryToken = parsed.searchParams.get("token");
      const hasToken = parsed.searchParams.has("token") || parsed.search.includes("token=");

      let matchedRendition: "720p" | "1440p" | "2048p" | "NONE" = "NONE";
      let matchedCachedRenditionObj: AstalaVrRenditionSummary | null = null;
      const entryOriginPath = (parsed.origin + parsed.pathname).toLowerCase();

      for (const r of cachedRenditions) {
        try {
          const rParsed = new URL(r.fullDirectUrl);
          const rOriginPath = (rParsed.origin + rParsed.pathname).toLowerCase();
          if (entryOriginPath === rOriginPath) {
            matchedCachedRenditionObj = r;
            if (r.resolution === "720p" || r.height === 720) {
              matchedRendition = "720p";
            } else if (r.resolution === "1440p" || r.height === 1440) {
              matchedRendition = "1440p";
            } else if (r.resolution === "2048p" || r.height === 2048) {
              matchedRendition = "2048p";
            }
            break;
          }
        } catch {}
      }

      const isCdn = host === "cdn3.astalavr.com";
      const isRenditionMatch = matchedRendition !== "NONE";

      if (isCdn || isRenditionMatch) {
        let exactCachedUrlMatch: "YES" | "NO" = "NO";
        let queryMatch: "YES" | "NO" = "NO";
        let tokenMatch: "YES" | "NO" | "UNAVAILABLE" = "UNAVAILABLE";

        if (matchedCachedRenditionObj) {
          try {
            const cachedParsed = new URL(matchedCachedRenditionObj.fullDirectUrl);
            const cachedToken = cachedParsed.searchParams.get("token");

            // A. exact full URL equality
            exactCachedUrlMatch = parsed.href === cachedParsed.href ? "YES" : "NO";

            // B. query-string equality
            queryMatch = parsed.search === cachedParsed.search ? "YES" : "NO";

            // C. token parameter equality
            if (entryToken !== null && cachedToken !== null) {
              tokenMatch = entryToken === cachedToken ? "YES" : "NO";
            } else {
              tokenMatch = "UNAVAILABLE";
            }
          } catch {}
        }

        // Same full URL as previous match
        let sameFullUrlAsPreviousMatch: "YES" | "NO" | "N/A" = "N/A";
        if (rawMatchedUrls.length > 0) {
          const previousUrl = rawMatchedUrls[rawMatchedUrls.length - 1];
          sameFullUrlAsPreviousMatch = parsed.href === previousUrl ? "YES" : "NO";
        }
        rawMatchedUrls.push(parsed.href);

        matchedResources.push({
          initiatorType: entry.initiatorType || "unknown",
          host,
          path,
          hasToken,
          matchedRendition,
          exactCachedUrlMatch,
          queryMatch,
          tokenMatch,
          sameFullUrlAsPreviousMatch,
          durationMs: Math.round(entry.duration || 0),
          transferSize: typeof entry.transferSize === "number" ? entry.transferSize : undefined,
          encodedBodySize: typeof entry.encodedBodySize === "number" ? entry.encodedBodySize : undefined,
        });
      }
    } catch {}
  }

  return {
    dl8VideoFound,
    dl8ShadowRoot,
    resourceMatchCount: matchedResources.length,
    resources: matchedResources,
  };
}

export interface ActualPlaybackTestResult {
  actualPlaybackUrlFound: boolean;
  pass?: boolean;
  duration?: number;
  errorCode?: number | string;
  pathMatch?: boolean;
  tokenDiffersFromDom?: boolean;
}

export async function testActualPlayback720p(
  cachedRenditions: AstalaVrRenditionSummary[] = [],
  perf: Performance = typeof performance !== "undefined" ? performance : ({} as any),
  doc: Document = typeof document !== "undefined" ? document : (null as any),
  timeoutMs: number = 10000
): Promise<ActualPlaybackTestResult> {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc) {
    return {
      actualPlaybackUrlFound: false,
      pass: false,
      errorCode: "NO_DOCUMENT",
    };
  }

  const entries =
    perf && typeof perf.getEntriesByType === "function"
      ? (perf.getEntriesByType("resource") as PerformanceResourceTiming[])
      : [];

  const rendition720p = cachedRenditions.find((r) => r.resolution === "720p" || r.height === 720);
  let cached720pPath = "";
  let cached720pToken: string | null = null;
  if (rendition720p) {
    try {
      const cParsed = new URL(rendition720p.fullDirectUrl);
      cached720pPath = cParsed.pathname.toLowerCase();
      cached720pToken = cParsed.searchParams.get("token");
    } catch {}
  }

  // Find matching entries with initiatorType == "video", host == "cdn3.astalavr.com", and matching 720p pathname
  const matchingUrls: string[] = [];
  for (const entry of entries) {
    const rawUrl = entry.name;
    if (!rawUrl || typeof rawUrl !== "string") continue;

    try {
      const parsed = new URL(rawUrl, typeof window !== "undefined" ? window.location.href : "https://astalavr.com");
      const host = parsed.hostname;
      const path = parsed.pathname.toLowerCase();
      const initiator = (entry.initiatorType || "").toLowerCase();

      if (
        (initiator === "video" || initiator === "media") &&
        host === "cdn3.astalavr.com" &&
        cached720pPath &&
        path === cached720pPath
      ) {
        matchingUrls.push(parsed.href);
      }
    } catch {}
  }

  if (matchingUrls.length === 0) {
    return {
      actualPlaybackUrlFound: false,
    };
  }

  // Select latest matching resource
  const latestPlaybackUrl = matchingUrls[matchingUrls.length - 1];
  let pathMatch = false;
  let tokenDiffersFromDom = false;

  try {
    const playParsed = new URL(latestPlaybackUrl);
    pathMatch = playParsed.pathname.toLowerCase() === cached720pPath;
    const playToken = playParsed.searchParams.get("token");
    if (playToken !== null && cached720pToken !== null) {
      tokenDiffersFromDom = playToken !== cached720pToken;
    } else {
      tokenDiffersFromDom = playToken !== cached720pToken;
    }
  } catch {}

  const mediaRes = await testBrowserMedia720p(latestPlaybackUrl, timeoutMs, targetDoc);

  return {
    actualPlaybackUrlFound: true,
    pass: mediaRes.pass,
    duration: mediaRes.duration,
    errorCode: mediaRes.errorCode,
    pathMatch,
    tokenDiffersFromDom,
  };
}

export interface ActualPlaybackRangeTestResult {
  actualPlaybackUrlFound: boolean;
  pass?: boolean;
  httpStatus?: number;
  contentRangePresent?: boolean;
  contentRangeValid?: boolean;
  contentLengthPresent?: boolean;
  contentLength?: string | null;
  contentType?: string | null;
  bytesRead?: number;
  maxBytesRead: number;
  bodyRead?: "YES" | "NO";
  validationMode?: "CONTENT_RANGE" | "CONTENT_LENGTH_FALLBACK";
  failureKind?:
    | "FETCH_ERROR"
    | "STATUS_NOT_206"
    | "INVALID_CONTENT_RANGE"
    | "CONTENT_LENGTH_MISSING_OR_INVALID"
    | "INCOMPLETE_READ"
    | "STREAM_UNAVAILABLE"
    | "UNKNOWN";
  errorName?: string;
}

export async function testActualPlayback720pRange(
  cachedRenditions: AstalaVrRenditionSummary[] = [],
  perf: Performance = typeof performance !== "undefined" ? performance : ({} as any),
  fetchFn: typeof fetch = typeof fetch !== "undefined" ? fetch.bind(globalThis) : (null as any)
): Promise<ActualPlaybackRangeTestResult> {
  const MAX_BYTES_READ = 1048576; // 1 MiB

  const entries =
    perf && typeof perf.getEntriesByType === "function"
      ? (perf.getEntriesByType("resource") as PerformanceResourceTiming[])
      : [];

  const rendition720p = cachedRenditions.find((r) => r.resolution === "720p" || r.height === 720);
  let cached720pPath = "";
  if (rendition720p) {
    try {
      const cParsed = new URL(rendition720p.fullDirectUrl);
      cached720pPath = cParsed.pathname.toLowerCase();
    } catch {}
  }

  const matchingUrls: string[] = [];
  for (const entry of entries) {
    const rawUrl = entry.name;
    if (!rawUrl || typeof rawUrl !== "string") continue;

    try {
      const parsed = new URL(rawUrl, typeof window !== "undefined" ? window.location.href : "https://astalavr.com");
      const host = parsed.hostname;
      const path = parsed.pathname.toLowerCase();
      const initiator = (entry.initiatorType || "").toLowerCase();

      if (
        (initiator === "video" || initiator === "media") &&
        host === "cdn3.astalavr.com" &&
        cached720pPath &&
        path === cached720pPath
      ) {
        matchingUrls.push(parsed.href);
      }
    } catch {}
  }

  if (matchingUrls.length === 0) {
    return {
      actualPlaybackUrlFound: false,
      maxBytesRead: MAX_BYTES_READ,
    };
  }

  const latestPlaybackUrl = matchingUrls[matchingUrls.length - 1];

  let response: Response;
  try {
    response = await fetchFn(latestPlaybackUrl, {
      headers: {
        Range: "bytes=0-1048575",
      },
    });
  } catch (err: any) {
    const errorName = (err && typeof err.name === "string" ? err.name : "FetchError") || "FetchError";
    return {
      actualPlaybackUrlFound: true,
      pass: false,
      failureKind: "FETCH_ERROR",
      errorName,
      maxBytesRead: MAX_BYTES_READ,
    };
  }

  const httpStatus = response.status;
  const contentRangeHeader = response.headers ? response.headers.get("Content-Range") : null;
  const contentRangePresent = Boolean(contentRangeHeader);
  const contentRangeValid = Boolean(
    contentRangeHeader && /^bytes\s+0-1048575\//i.test(contentRangeHeader.trim())
  );
  const contentLength = response.headers ? response.headers.get("Content-Length") : null;
  const contentLengthPresent = Boolean(contentLength !== null && contentLength !== undefined);
  const contentType = response.headers ? response.headers.get("Content-Type") : null;

  if (httpStatus !== 206) {
    // Cancel response body immediately if possible
    try {
      if (response.body && typeof response.body.cancel === "function") {
        await response.body.cancel();
      }
    } catch {}

    return {
      actualPlaybackUrlFound: true,
      pass: false,
      httpStatus,
      contentRangePresent,
      contentRangeValid,
      contentLengthPresent,
      contentLength,
      contentType,
      bodyRead: "NO",
      bytesRead: 0,
      failureKind: "STATUS_NOT_206",
      maxBytesRead: MAX_BYTES_READ,
    };
  }

  if (!response.body) {
    return {
      actualPlaybackUrlFound: true,
      pass: false,
      httpStatus,
      contentRangePresent,
      contentRangeValid,
      contentLengthPresent,
      contentLength,
      contentType,
      bodyRead: "NO",
      bytesRead: 0,
      failureKind: "STREAM_UNAVAILABLE",
      maxBytesRead: MAX_BYTES_READ,
    };
  }

  // Read response stream enforcing 1 MiB cap
  let bytesRead = 0;
  const reader = response.body.getReader();
  try {
    while (bytesRead < MAX_BYTES_READ) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const remaining = MAX_BYTES_READ - bytesRead;
        if (value.byteLength >= remaining) {
          bytesRead += remaining;
          try {
            await reader.cancel();
          } catch {}
          break;
        } else {
          bytesRead += value.byteLength;
        }
      }
    }
  } catch {
    // Reader error
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  // CORS-observability aware validation policy
  let pass = false;
  let validationMode: "CONTENT_RANGE" | "CONTENT_LENGTH_FALLBACK" | undefined;
  let failureKind: ActualPlaybackRangeTestResult["failureKind"];

  if (httpStatus === 206 && bytesRead === MAX_BYTES_READ) {
    if (contentRangePresent) {
      if (contentRangeValid) {
        pass = true;
        validationMode = "CONTENT_RANGE";
      } else {
        // Visible but invalid Content-Range fails closed; do not use Content-Length fallback
        pass = false;
        failureKind = "INVALID_CONTENT_RANGE";
      }
    } else {
      // Content-Range not visible (CORS restriction) -> Content-Length fallback
      const numericContentLength = contentLength !== null ? parseInt(contentLength, 10) : NaN;
      if (contentLengthPresent && numericContentLength === MAX_BYTES_READ) {
        pass = true;
        validationMode = "CONTENT_LENGTH_FALLBACK";
      } else {
        pass = false;
        failureKind = "CONTENT_LENGTH_MISSING_OR_INVALID";
      }
    }
  } else {
    pass = false;
    if (bytesRead !== MAX_BYTES_READ) {
      failureKind = "INCOMPLETE_READ";
    } else {
      failureKind = "UNKNOWN";
    }
  }

  return {
    actualPlaybackUrlFound: true,
    pass,
    httpStatus,
    contentRangePresent,
    contentRangeValid,
    contentLengthPresent,
    contentLength,
    contentType,
    bytesRead,
    maxBytesRead: MAX_BYTES_READ,
    bodyRead: "YES",
    validationMode,
    failureKind,
  };
}

export interface GmActualPlaybackRangeTestResult {
  actualPlaybackUrlFound: boolean;
  pass?: boolean;
  httpStatus?: number;
  contentRangePresent?: boolean;
  contentRangeValid?: boolean;
  totalFileSizeParsed?: boolean;
  requestAborted?: boolean;
  failureKind?:
    | "NO_PLAYBACK_RESOURCE"
    | "GM_REQUEST_ERROR"
    | "GM_REQUEST_TIMEOUT"
    | "STATUS_NOT_206"
    | "CONTENT_RANGE_MISSING"
    | "CONTENT_RANGE_INVALID";
}

export type GmXmlHttpRequestFn = (details: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  responseType?: string;
  timeout?: number;
  onreadystatechange?: (res: {
    readyState: number;
    status: number;
    statusText?: string;
    responseHeaders?: string;
  }) => void;
  onload?: (res: {
    status: number;
    statusText?: string;
    responseHeaders?: string;
    response?: any;
    responseText?: string;
  }) => void;
  onerror?: (err: any) => void;
  ontimeout?: () => void;
  onabort?: () => void;
}) => { abort: () => void } | void;

export function parseHeaderValue(rawHeaders: string | undefined, headerName: string): string | null {
  if (!rawHeaders) return null;
  const target = headerName.toLowerCase();
  const lines = rawHeaders.split(/[\r\n]+/);
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const k = line.slice(0, colonIdx).trim().toLowerCase();
      if (k === target) {
        return line.slice(colonIdx + 1).trim();
      }
    }
  }
  return null;
}

export function testActualPlaybackGmRange(
  cachedRenditions: AstalaVrRenditionSummary[] = [],
  perf: Performance = typeof performance !== "undefined" ? performance : ({} as any),
  gmFetchFn?: GmXmlHttpRequestFn,
  timeoutMs: number = 10000
): Promise<GmActualPlaybackRangeTestResult> {
  return new Promise((resolve) => {
    const fn: GmXmlHttpRequestFn | undefined =
      gmFetchFn ||
      (typeof (globalThis as any).GM_xmlhttpRequest === "function"
        ? (globalThis as any).GM_xmlhttpRequest
        : typeof (globalThis as any).GM?.xmlHttpRequest === "function"
        ? (globalThis as any).GM.xmlHttpRequest
        : undefined);

    if (!fn) {
      resolve({
        actualPlaybackUrlFound: false,
        pass: false,
        failureKind: "NO_PLAYBACK_RESOURCE",
      });
      return;
    }

    const entries =
      perf && typeof perf.getEntriesByType === "function"
        ? (perf.getEntriesByType("resource") as PerformanceResourceTiming[])
        : [];

    const rendition720p = cachedRenditions.find((r) => r.resolution === "720p" || r.height === 720);
    let cached720pPath = "";
    if (rendition720p) {
      try {
        const cParsed = new URL(rendition720p.fullDirectUrl);
        cached720pPath = cParsed.pathname.toLowerCase();
      } catch {}
    }

    const matchingUrls: string[] = [];
    for (const entry of entries) {
      const rawUrl = entry.name;
      if (!rawUrl || typeof rawUrl !== "string") continue;

      try {
        const parsed = new URL(rawUrl, typeof window !== "undefined" ? window.location.href : "https://astalavr.com");
        const host = parsed.hostname;
        const path = parsed.pathname.toLowerCase();
        const initiator = (entry.initiatorType || "").toLowerCase();

        if (
          (initiator === "video" || initiator === "media") &&
          host === "cdn3.astalavr.com" &&
          cached720pPath &&
          path === cached720pPath
        ) {
          matchingUrls.push(parsed.href);
        }
      } catch {}
    }

    if (matchingUrls.length === 0) {
      resolve({
        actualPlaybackUrlFound: false,
        failureKind: "NO_PLAYBACK_RESOURCE",
      });
      return;
    }

    const latestPlaybackUrl = matchingUrls[matchingUrls.length - 1];

    let settled = false;
    let requestHandle: { abort: () => void } | void;
    let requestAborted = false;

    const safeAbort = () => {
      if (!requestAborted) {
        requestAborted = true;
        try {
          if (requestHandle && typeof requestHandle.abort === "function") {
            requestHandle.abort();
          }
        } catch {}
      }
    };

    const finish = (res: GmActualPlaybackRangeTestResult) => {
      if (!settled) {
        settled = true;
        resolve(res);
      }
    };

    let observedStatus: number | undefined;
    let observedContentRangePresent: boolean | undefined;
    let observedContentRangeValid: boolean | undefined;
    let observedTotalFileSizeParsed: boolean | undefined;

    const validateHeadersAndProcess = (status: number, rawHeaders?: string) => {
      observedStatus = status;

      if (status !== 206) {
        safeAbort();
        finish({
          actualPlaybackUrlFound: true,
          pass: false,
          httpStatus: status,
          requestAborted: true,
          failureKind: "STATUS_NOT_206",
        });
        return;
      }

      const cr = parseHeaderValue(rawHeaders, "content-range");
      const crPresent = Boolean(cr);
      observedContentRangePresent = crPresent;

      if (!crPresent) {
        safeAbort();
        finish({
          actualPlaybackUrlFound: true,
          pass: false,
          httpStatus: status,
          contentRangePresent: false,
          requestAborted: true,
          failureKind: "CONTENT_RANGE_MISSING",
        });
        return;
      }

      // Validate exact bytes 0-0/<positive total>
      const match = cr!.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
      if (!match) {
        safeAbort();
        finish({
          actualPlaybackUrlFound: true,
          pass: false,
          httpStatus: status,
          contentRangePresent: true,
          contentRangeValid: false,
          totalFileSizeParsed: false,
          requestAborted: true,
          failureKind: "CONTENT_RANGE_INVALID",
        });
        return;
      }

      const start = parseInt(match[1], 10);
      const end = parseInt(match[2], 10);
      const total = parseInt(match[3], 10);

      const isValid = start === 0 && end === 0 && !isNaN(total) && total > 1;
      observedContentRangeValid = isValid;
      observedTotalFileSizeParsed = isValid;

      if (!isValid) {
        safeAbort();
        finish({
          actualPlaybackUrlFound: true,
          pass: false,
          httpStatus: status,
          contentRangePresent: true,
          contentRangeValid: false,
          totalFileSizeParsed: false,
          requestAborted: true,
          failureKind: "CONTENT_RANGE_INVALID",
        });
        return;
      }

      // PASS immediately at header state and abort to avoid reading body
      safeAbort();
      finish({
        actualPlaybackUrlFound: true,
        pass: true,
        httpStatus: 206,
        contentRangePresent: true,
        contentRangeValid: true,
        totalFileSizeParsed: true,
        requestAborted: true,
      });
    };

    try {
      requestHandle = fn({
        method: "GET",
        url: latestPlaybackUrl,
        headers: {
          Range: "bytes=0-0",
        },
        responseType: "arraybuffer",
        timeout: timeoutMs,
        onreadystatechange: (res) => {
          if (res.readyState >= 2 && !settled) {
            if (res.status && res.status > 0) {
              validateHeadersAndProcess(res.status, res.responseHeaders);
            }
          }
        },
        onload: (res) => {
          if (settled) return;
          validateHeadersAndProcess(res.status, res.responseHeaders);
        },
        onerror: () => {
          if (!settled) {
            safeAbort();
            finish({
              actualPlaybackUrlFound: true,
              pass: false,
              httpStatus: observedStatus,
              contentRangePresent: observedContentRangePresent,
              contentRangeValid: observedContentRangeValid,
              totalFileSizeParsed: observedTotalFileSizeParsed,
              requestAborted: true,
              failureKind: "GM_REQUEST_ERROR",
            });
          }
        },
        ontimeout: () => {
          if (!settled) {
            safeAbort();
            finish({
              actualPlaybackUrlFound: true,
              pass: false,
              httpStatus: observedStatus,
              contentRangePresent: observedContentRangePresent,
              contentRangeValid: observedContentRangeValid,
              totalFileSizeParsed: observedTotalFileSizeParsed,
              requestAborted: true,
              failureKind: "GM_REQUEST_TIMEOUT",
            });
          }
        },
        onabort: () => {
          if (!settled) {
            finish({
              actualPlaybackUrlFound: true,
              pass: false,
              httpStatus: observedStatus,
              contentRangePresent: observedContentRangePresent,
              contentRangeValid: observedContentRangeValid,
              totalFileSizeParsed: observedTotalFileSizeParsed,
              requestAborted: true,
              failureKind: "GM_REQUEST_ERROR",
            });
          }
        },
      });
    } catch {
      safeAbort();
      finish({
        actualPlaybackUrlFound: true,
        pass: false,
        requestAborted: true,
        failureKind: "GM_REQUEST_ERROR",
      });
    }
  });
}

export interface Paired1MiBRangeTestResult {
  actualPlaybackUrlFound: boolean;
  pass: boolean;
  gmMetadataStatus?: number;
  gmContentRangePresent?: boolean;
  gmContentRangeMatch?: boolean;
  gmTotalFileSizeParsed?: boolean;
  gmAbortedAtHeaders?: boolean;
  pageDataStatus?: number;
  pageContentLengthPresent?: boolean;
  pageContentLengthMatch?: boolean;
  pageBytesRead?: number;
  pageMaxBytesRead: number;
  pairFailureKind?:
    | "NO_PLAYBACK_RESOURCE"
    | "GM_METADATA_FAILED"
    | "PAGE_FETCH_ERROR"
    | "PAGE_STATUS_NOT_206"
    | "PAGE_CONTENT_LENGTH_MISMATCH"
    | "PAGE_BYTES_MISMATCH"
    | "PAGE_STREAM_UNAVAILABLE";
}

export async function testActualPlaybackPaired1MiB(
  cachedRenditions: AstalaVrRenditionSummary[] = [],
  perf: Performance = typeof performance !== "undefined" ? performance : ({} as any),
  gmFetchFn?: GmXmlHttpRequestFn,
  pageFetchFn: typeof fetch = typeof fetch !== "undefined" ? fetch.bind(globalThis) : (null as any),
  timeoutMs: number = 10000
): Promise<Paired1MiBRangeTestResult> {
  const MAX_BYTES = 1048576; // exactly 1 MiB (bytes=0-1048575)

  const entries =
    perf && typeof perf.getEntriesByType === "function"
      ? (perf.getEntriesByType("resource") as PerformanceResourceTiming[])
      : [];

  const rendition720p = cachedRenditions.find((r) => r.resolution === "720p" || r.height === 720);
  let cached720pPath = "";
  if (rendition720p) {
    try {
      const cParsed = new URL(rendition720p.fullDirectUrl);
      cached720pPath = cParsed.pathname.toLowerCase();
    } catch {}
  }

  const matchingUrls: string[] = [];
  for (const entry of entries) {
    const rawUrl = entry.name;
    if (!rawUrl || typeof rawUrl !== "string") continue;

    try {
      const parsed = new URL(rawUrl, typeof window !== "undefined" ? window.location.href : "https://astalavr.com");
      const host = parsed.hostname;
      const path = parsed.pathname.toLowerCase();
      const initiator = (entry.initiatorType || "").toLowerCase();

      if (
        (initiator === "video" || initiator === "media") &&
        host === "cdn3.astalavr.com" &&
        cached720pPath &&
        path === cached720pPath
      ) {
        matchingUrls.push(parsed.href);
      }
    } catch {}
  }

  if (matchingUrls.length === 0) {
    return {
      actualPlaybackUrlFound: false,
      pass: false,
      pageMaxBytesRead: MAX_BYTES,
      pairFailureKind: "NO_PLAYBACK_RESOURCE",
    };
  }

  const latestPlaybackUrl = matchingUrls[matchingUrls.length - 1];

  // ==========================================
  // PHASE A: GM Metadata Request (bytes=0-1048575)
  // ==========================================
  const fn: GmXmlHttpRequestFn | undefined =
    gmFetchFn ||
    (typeof (globalThis as any).GM_xmlhttpRequest === "function"
      ? (globalThis as any).GM_xmlhttpRequest
      : typeof (globalThis as any).GM?.xmlHttpRequest === "function"
      ? (globalThis as any).GM.xmlHttpRequest
      : undefined);

  if (!fn) {
    return {
      actualPlaybackUrlFound: true,
      pass: false,
      pageMaxBytesRead: MAX_BYTES,
      pairFailureKind: "GM_METADATA_FAILED",
    };
  }

  interface GmPhaseAResult {
    pass: boolean;
    status?: number;
    contentRangePresent?: boolean;
    contentRangeMatch?: boolean;
    totalFileSizeParsed?: boolean;
    abortedAtHeaders?: boolean;
  }

  const gmPhaseA: GmPhaseAResult = await new Promise((resolve) => {
    let settled = false;
    let handle: { abort: () => void } | void;
    let aborted = false;

    const safeAbort = () => {
      if (!aborted) {
        aborted = true;
        try {
          if (handle && typeof handle.abort === "function") {
            handle.abort();
          }
        } catch {}
      }
    };

    const finish = (res: GmPhaseAResult) => {
      if (!settled) {
        settled = true;
        resolve(res);
      }
    };

    const validateGmHeaders = (status: number, rawHeaders?: string) => {
      if (status !== 206) {
        safeAbort();
        finish({
          pass: false,
          status,
          abortedAtHeaders: true,
        });
        return;
      }

      const cr = parseHeaderValue(rawHeaders, "content-range");
      const crPresent = Boolean(cr);
      if (!crPresent) {
        safeAbort();
        finish({
          pass: false,
          status,
          contentRangePresent: false,
          abortedAtHeaders: true,
        });
        return;
      }

      // Must be bytes 0-1048575/<positive total>
      const match = cr!.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
      if (!match) {
        safeAbort();
        finish({
          pass: false,
          status,
          contentRangePresent: true,
          contentRangeMatch: false,
          totalFileSizeParsed: false,
          abortedAtHeaders: true,
        });
        return;
      }

      const start = parseInt(match[1], 10);
      const end = parseInt(match[2], 10);
      const total = parseInt(match[3], 10);

      const isMatch = start === 0 && end === 1048575 && !isNaN(total) && total > 1048575;
      if (!isMatch) {
        safeAbort();
        finish({
          pass: false,
          status,
          contentRangePresent: true,
          contentRangeMatch: false,
          totalFileSizeParsed: !isNaN(total) && total > 0,
          abortedAtHeaders: true,
        });
        return;
      }

      safeAbort();
      finish({
        pass: true,
        status: 206,
        contentRangePresent: true,
        contentRangeMatch: true,
        totalFileSizeParsed: true,
        abortedAtHeaders: true,
      });
    };

    try {
      handle = fn({
        method: "GET",
        url: latestPlaybackUrl,
        headers: {
          Range: "bytes=0-1048575",
        },
        responseType: "arraybuffer",
        timeout: timeoutMs,
        onreadystatechange: (res) => {
          if (res.readyState >= 2 && !settled) {
            if (res.status && res.status > 0) {
              validateGmHeaders(res.status, res.responseHeaders);
            }
          }
        },
        onload: (res) => {
          if (!settled) {
            validateGmHeaders(res.status, res.responseHeaders);
          }
        },
        onerror: () => {
          if (!settled) {
            safeAbort();
            finish({ pass: false, abortedAtHeaders: true });
          }
        },
        ontimeout: () => {
          if (!settled) {
            safeAbort();
            finish({ pass: false, abortedAtHeaders: true });
          }
        },
        onabort: () => {
          if (!settled) {
            finish({ pass: false, abortedAtHeaders: true });
          }
        },
      });
    } catch {
      safeAbort();
      finish({ pass: false, abortedAtHeaders: true });
    }
  });

  if (!gmPhaseA.pass) {
    return {
      actualPlaybackUrlFound: true,
      pass: false,
      gmMetadataStatus: gmPhaseA.status,
      gmContentRangePresent: gmPhaseA.contentRangePresent,
      gmContentRangeMatch: gmPhaseA.contentRangeMatch,
      gmTotalFileSizeParsed: gmPhaseA.totalFileSizeParsed,
      gmAbortedAtHeaders: gmPhaseA.abortedAtHeaders,
      pageMaxBytesRead: MAX_BYTES,
      pairFailureKind: "GM_METADATA_FAILED",
    };
  }

  // ==========================================
  // PHASE B: Page Data Request (bytes=0-1048575)
  // ==========================================
  let pageResponse: Response;
  try {
    pageResponse = await pageFetchFn(latestPlaybackUrl, {
      headers: {
        Range: "bytes=0-1048575",
      },
    });
  } catch {
    return {
      actualPlaybackUrlFound: true,
      pass: false,
      gmMetadataStatus: gmPhaseA.status,
      gmContentRangePresent: gmPhaseA.contentRangePresent,
      gmContentRangeMatch: gmPhaseA.contentRangeMatch,
      gmTotalFileSizeParsed: gmPhaseA.totalFileSizeParsed,
      gmAbortedAtHeaders: gmPhaseA.abortedAtHeaders,
      pageMaxBytesRead: MAX_BYTES,
      pairFailureKind: "PAGE_FETCH_ERROR",
    };
  }

  const pageStatus = pageResponse.status;
  const rawContentLength = pageResponse.headers ? pageResponse.headers.get("Content-Length") : null;
  const pageContentLengthPresent = Boolean(rawContentLength !== null && rawContentLength !== undefined);
  const parsedContentLength = rawContentLength !== null ? parseInt(rawContentLength, 10) : NaN;
  const pageContentLengthMatch = pageContentLengthPresent && parsedContentLength === MAX_BYTES;

  if (pageStatus !== 206) {
    try {
      if (pageResponse.body && typeof pageResponse.body.cancel === "function") {
        await pageResponse.body.cancel();
      }
    } catch {}

    return {
      actualPlaybackUrlFound: true,
      pass: false,
      gmMetadataStatus: gmPhaseA.status,
      gmContentRangePresent: gmPhaseA.contentRangePresent,
      gmContentRangeMatch: gmPhaseA.contentRangeMatch,
      gmTotalFileSizeParsed: gmPhaseA.totalFileSizeParsed,
      gmAbortedAtHeaders: gmPhaseA.abortedAtHeaders,
      pageDataStatus: pageStatus,
      pageContentLengthPresent,
      pageContentLengthMatch,
      pageBytesRead: 0,
      pageMaxBytesRead: MAX_BYTES,
      pairFailureKind: "PAGE_STATUS_NOT_206",
    };
  }

  if (!pageContentLengthMatch) {
    try {
      if (pageResponse.body && typeof pageResponse.body.cancel === "function") {
        await pageResponse.body.cancel();
      }
    } catch {}

    return {
      actualPlaybackUrlFound: true,
      pass: false,
      gmMetadataStatus: gmPhaseA.status,
      gmContentRangePresent: gmPhaseA.contentRangePresent,
      gmContentRangeMatch: gmPhaseA.contentRangeMatch,
      gmTotalFileSizeParsed: gmPhaseA.totalFileSizeParsed,
      gmAbortedAtHeaders: gmPhaseA.abortedAtHeaders,
      pageDataStatus: pageStatus,
      pageContentLengthPresent,
      pageContentLengthMatch: false,
      pageBytesRead: 0,
      pageMaxBytesRead: MAX_BYTES,
      pairFailureKind: "PAGE_CONTENT_LENGTH_MISMATCH",
    };
  }

  if (!pageResponse.body) {
    return {
      actualPlaybackUrlFound: true,
      pass: false,
      gmMetadataStatus: gmPhaseA.status,
      gmContentRangePresent: gmPhaseA.contentRangePresent,
      gmContentRangeMatch: gmPhaseA.contentRangeMatch,
      gmTotalFileSizeParsed: gmPhaseA.totalFileSizeParsed,
      gmAbortedAtHeaders: gmPhaseA.abortedAtHeaders,
      pageDataStatus: pageStatus,
      pageContentLengthPresent,
      pageContentLengthMatch,
      pageBytesRead: 0,
      pageMaxBytesRead: MAX_BYTES,
      pairFailureKind: "PAGE_STREAM_UNAVAILABLE",
    };
  }

  let bytesRead = 0;
  const reader = pageResponse.body.getReader();
  try {
    while (bytesRead < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const remaining = MAX_BYTES - bytesRead;
        if (value.byteLength >= remaining) {
          bytesRead += remaining;
          try {
            await reader.cancel();
          } catch {}
          break;
        } else {
          bytesRead += value.byteLength;
        }
      }
    }
  } catch {
    // reader stream exception
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  const pageBytesMatch = bytesRead === MAX_BYTES;

  return {
    actualPlaybackUrlFound: true,
    pass: pageBytesMatch,
    gmMetadataStatus: gmPhaseA.status,
    gmContentRangePresent: gmPhaseA.contentRangePresent,
    gmContentRangeMatch: gmPhaseA.contentRangeMatch,
    gmTotalFileSizeParsed: gmPhaseA.totalFileSizeParsed,
    gmAbortedAtHeaders: gmPhaseA.abortedAtHeaders,
    pageDataStatus: pageStatus,
    pageContentLengthPresent,
    pageContentLengthMatch,
    pageBytesRead: bytesRead,
    pageMaxBytesRead: MAX_BYTES,
    pairFailureKind: pageBytesMatch ? undefined : "PAGE_BYTES_MISMATCH",
  };
}

export interface AstalaVrProxyDownloadProgress {
  bytesWritten: number;
  totalBytes: number;
  percent: number;
}

export type AstalaVrProxyDownloadFailureKind =
  | "NO_PLAYBACK_RESOURCE"
  | "FILE_PICKER_UNAVAILABLE"
  | "FILE_PICKER_CANCELLED"
  | "GM_METADATA_FAILED"
  | "PAGE_FETCH_ERROR"
  | "PAGE_STATUS_NOT_206"
  | "PAGE_CONTENT_LENGTH_MISSING"
  | "PAGE_CONTENT_LENGTH_MISMATCH"
  | "PAGE_STREAM_UNAVAILABLE"
  | "PAGE_BODY_LENGTH_MISMATCH"
  | "FILE_WRITE_ERROR";

export interface AstalaVrProxyDownloadResult {
  pass: boolean;
  bytesWritten: number;
  totalBytes?: number;
  failureKind?: AstalaVrProxyDownloadFailureKind;
}

export async function download720pProxyFile(
  cachedRenditions: AstalaVrRenditionSummary[],
  perfObj: Performance,
  fileHandle: any,
  onProgress?: (p: AstalaVrProxyDownloadProgress) => void,
  customGmFn?: typeof GM_xmlhttpRequest,
  customFetchFn?: typeof fetch
): Promise<AstalaVrProxyDownloadResult> {
  const RANGE_SIZE = 1048576; // 1 MiB proven range size

  const targetRendition = cachedRenditions.find(
    (r) => r.resolution === "720p" || r.height === 720
  );

  if (!targetRendition) {
    return {
      pass: false,
      bytesWritten: 0,
      failureKind: "NO_PLAYBACK_RESOURCE",
    };
  }

  // Find latest actual playback URL matching 720p path
  let latestPlaybackUrl = "";
  try {
    const cachedParsed = new URL(targetRendition.fullDirectUrl);
    const cachedPath = cachedParsed.pathname.toLowerCase();

    const entries =
      perfObj && typeof perfObj.getEntriesByType === "function"
        ? (perfObj.getEntriesByType("resource") as PerformanceResourceTiming[])
        : [];

    let latestTime = -1;
    for (const entry of entries) {
      const rawUrl = entry.name;
      if (!rawUrl || typeof rawUrl !== "string") continue;
      const initiator = (entry.initiatorType || "").toLowerCase();
      if (initiator !== "video" && initiator !== "media") continue;

      let p: URL;
      try {
        p = new URL(rawUrl, typeof window !== "undefined" ? window.location.href : "https://astalavr.com");
      } catch {
        continue;
      }

      if (p.hostname === "cdn3.astalavr.com" && p.pathname.toLowerCase() === cachedPath) {
        const entryTime = entry.responseEnd || entry.startTime || 0;
        if (entryTime >= latestTime) {
          latestTime = entryTime;
          latestPlaybackUrl = rawUrl;
        }
      }
    }
  } catch {}

  if (!latestPlaybackUrl) {
    return {
      pass: false,
      bytesWritten: 0,
      failureKind: "NO_PLAYBACK_RESOURCE",
    };
  }

  let writable: any;
  try {
    writable = await fileHandle.createWritable();
  } catch {
    return {
      pass: false,
      bytesWritten: 0,
      failureKind: "FILE_WRITE_ERROR",
    };
  }

  const safeAbortWritable = async () => {
    try {
      if (writable && typeof writable.abort === "function") {
        await writable.abort();
      }
    } catch {}
  };

  // ==========================================
  // PHASE 1: GM Metadata Plane (bytes=0-0) -> TOTAL
  // ==========================================
  const gmFn =
    customGmFn ||
    (typeof GM_xmlhttpRequest !== "undefined" ? GM_xmlhttpRequest : undefined);

  if (!gmFn) {
    await safeAbortWritable();
    return {
      pass: false,
      bytesWritten: 0,
      failureKind: "GM_METADATA_FAILED",
    };
  }

  interface GmMetaResult {
    pass: boolean;
    totalBytes?: number;
  }

  const gmMeta: GmMetaResult = await new Promise<GmMetaResult>((resolve) => {
    let settled = false;
    let handle: any = null;

    const finish = (res: GmMetaResult) => {
      if (!settled) {
        settled = true;
        resolve(res);
      }
    };

    const safeAbort = () => {
      try {
        if (handle && typeof handle.abort === "function") {
          handle.abort();
        }
      } catch {}
    };

    const validateGmHeaders = (status: number, responseHeaders: string) => {
      safeAbort();
      if (status !== 206) {
        finish({ pass: false });
        return;
      }
      const rawCr = parseHeaderValue(responseHeaders, "content-range");
      if (!rawCr) {
        finish({ pass: false });
        return;
      }
      const m = rawCr.trim().match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
      if (!m) {
        finish({ pass: false });
        return;
      }
      const start = parseInt(m[1], 10);
      const end = parseInt(m[2], 10);
      const total = parseInt(m[3], 10);
      if (start === 0 && end === 0 && total > 0) {
        finish({ pass: true, totalBytes: total });
      } else {
        finish({ pass: false });
      }
    };

    try {
      handle = gmFn({
        method: "GET",
        url: latestPlaybackUrl,
        headers: {
          Range: "bytes=0-0",
        },
        responseType: "arraybuffer",
        timeout: 10000,
        onreadystatechange: (res: any) => {
          if (res.readyState >= 2 && !settled) {
            if (res.status && res.status > 0) {
              validateGmHeaders(res.status, res.responseHeaders || "");
            }
          }
        },
        onload: (res: any) => {
          if (!settled) {
            validateGmHeaders(res.status, res.responseHeaders || "");
          }
        },
        onerror: () => {
          if (!settled) {
            safeAbort();
            finish({ pass: false });
          }
        },
        ontimeout: () => {
          if (!settled) {
            safeAbort();
            finish({ pass: false });
          }
        },
        onabort: () => {
          if (!settled) {
            finish({ pass: false });
          }
        },
      });
    } catch {
      safeAbort();
      finish({ pass: false });
    }
  });

  if (!gmMeta.pass || !gmMeta.totalBytes || gmMeta.totalBytes <= 0) {
    await safeAbortWritable();
    return {
      pass: false,
      bytesWritten: 0,
      failureKind: "GM_METADATA_FAILED",
    };
  }

  const TOTAL = gmMeta.totalBytes;
  const pageFetchFn =
    customFetchFn || (typeof fetch !== "undefined" ? fetch : undefined);

  if (!pageFetchFn) {
    await safeAbortWritable();
    return {
      pass: false,
      bytesWritten: 0,
      totalBytes: TOTAL,
      failureKind: "PAGE_FETCH_ERROR",
    };
  }

  // ==========================================
  // PHASE 2: Sequential Page Fetch Range Stream
  // ==========================================
  let bytesWritten = 0;

  while (bytesWritten < TOTAL) {
    const rangeStart = bytesWritten;
    const rangeEnd = Math.min(rangeStart + RANGE_SIZE - 1, TOTAL - 1);
    const expectedChunkLength = rangeEnd - rangeStart + 1;

    let pageResponse: Response;
    try {
      pageResponse = await pageFetchFn(latestPlaybackUrl, {
        headers: {
          Range: `bytes=${rangeStart}-${rangeEnd}`,
        },
      });
    } catch {
      await safeAbortWritable();
      return {
        pass: false,
        bytesWritten,
        totalBytes: TOTAL,
        failureKind: "PAGE_FETCH_ERROR",
      };
    }

    const safeCancelResponseBody = async () => {
      try {
        if (pageResponse && pageResponse.body && typeof pageResponse.body.cancel === "function") {
          await pageResponse.body.cancel();
        }
      } catch {}
    };

    if (pageResponse.status !== 206) {
      await safeCancelResponseBody();
      await safeAbortWritable();
      return {
        pass: false,
        bytesWritten,
        totalBytes: TOTAL,
        failureKind: "PAGE_STATUS_NOT_206",
      };
    }

    const clRaw = pageResponse.headers.get("content-length") || pageResponse.headers.get("Content-Length");
    if (!clRaw) {
      await safeCancelResponseBody();
      await safeAbortWritable();
      return {
        pass: false,
        bytesWritten,
        totalBytes: TOTAL,
        failureKind: "PAGE_CONTENT_LENGTH_MISSING",
      };
    }

    const parsedCl = parseInt(clRaw.trim(), 10);
    if (isNaN(parsedCl) || parsedCl !== expectedChunkLength) {
      await safeCancelResponseBody();
      await safeAbortWritable();
      return {
        pass: false,
        bytesWritten,
        totalBytes: TOTAL,
        failureKind: "PAGE_CONTENT_LENGTH_MISMATCH",
      };
    }

    if (!pageResponse.body || typeof pageResponse.body.getReader !== "function") {
      await safeAbortWritable();
      return {
        pass: false,
        bytesWritten,
        totalBytes: TOTAL,
        failureKind: "PAGE_STREAM_UNAVAILABLE",
      };
    }

    const reader = pageResponse.body.getReader();
    let rangeBytesRead = 0;

    try {
      while (rangeBytesRead < expectedChunkLength) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          const remainingForChunk = expectedChunkLength - rangeBytesRead;
          let chunkToWrite: Uint8Array;

          if (value.byteLength >= remainingForChunk) {
            chunkToWrite = value.byteLength === remainingForChunk ? value : value.subarray(0, remainingForChunk);
            rangeBytesRead += remainingForChunk;
            try {
              await reader.cancel();
            } catch {}
          } else {
            chunkToWrite = value;
            rangeBytesRead += value.byteLength;
          }

          try {
            await writable.write(chunkToWrite);
          } catch {
            try {
              await reader.cancel();
            } catch {}
            await safeAbortWritable();
            return {
              pass: false,
              bytesWritten,
              totalBytes: TOTAL,
              failureKind: "FILE_WRITE_ERROR",
            };
          }

          if (value.byteLength >= remainingForChunk) {
            break;
          }
        }
      }
    } catch {
      try {
        await reader.cancel();
      } catch {}
      await safeAbortWritable();
      return {
        pass: false,
        bytesWritten,
        totalBytes: TOTAL,
        failureKind: "PAGE_FETCH_ERROR",
      };
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }

    if (rangeBytesRead !== expectedChunkLength) {
      await safeAbortWritable();
      return {
        pass: false,
        bytesWritten,
        totalBytes: TOTAL,
        failureKind: "PAGE_BODY_LENGTH_MISMATCH",
      };
    }

    bytesWritten += rangeBytesRead;
    if (onProgress) {
      onProgress({
        bytesWritten,
        totalBytes: TOTAL,
        percent: Math.min(100, (bytesWritten / TOTAL) * 100),
      });
    }
  }

  if (bytesWritten !== TOTAL) {
    await safeAbortWritable();
    return {
      pass: false,
      bytesWritten,
      totalBytes: TOTAL,
      failureKind: "PAGE_BODY_LENGTH_MISMATCH",
    };
  }

  try {
    await writable.close();
  } catch {
    await safeAbortWritable();
    return {
      pass: false,
      bytesWritten,
      totalBytes: TOTAL,
      failureKind: "FILE_WRITE_ERROR",
    };
  }

  return {
    pass: true,
    bytesWritten,
    totalBytes: TOTAL,
  };
}


