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
