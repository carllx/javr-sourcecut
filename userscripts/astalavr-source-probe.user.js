// ==UserScript==
// @name         AstalaVR Source Probe (javr-sourcecut)
// @namespace    https://github.com/carllx/javr-sourcecut
// @version      0.1.0
// @description  Minimal in-browser DOM rendition reader and diagnostic probe for AstalaVR
// @author       carllx
// @match        https://astalavr.com/videos/*
// @icon         https://astalavr.com/favicon.ico
// @grant        none
// @run-at       document-end
// ==/UserScript==


"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // companion/src/astalavr.ts
  var ASTALAVR_URL_PATTERNS = [
    /(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)?astalavr\.com\/(?:[a-z]{2}\/)?videos\/([a-zA-Z0-9]+)/i
  ];
  function extractAstalaVrVideoId(url) {
    for (const pattern of ASTALAVR_URL_PATTERNS) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  }
  function detectAstalaVrPage(doc = document, currentUrl) {
    const title = (doc.title || "").trim();
    const bodyText = doc.body ? doc.body.innerText || doc.body.textContent || "" : "";
    const isChallenge = title.includes("Just a moment...") || title.includes("Attention Required! | Cloudflare") || bodyText.includes("Checking your browser before accessing") || bodyText.includes("Verify you are human") || bodyText.includes("Enable JavaScript and cookies to continue") || Boolean(doc.querySelector("#challenge-running, #cf-please-wait, #cf-challenge-running"));
    const urlToCheck = currentUrl || (typeof window !== "undefined" ? window.location.href : "");
    const videoIdFromUrl = extractAstalaVrVideoId(urlToCheck);
    const mainVideo = doc.querySelector("main[data-video-id], main");
    const videoId = videoIdFromUrl || mainVideo?.getAttribute("data-video-id") || (doc.querySelector("meta[property='og:url']")?.getAttribute("content") ? extractAstalaVrVideoId(doc.querySelector("meta[property='og:url']").getAttribute("content")) : null);
    const dl8Video = doc.querySelector("dl8-video");
    let status;
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
      videoId: videoId || null
    };
  }
  function parseAstalaVrDomRenditions(root = document, baseHref) {
    const renditions = [];
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
          } catch {
          }
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
      const resolution = height > 0 ? height + "p" : qualityAttr || "unknown";
      const formatId = resolution + "-" + vcodec;
      if (!renditions.some((r) => r.fullDirectUrl === fullDirectUrl)) {
        renditions.push({
          formatId,
          resolution,
          height,
          vcodec,
          mimeType,
          mediaHostname,
          fullDirectUrl
        });
      }
    }
    renditions.sort((a, b) => a.height - b.height);
    return renditions;
  }
  function testBrowserMedia720p(directUrl, timeoutMs = 1e4, doc) {
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
  function inspectActivePlayer(doc = document, cachedRenditions = []) {
    const dl8VideoEl = doc.querySelector("dl8-video");
    let candidateEl = null;
    if (dl8VideoEl) {
      const innerVideo = dl8VideoEl.querySelector("video");
      if (innerVideo) {
        candidateEl = innerVideo;
      } else if (dl8VideoEl.shadowRoot) {
        const shadowVideo = dl8VideoEl.shadowRoot.querySelector("video");
        if (shadowVideo) {
          candidateEl = shadowVideo;
        }
      }
      if (!candidateEl) {
        const elAsAny = dl8VideoEl;
        if (typeof elAsAny.currentSrc === "string" || typeof elAsAny.src === "string" || typeof elAsAny.readyState === "number") {
          candidateEl = dl8VideoEl;
        }
      }
    }
    if (!candidateEl || typeof candidateEl.tagName !== "string") {
      return {
        activePlayerFound: false,
        currentSrcKind: "EMPTY",
        matchedCachedRendition: "NONE"
      };
    }
    const v = candidateEl;
    const rawSrc = v.currentSrc || v.src || v.getAttribute("src") || "";
    let currentSrcKind = "EMPTY";
    let currentSrcHost;
    let currentSrcPath;
    let currentSrcHasToken;
    let matchedCachedRendition = "NONE";
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
          } catch {
          }
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
      duration: typeof v.duration === "number" && !isNaN(v.duration) ? v.duration : void 0,
      videoWidth: typeof v.videoWidth === "number" ? v.videoWidth : void 0,
      videoHeight: typeof v.videoHeight === "number" ? v.videoHeight : void 0,
      currentSrcKind,
      currentSrcHost,
      currentSrcPath,
      currentSrcHasToken,
      matchedCachedRendition
    };
  }
  function inspectPlaybackResources(doc = document, cachedRenditions = [], perf = typeof performance !== "undefined" ? performance : {}) {
    const dl8VideoEl = doc.querySelector("dl8-video");
    const dl8VideoFound = Boolean(dl8VideoEl);
    const dl8ShadowRoot = dl8VideoEl && dl8VideoEl.shadowRoot ? "OPEN" : "UNAVAILABLE";
    const entries = perf && typeof perf.getEntriesByType === "function" ? perf.getEntriesByType("resource") : [];
    const matchedResources = [];
    const rawMatchedUrls = [];
    for (const entry of entries) {
      const rawUrl = entry.name;
      if (!rawUrl || typeof rawUrl !== "string") continue;
      try {
        const parsed = new URL(rawUrl, typeof window !== "undefined" ? window.location.href : "https://astalavr.com");
        const host = parsed.hostname;
        const path = parsed.pathname;
        const entryToken = parsed.searchParams.get("token");
        const hasToken = parsed.searchParams.has("token") || parsed.search.includes("token=");
        let matchedRendition = "NONE";
        let matchedCachedRenditionObj = null;
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
          } catch {
          }
        }
        const isCdn = host === "cdn3.astalavr.com";
        const isRenditionMatch = matchedRendition !== "NONE";
        if (isCdn || isRenditionMatch) {
          let exactCachedUrlMatch = "NO";
          let queryMatch = "NO";
          let tokenMatch = "UNAVAILABLE";
          if (matchedCachedRenditionObj) {
            try {
              const cachedParsed = new URL(matchedCachedRenditionObj.fullDirectUrl);
              const cachedToken = cachedParsed.searchParams.get("token");
              exactCachedUrlMatch = parsed.href === cachedParsed.href ? "YES" : "NO";
              queryMatch = parsed.search === cachedParsed.search ? "YES" : "NO";
              if (entryToken !== null && cachedToken !== null) {
                tokenMatch = entryToken === cachedToken ? "YES" : "NO";
              } else {
                tokenMatch = "UNAVAILABLE";
              }
            } catch {
            }
          }
          let sameFullUrlAsPreviousMatch = "N/A";
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
            transferSize: typeof entry.transferSize === "number" ? entry.transferSize : void 0,
            encodedBodySize: typeof entry.encodedBodySize === "number" ? entry.encodedBodySize : void 0
          });
        }
      } catch {
      }
    }
    return {
      dl8VideoFound,
      dl8ShadowRoot,
      resourceMatchCount: matchedResources.length,
      resources: matchedResources
    };
  }
  async function testActualPlayback720p(cachedRenditions = [], perf = typeof performance !== "undefined" ? performance : {}, doc = typeof document !== "undefined" ? document : null, timeoutMs = 1e4) {
    const targetDoc = doc || (typeof document !== "undefined" ? document : null);
    if (!targetDoc) {
      return {
        actualPlaybackUrlFound: false,
        pass: false,
        errorCode: "NO_DOCUMENT"
      };
    }
    const entries = perf && typeof perf.getEntriesByType === "function" ? perf.getEntriesByType("resource") : [];
    const rendition720p = cachedRenditions.find((r) => r.resolution === "720p" || r.height === 720);
    let cached720pPath = "";
    let cached720pToken = null;
    if (rendition720p) {
      try {
        const cParsed = new URL(rendition720p.fullDirectUrl);
        cached720pPath = cParsed.pathname.toLowerCase();
        cached720pToken = cParsed.searchParams.get("token");
      } catch {
      }
    }
    const matchingUrls = [];
    for (const entry of entries) {
      const rawUrl = entry.name;
      if (!rawUrl || typeof rawUrl !== "string") continue;
      try {
        const parsed = new URL(rawUrl, typeof window !== "undefined" ? window.location.href : "https://astalavr.com");
        const host = parsed.hostname;
        const path = parsed.pathname.toLowerCase();
        const initiator = (entry.initiatorType || "").toLowerCase();
        if ((initiator === "video" || initiator === "media") && host === "cdn3.astalavr.com" && cached720pPath && path === cached720pPath) {
          matchingUrls.push(parsed.href);
        }
      } catch {
      }
    }
    if (matchingUrls.length === 0) {
      return {
        actualPlaybackUrlFound: false
      };
    }
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
    } catch {
    }
    const mediaRes = await testBrowserMedia720p(latestPlaybackUrl, timeoutMs, targetDoc);
    return {
      actualPlaybackUrlFound: true,
      pass: mediaRes.pass,
      duration: mediaRes.duration,
      errorCode: mediaRes.errorCode,
      pathMatch,
      tokenDiffersFromDom
    };
  }
  async function testActualPlayback720pRange(cachedRenditions = [], perf = typeof performance !== "undefined" ? performance : {}, fetchFn = typeof fetch !== "undefined" ? fetch.bind(globalThis) : null) {
    const MAX_BYTES_READ = 1048576;
    const entries = perf && typeof perf.getEntriesByType === "function" ? perf.getEntriesByType("resource") : [];
    const rendition720p = cachedRenditions.find((r) => r.resolution === "720p" || r.height === 720);
    let cached720pPath = "";
    if (rendition720p) {
      try {
        const cParsed = new URL(rendition720p.fullDirectUrl);
        cached720pPath = cParsed.pathname.toLowerCase();
      } catch {
      }
    }
    const matchingUrls = [];
    for (const entry of entries) {
      const rawUrl = entry.name;
      if (!rawUrl || typeof rawUrl !== "string") continue;
      try {
        const parsed = new URL(rawUrl, typeof window !== "undefined" ? window.location.href : "https://astalavr.com");
        const host = parsed.hostname;
        const path = parsed.pathname.toLowerCase();
        const initiator = (entry.initiatorType || "").toLowerCase();
        if ((initiator === "video" || initiator === "media") && host === "cdn3.astalavr.com" && cached720pPath && path === cached720pPath) {
          matchingUrls.push(parsed.href);
        }
      } catch {
      }
    }
    if (matchingUrls.length === 0) {
      return {
        actualPlaybackUrlFound: false,
        maxBytesRead: MAX_BYTES_READ
      };
    }
    const latestPlaybackUrl = matchingUrls[matchingUrls.length - 1];
    let response;
    try {
      response = await fetchFn(latestPlaybackUrl, {
        headers: {
          Range: "bytes=0-1048575"
        }
      });
    } catch (err) {
      const errorName = (err && typeof err.name === "string" ? err.name : "FetchError") || "FetchError";
      return {
        actualPlaybackUrlFound: true,
        pass: false,
        failureKind: "FETCH_ERROR",
        errorName,
        maxBytesRead: MAX_BYTES_READ
      };
    }
    const httpStatus = response.status;
    const contentRangeHeader = response.headers ? response.headers.get("Content-Range") : null;
    const contentRangePresent = Boolean(contentRangeHeader);
    const contentRangeValid = Boolean(
      contentRangeHeader && /^bytes\s+0-1048575\//i.test(contentRangeHeader.trim())
    );
    const contentLength = response.headers ? response.headers.get("Content-Length") : null;
    const contentLengthPresent = Boolean(contentLength !== null && contentLength !== void 0);
    const contentType = response.headers ? response.headers.get("Content-Type") : null;
    if (httpStatus !== 206) {
      try {
        if (response.body && typeof response.body.cancel === "function") {
          await response.body.cancel();
        }
      } catch {
      }
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
        maxBytesRead: MAX_BYTES_READ
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
        maxBytesRead: MAX_BYTES_READ
      };
    }
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
            } catch {
            }
            break;
          } else {
            bytesRead += value.byteLength;
          }
        }
      }
    } catch {
    } finally {
      try {
        reader.releaseLock();
      } catch {
      }
    }
    let pass = false;
    let validationMode;
    let failureKind;
    if (httpStatus === 206 && bytesRead === MAX_BYTES_READ) {
      if (contentRangePresent) {
        if (contentRangeValid) {
          pass = true;
          validationMode = "CONTENT_RANGE";
        } else {
          pass = false;
          failureKind = "INVALID_CONTENT_RANGE";
        }
      } else {
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
      failureKind
    };
  }

  // companion/src/astalavr-index.ts
  var AstalaVrProbeApp = class {
    constructor() {
      __publicField(this, "panelElement", null);
      __publicField(this, "statusElement", null);
      __publicField(this, "contentElement", null);
      __publicField(this, "pollInterval");
      // Page-local in-memory rendition cache
      __publicField(this, "cachedAssetId", null);
      __publicField(this, "cachedRenditions", []);
      __publicField(this, "isTestingBrowserMedia", false);
    }
    init() {
      this.createPanel();
      this.checkAndRender();
      this.pollInterval = setInterval(() => {
        if (!this.isTestingBrowserMedia) {
          this.checkAndRender();
        }
      }, 1e3);
    }
    createPanel() {
      if (document.getElementById("astalavr-sourcecut-probe-panel")) return;
      const panel = document.createElement("div");
      panel.id = "astalavr-sourcecut-probe-panel";
      panel.style.position = "fixed";
      panel.style.bottom = "20px";
      panel.style.right = "20px";
      panel.style.width = "380px";
      panel.style.backgroundColor = "rgba(20, 24, 33, 0.95)";
      panel.style.color = "#f3f4f6";
      panel.style.border = "1px solid #3b82f6";
      panel.style.borderRadius = "8px";
      panel.style.padding = "14px 16px";
      panel.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
      panel.style.fontSize = "12px";
      panel.style.lineHeight = "1.5";
      panel.style.zIndex = "999999";
      panel.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.5)";
      const header = document.createElement("div");
      header.style.fontWeight = "bold";
      header.style.fontSize = "13px";
      header.style.color = "#60a5fa";
      header.style.marginBottom = "8px";
      header.style.display = "flex";
      header.style.justifyContent = "space-between";
      header.style.alignItems = "center";
      header.textContent = "ASTALAVR SOURCECUT PROBE";
      const closeBtn = document.createElement("button");
      closeBtn.textContent = "\xD7";
      closeBtn.style.background = "none";
      closeBtn.style.border = "none";
      closeBtn.style.color = "#9ca3af";
      closeBtn.style.fontSize = "16px";
      closeBtn.style.cursor = "pointer";
      closeBtn.onclick = () => this.destroy();
      header.appendChild(closeBtn);
      const statusEl = document.createElement("div");
      statusEl.id = "astalavr-probe-status";
      statusEl.style.marginBottom = "8px";
      statusEl.style.padding = "4px 8px";
      statusEl.style.borderRadius = "4px";
      statusEl.style.backgroundColor = "#374151";
      const contentEl = document.createElement("div");
      contentEl.id = "astalavr-probe-content";
      panel.appendChild(header);
      panel.appendChild(statusEl);
      panel.appendChild(contentEl);
      document.body.appendChild(panel);
      this.panelElement = panel;
      this.statusElement = statusEl;
      this.contentElement = contentEl;
    }
    checkAndRender() {
      if (!this.statusElement || !this.contentElement) return;
      const detection = detectAstalaVrPage(document);
      const assetId = detection.videoId || "unknown";
      if (this.cachedAssetId && this.cachedAssetId !== assetId) {
        this.cachedAssetId = null;
        this.cachedRenditions = [];
      }
      if (detection.status === "WAITING_FOR_REAL_PAGE") {
        this.statusElement.textContent = "STATUS: WAITING_FOR_REAL_PAGE";
        this.statusElement.style.backgroundColor = "#b45309";
        this.statusElement.style.color = "#fef3c7";
        this.contentElement.innerHTML = `<div style="color: #9ca3af;">Cloudflare challenge / verification active.<br>Awaiting manual challenge resolution...</div>`;
        return;
      }
      if (detection.status === "WAITING_FOR_VIDEO_DOM") {
        this.statusElement.textContent = "STATUS: WAITING_FOR_VIDEO_DOM";
        this.statusElement.style.backgroundColor = "#4b5563";
        this.statusElement.style.color = "#f3f4f6";
        this.contentElement.innerHTML = `<div style="color: #9ca3af;">Page loaded, waiting for &lt;dl8-video&gt; element...</div>`;
        return;
      }
      const liveRenditions = parseAstalaVrDomRenditions(document);
      let effectiveRenditions = [];
      let renditionSource = "LIVE_DOM";
      if (liveRenditions.length > 0) {
        effectiveRenditions = liveRenditions;
        this.cachedAssetId = assetId;
        this.cachedRenditions = liveRenditions;
        renditionSource = "LIVE_DOM";
      } else if (this.cachedAssetId === assetId && this.cachedRenditions.length > 0) {
        effectiveRenditions = this.cachedRenditions;
        renditionSource = "MEMORY_CACHE";
      } else {
        effectiveRenditions = [];
        renditionSource = "LIVE_DOM";
      }
      this.statusElement.textContent = "STATUS: REAL_PAGE_ACTIVE";
      this.statusElement.style.backgroundColor = "#065f46";
      this.statusElement.style.color = "#d1fae5";
      let html = `
      <div style="margin-bottom: 4px;"><strong>ASSET_ID:</strong> ${assetId}</div>
      <div style="margin-bottom: 4px;"><strong>RENDITION_COUNT:</strong> ${effectiveRenditions.length}</div>
      <div style="margin-bottom: 8px;"><strong>RENDITION_SOURCE:</strong> ${renditionSource}</div>
    `;
      if (effectiveRenditions.length === 0) {
        html += `<div style="color: #f87171;">&lt;dl8-video&gt; found, but no &lt;source&gt; tags rendered yet.</div>`;
      } else {
        html += `<div style="border-top: 1px solid #374151; padding-top: 6px; margin-bottom: 8px;">`;
        for (const r of effectiveRenditions) {
          html += `
          <div style="margin-bottom: 4px; padding: 4px; background: rgba(255,255,255,0.05); border-radius: 4px;">
            <div><span style="color: #34d399; font-weight: bold;">[${r.resolution}]</span> ${r.vcodec} (${r.mimeType})</div>
            <div style="color: #9ca3af; font-size: 11px;">Host: ${r.mediaHostname}</div>
          </div>
        `;
        }
        html += `</div>`;
      }
      this.contentElement.innerHTML = html;
      if (effectiveRenditions.length > 0) {
        const btnContainer = document.createElement("div");
        btnContainer.style.display = "flex";
        btnContainer.style.flexDirection = "column";
        btnContainer.style.gap = "6px";
        btnContainer.style.marginTop = "6px";
        const copyBtn = document.createElement("button");
        copyBtn.textContent = "\u{1F4CB} Copy renditions";
        copyBtn.style.width = "100%";
        copyBtn.style.padding = "6px 12px";
        copyBtn.style.backgroundColor = "#2563eb";
        copyBtn.style.color = "#ffffff";
        copyBtn.style.border = "none";
        copyBtn.style.borderRadius = "4px";
        copyBtn.style.cursor = "pointer";
        copyBtn.style.fontWeight = "bold";
        copyBtn.onclick = () => {
          const payload = JSON.stringify(
            {
              assetId,
              renditions: effectiveRenditions.map((r) => ({
                formatId: r.formatId,
                resolution: r.resolution,
                vcodec: r.vcodec,
                mimeType: r.mimeType,
                mediaHostname: r.mediaHostname,
                directUrl: r.fullDirectUrl
              }))
            },
            null,
            2
          );
          navigator.clipboard.writeText(payload).then(
            () => {
              copyBtn.textContent = "\u2705 Copied to clipboard!";
              setTimeout(() => {
                copyBtn.textContent = "\u{1F4CB} Copy renditions";
              }, 2e3);
            },
            (err) => {
              copyBtn.textContent = "\u274C Copy failed";
              console.error("Clipboard write error:", err);
            }
          );
        };
        const rendition720p = effectiveRenditions.find((r) => r.resolution === "720p" || r.height === 720);
        if (rendition720p) {
          const test720Btn = document.createElement("button");
          test720Btn.id = "astalavr-test-720p-btn";
          test720Btn.textContent = "\u25B6 Test 720p in browser";
          test720Btn.style.width = "100%";
          test720Btn.style.padding = "6px 12px";
          test720Btn.style.backgroundColor = "#4f46e5";
          test720Btn.style.color = "#ffffff";
          test720Btn.style.border = "none";
          test720Btn.style.borderRadius = "4px";
          test720Btn.style.cursor = "pointer";
          test720Btn.style.fontWeight = "bold";
          const resultEl = document.createElement("div");
          resultEl.id = "astalavr-test-720p-result";
          resultEl.style.fontSize = "11px";
          resultEl.style.padding = "4px 8px";
          resultEl.style.borderRadius = "4px";
          resultEl.style.display = "none";
          test720Btn.onclick = () => {
            this.isTestingBrowserMedia = true;
            if (this.pollInterval) {
              clearInterval(this.pollInterval);
              this.pollInterval = void 0;
            }
            test720Btn.disabled = true;
            test720Btn.textContent = "\u23F3 Testing 720p metadata in browser...";
            resultEl.style.display = "none";
            testBrowserMedia720p(rendition720p.fullDirectUrl).then((res) => {
              test720Btn.disabled = false;
              test720Btn.textContent = "\u25B6 Test 720p in browser";
              resultEl.style.display = "block";
              if (res.pass) {
                resultEl.style.backgroundColor = "#065f46";
                resultEl.style.color = "#d1fae5";
                const durStr = typeof res.duration === "number" ? res.duration.toFixed(2) : "unknown";
                resultEl.innerHTML = `<div><strong>720P_BROWSER_MEDIA_TEST=PASS</strong></div><div>DURATION=${durStr}s</div>`;
              } else {
                resultEl.style.backgroundColor = "#7f1d1d";
                resultEl.style.color = "#fee2e2";
                resultEl.innerHTML = `<div><strong>720P_BROWSER_MEDIA_TEST=FAIL</strong></div><div>MEDIA_ERROR_CODE=${res.errorCode || "UNKNOWN"}</div>`;
              }
            });
          };
          btnContainer.appendChild(test720Btn);
          btnContainer.appendChild(resultEl);
        }
        const inspectBtn = document.createElement("button");
        inspectBtn.id = "astalavr-inspect-player-btn";
        inspectBtn.textContent = "\u{1F50D} Inspect active player";
        inspectBtn.style.width = "100%";
        inspectBtn.style.padding = "6px 12px";
        inspectBtn.style.backgroundColor = "#0d9488";
        inspectBtn.style.color = "#ffffff";
        inspectBtn.style.border = "none";
        inspectBtn.style.borderRadius = "4px";
        inspectBtn.style.cursor = "pointer";
        inspectBtn.style.fontWeight = "bold";
        const inspectResultEl = document.createElement("div");
        inspectResultEl.id = "astalavr-inspect-player-result";
        inspectResultEl.style.fontSize = "11px";
        inspectResultEl.style.padding = "6px 8px";
        inspectResultEl.style.borderRadius = "4px";
        inspectResultEl.style.backgroundColor = "#1e293b";
        inspectResultEl.style.color = "#f1f5f9";
        inspectResultEl.style.display = "none";
        inspectResultEl.style.lineHeight = "1.4";
        inspectBtn.onclick = () => {
          this.isTestingBrowserMedia = true;
          if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = void 0;
          }
          const info = inspectActivePlayer(document, effectiveRenditions);
          inspectResultEl.style.display = "block";
          let resultText = `<div><strong>ACTIVE_PLAYER_FOUND=</strong>${info.activePlayerFound ? "YES" : "NO"}</div>`;
          if (info.activePlayerFound) {
            resultText += `<div><strong>TAG_NAME=</strong>${info.tagName || "unknown"}</div>`;
            resultText += `<div><strong>READY_STATE=</strong>${info.readyState ?? "unknown"}</div>`;
            resultText += `<div><strong>NETWORK_STATE=</strong>${info.networkState ?? "unknown"}</div>`;
            resultText += `<div><strong>PAUSED=</strong>${info.paused !== void 0 ? String(info.paused).toUpperCase() : "unknown"}</div>`;
            resultText += `<div><strong>DURATION=</strong>${info.duration !== void 0 ? info.duration.toFixed(2) + "s" : "unknown"}</div>`;
            resultText += `<div><strong>VIDEO_WIDTH=</strong>${info.videoWidth ?? "unknown"}</div>`;
            resultText += `<div><strong>VIDEO_HEIGHT=</strong>${info.videoHeight ?? "unknown"}</div>`;
            resultText += `<div style="margin-top: 4px;"><strong>CURRENT_SRC_KIND=</strong>${info.currentSrcKind}</div>`;
            if (info.currentSrcHost) {
              resultText += `<div><strong>CURRENT_SRC_HOST=</strong>${info.currentSrcHost}</div>`;
            }
            if (info.currentSrcPath) {
              resultText += `<div><strong>CURRENT_SRC_PATH=</strong>${info.currentSrcPath}</div>`;
            }
            if (info.currentSrcHasToken !== void 0) {
              resultText += `<div><strong>CURRENT_SRC_HAS_TOKEN=</strong>${info.currentSrcHasToken ? "YES" : "NO"}</div>`;
            }
            resultText += `<div style="margin-top: 4px; color: #38bdf8;"><strong>MATCHED_CACHED_RENDITION=</strong>${info.matchedCachedRendition}</div>`;
          }
          inspectResultEl.innerHTML = resultText;
        };
        btnContainer.appendChild(inspectBtn);
        btnContainer.appendChild(inspectResultEl);
        const inspectResBtn = document.createElement("button");
        inspectResBtn.id = "astalavr-inspect-resources-btn";
        inspectResBtn.textContent = "\u{1F50D} Inspect playback resources";
        inspectResBtn.style.width = "100%";
        inspectResBtn.style.padding = "6px 12px";
        inspectResBtn.style.backgroundColor = "#0284c7";
        inspectResBtn.style.color = "#ffffff";
        inspectResBtn.style.border = "none";
        inspectResBtn.style.borderRadius = "4px";
        inspectResBtn.style.cursor = "pointer";
        inspectResBtn.style.fontWeight = "bold";
        const inspectResResultEl = document.createElement("div");
        inspectResResultEl.id = "astalavr-inspect-resources-result";
        inspectResResultEl.style.fontSize = "11px";
        inspectResResultEl.style.padding = "6px 8px";
        inspectResResultEl.style.borderRadius = "4px";
        inspectResResultEl.style.backgroundColor = "#1e293b";
        inspectResResultEl.style.color = "#f1f5f9";
        inspectResResultEl.style.display = "none";
        inspectResResultEl.style.lineHeight = "1.4";
        inspectResBtn.onclick = () => {
          this.isTestingBrowserMedia = true;
          if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = void 0;
          }
          const resInfo = inspectPlaybackResources(document, effectiveRenditions);
          inspectResResultEl.style.display = "block";
          let text = `
          <div><strong>DL8_VIDEO_FOUND=</strong>${resInfo.dl8VideoFound ? "YES" : "NO"}</div>
          <div><strong>DL8_SHADOW_ROOT=</strong>${resInfo.dl8ShadowRoot}</div>
          <div style="margin-top: 4px;"><strong>RESOURCE_MATCH_COUNT=</strong>${resInfo.resourceMatchCount}</div>
        `;
          if (resInfo.resources.length > 0) {
            text += `<div style="border-top: 1px solid #334155; margin-top: 4px; padding-top: 4px;">`;
            resInfo.resources.forEach((r, idx) => {
              const n = idx + 1;
              text += `
              <div style="margin-bottom: 6px; padding: 4px; background: rgba(255,255,255,0.03); border-radius: 4px;">
                <div><strong>RESOURCE_${n}_INITIATOR_TYPE=</strong>${r.initiatorType}</div>
                <div><strong>RESOURCE_${n}_HOST=</strong>${r.host}</div>
                <div><strong>RESOURCE_${n}_PATH=</strong>${r.path}</div>
                <div><strong>RESOURCE_${n}_HAS_TOKEN=</strong>${r.hasToken ? "YES" : "NO"}</div>
                <div style="color: #38bdf8;"><strong>RESOURCE_${n}_MATCHED_RENDITION=</strong>${r.matchedRendition}</div>
                <div><strong>RESOURCE_${n}_EXACT_CACHED_URL_MATCH=</strong>${r.exactCachedUrlMatch}</div>
                <div><strong>RESOURCE_${n}_QUERY_MATCH=</strong>${r.queryMatch}</div>
                <div><strong>RESOURCE_${n}_TOKEN_MATCH=</strong>${r.tokenMatch}</div>
                <div><strong>RESOURCE_${n}_SAME_FULL_URL_AS_PREVIOUS_MATCH=</strong>${r.sameFullUrlAsPreviousMatch}</div>
                <div><strong>RESOURCE_${n}_DURATION_MS=</strong>${r.durationMs}</div>
                ${r.transferSize !== void 0 ? `<div><strong>RESOURCE_${n}_TRANSFER_SIZE=</strong>${r.transferSize}</div>` : ""}
                ${r.encodedBodySize !== void 0 ? `<div><strong>RESOURCE_${n}_ENCODED_BODY_SIZE=</strong>${r.encodedBodySize}</div>` : ""}
              </div>
            `;
            });
            text += `</div>`;
          }
          inspectResResultEl.innerHTML = text;
        };
        btnContainer.appendChild(inspectResBtn);
        btnContainer.appendChild(inspectResResultEl);
        const testActualBtn = document.createElement("button");
        testActualBtn.id = "astalavr-test-actual-playback-btn";
        testActualBtn.textContent = "\u25B6 Test actual playback 720p URL";
        testActualBtn.style.width = "100%";
        testActualBtn.style.padding = "6px 12px";
        testActualBtn.style.backgroundColor = "#7c3aed";
        testActualBtn.style.color = "#ffffff";
        testActualBtn.style.border = "none";
        testActualBtn.style.borderRadius = "4px";
        testActualBtn.style.cursor = "pointer";
        testActualBtn.style.fontWeight = "bold";
        const testActualResultEl = document.createElement("div");
        testActualResultEl.id = "astalavr-test-actual-playback-result";
        testActualResultEl.style.fontSize = "11px";
        testActualResultEl.style.padding = "6px 8px";
        testActualResultEl.style.borderRadius = "4px";
        testActualResultEl.style.display = "none";
        testActualResultEl.style.lineHeight = "1.4";
        testActualBtn.onclick = () => {
          this.isTestingBrowserMedia = true;
          if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = void 0;
          }
          testActualBtn.disabled = true;
          testActualBtn.textContent = "\u23F3 Testing actual playback 720p in browser...";
          testActualResultEl.style.display = "none";
          testActualPlayback720p(effectiveRenditions, typeof performance !== "undefined" ? performance : {}, document).then((res) => {
            testActualBtn.disabled = false;
            testActualBtn.textContent = "\u25B6 Test actual playback 720p URL";
            testActualResultEl.style.display = "block";
            if (!res.actualPlaybackUrlFound) {
              testActualResultEl.style.backgroundColor = "#1e293b";
              testActualResultEl.style.color = "#f1f5f9";
              testActualResultEl.innerHTML = `<div><strong>ACTUAL_PLAYBACK_URL_FOUND=</strong>NO</div><div>(No matching video resource found in performance entries yet. Please start playback first.)</div>`;
              return;
            }
            if (res.pass) {
              testActualResultEl.style.backgroundColor = "#065f46";
              testActualResultEl.style.color = "#d1fae5";
              const durStr = typeof res.duration === "number" ? res.duration.toFixed(2) : "unknown";
              testActualResultEl.innerHTML = `
              <div><strong>ACTUAL_PLAYBACK_URL_FOUND=</strong>YES</div>
              <div><strong>ACTUAL_PLAYBACK_720P_TEST=</strong>PASS</div>
              <div><strong>DURATION=</strong>${durStr}s</div>
              <div><strong>ACTUAL_PLAYBACK_PATH_MATCH=</strong>${res.pathMatch ? "YES" : "NO"}</div>
              <div><strong>ACTUAL_PLAYBACK_TOKEN_DIFFERS_FROM_DOM=</strong>${res.tokenDiffersFromDom ? "YES" : "NO"}</div>
            `;
            } else {
              testActualResultEl.style.backgroundColor = "#7f1d1d";
              testActualResultEl.style.color = "#fee2e2";
              testActualResultEl.innerHTML = `
              <div><strong>ACTUAL_PLAYBACK_URL_FOUND=</strong>YES</div>
              <div><strong>ACTUAL_PLAYBACK_720P_TEST=</strong>FAIL</div>
              <div><strong>MEDIA_ERROR_CODE=</strong>${res.errorCode || "UNKNOWN"}</div>
              <div><strong>ACTUAL_PLAYBACK_PATH_MATCH=</strong>${res.pathMatch ? "YES" : "NO"}</div>
              <div><strong>ACTUAL_PLAYBACK_TOKEN_DIFFERS_FROM_DOM=</strong>${res.tokenDiffersFromDom ? "YES" : "NO"}</div>
            `;
            }
          });
        };
        btnContainer.appendChild(testActualBtn);
        btnContainer.appendChild(testActualResultEl);
        const testRangeBtn = document.createElement("button");
        testRangeBtn.id = "astalavr-test-actual-range-btn";
        testRangeBtn.textContent = "\u25B6 Test actual 720p Range";
        testRangeBtn.style.width = "100%";
        testRangeBtn.style.padding = "6px 12px";
        testRangeBtn.style.backgroundColor = "#c026d3";
        testRangeBtn.style.color = "#ffffff";
        testRangeBtn.style.border = "none";
        testRangeBtn.style.borderRadius = "4px";
        testRangeBtn.style.cursor = "pointer";
        testRangeBtn.style.fontWeight = "bold";
        const testRangeResultEl = document.createElement("div");
        testRangeResultEl.id = "astalavr-test-actual-range-result";
        testRangeResultEl.style.fontSize = "11px";
        testRangeResultEl.style.padding = "6px 8px";
        testRangeResultEl.style.borderRadius = "4px";
        testRangeResultEl.style.display = "none";
        testRangeResultEl.style.lineHeight = "1.4";
        testRangeBtn.onclick = () => {
          this.isTestingBrowserMedia = true;
          if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = void 0;
          }
          testRangeBtn.disabled = true;
          testRangeBtn.textContent = "\u23F3 Requesting 1 MiB Range in browser...";
          testRangeResultEl.style.display = "none";
          testActualPlayback720pRange(
            effectiveRenditions,
            typeof performance !== "undefined" ? performance : {}
          ).then((res) => {
            testRangeBtn.disabled = false;
            testRangeBtn.textContent = "\u25B6 Test actual 720p Range";
            testRangeResultEl.style.display = "block";
            if (!res.actualPlaybackUrlFound) {
              testRangeResultEl.style.backgroundColor = "#1e293b";
              testRangeResultEl.style.color = "#f1f5f9";
              testRangeResultEl.innerHTML = `<div><strong>ACTUAL_PLAYBACK_URL_FOUND=</strong>NO</div><div>(No matching video resource found in performance entries yet. Please start playback first.)</div>`;
              return;
            }
            if (res.pass) {
              testRangeResultEl.style.backgroundColor = "#065f46";
              testRangeResultEl.style.color = "#d1fae5";
              testRangeResultEl.innerHTML = `
              <div><strong>ACTUAL_PLAYBACK_URL_FOUND=</strong>YES</div>
              <div><strong>ACTUAL_720P_RANGE_TEST=</strong>PASS</div>
              <div><strong>VALIDATION_MODE=</strong>${res.validationMode || "unknown"}</div>
              <div><strong>HTTP_STATUS=</strong>${res.httpStatus ?? "unknown"}</div>
              <div><strong>CONTENT_RANGE_PRESENT=</strong>${res.contentRangePresent ? "YES" : "NO"}</div>
              <div><strong>CONTENT_LENGTH_PRESENT=</strong>${res.contentLengthPresent ? "YES" : "NO"}</div>
              ${res.contentLength !== null && res.contentLength !== void 0 ? `<div><strong>CONTENT_LENGTH=</strong>${res.contentLength}</div>` : ""}
              ${res.contentType !== null && res.contentType !== void 0 ? `<div><strong>CONTENT_TYPE=</strong>${res.contentType}</div>` : ""}
              <div><strong>BYTES_READ=</strong>${res.bytesRead ?? 0}</div>
              <div><strong>MAX_BYTES_READ=</strong>${res.maxBytesRead}</div>
            `;
            } else {
              testRangeResultEl.style.backgroundColor = "#7f1d1d";
              testRangeResultEl.style.color = "#fee2e2";
              let failDetails = `
              <div><strong>ACTUAL_PLAYBACK_URL_FOUND=</strong>YES</div>
              <div><strong>ACTUAL_720P_RANGE_TEST=</strong>FAIL</div>
            `;
              if (res.failureKind === "FETCH_ERROR") {
                failDetails += `<div><strong>FAILURE_KIND=</strong>FETCH_ERROR</div><div><strong>ERROR_NAME=</strong>${res.errorName || "FetchError"}</div>`;
              } else {
                if (res.failureKind !== void 0) {
                  failDetails += `<div><strong>FAILURE_KIND=</strong>${res.failureKind}</div>`;
                }
                if (res.httpStatus !== void 0) {
                  failDetails += `<div><strong>HTTP_STATUS=</strong>${res.httpStatus}</div>`;
                }
                if (res.bodyRead !== void 0) {
                  failDetails += `<div><strong>BODY_READ=</strong>${res.bodyRead}</div>`;
                }
                if (res.contentRangePresent !== void 0) {
                  failDetails += `<div><strong>CONTENT_RANGE_PRESENT=</strong>${res.contentRangePresent ? "YES" : "NO"}</div>`;
                }
                if (res.contentLengthPresent !== void 0) {
                  failDetails += `<div><strong>CONTENT_LENGTH_PRESENT=</strong>${res.contentLengthPresent ? "YES" : "NO"}</div>`;
                }
                if (res.contentLength !== null && res.contentLength !== void 0) {
                  failDetails += `<div><strong>CONTENT_LENGTH=</strong>${res.contentLength}</div>`;
                }
                if (res.contentType !== null && res.contentType !== void 0) {
                  failDetails += `<div><strong>CONTENT_TYPE=</strong>${res.contentType}</div>`;
                }
                if (res.bytesRead !== void 0) {
                  failDetails += `<div><strong>BYTES_READ=</strong>${res.bytesRead}</div>`;
                }
                failDetails += `<div><strong>MAX_BYTES_READ=</strong>${res.maxBytesRead}</div>`;
              }
              testRangeResultEl.innerHTML = failDetails;
            }
          });
        };
        btnContainer.appendChild(testRangeBtn);
        btnContainer.appendChild(testRangeResultEl);
        btnContainer.appendChild(copyBtn);
        this.contentElement.appendChild(btnContainer);
      }
    }
    destroy() {
      if (this.pollInterval) clearInterval(this.pollInterval);
      this.panelElement?.remove();
    }
  };
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const isAstalaVr = /^astalavr\.com$/i.test(window.location.hostname);
    if (isAstalaVr) {
      const app = new AstalaVrProbeApp();
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => app.init());
      } else {
        app.init();
      }
    }
  }
})();
