// ==UserScript==
// @name         AstalaVR Source Probe (javr-sourcecut)
// @namespace    https://github.com/carllx/javr-sourcecut
// @version      0.1.0
// @description  Minimal in-browser DOM rendition reader and diagnostic probe for AstalaVR
// @author       carllx
// @match        https://astalavr.com/videos/*
// @icon         https://astalavr.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @connect      cdn3.astalavr.com
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
  function parseHeaderValue(rawHeaders, headerName) {
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
  async function testActualPlaybackPaired1MiB(cachedRenditions = [], perf = typeof performance !== "undefined" ? performance : {}, gmFetchFn, pageFetchFn = typeof fetch !== "undefined" ? fetch.bind(globalThis) : null, timeoutMs = 1e4) {
    const MAX_BYTES = 1048576;
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
        pass: false,
        pageMaxBytesRead: MAX_BYTES,
        pairFailureKind: "NO_PLAYBACK_RESOURCE"
      };
    }
    const latestPlaybackUrl = matchingUrls[matchingUrls.length - 1];
    const fn = gmFetchFn || (typeof globalThis.GM_xmlhttpRequest === "function" ? globalThis.GM_xmlhttpRequest : typeof globalThis.GM?.xmlHttpRequest === "function" ? globalThis.GM.xmlHttpRequest : void 0);
    if (!fn) {
      return {
        actualPlaybackUrlFound: true,
        pass: false,
        pageMaxBytesRead: MAX_BYTES,
        pairFailureKind: "GM_METADATA_FAILED"
      };
    }
    const gmPhaseA = await new Promise((resolve) => {
      let settled = false;
      let handle;
      let aborted = false;
      const safeAbort = () => {
        if (!aborted) {
          aborted = true;
          try {
            if (handle && typeof handle.abort === "function") {
              handle.abort();
            }
          } catch {
          }
        }
      };
      const finish = (res) => {
        if (!settled) {
          settled = true;
          resolve(res);
        }
      };
      const validateGmHeaders = (status, rawHeaders) => {
        if (status !== 206) {
          safeAbort();
          finish({
            pass: false,
            status,
            abortedAtHeaders: true
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
            abortedAtHeaders: true
          });
          return;
        }
        const match = cr.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
        if (!match) {
          safeAbort();
          finish({
            pass: false,
            status,
            contentRangePresent: true,
            contentRangeMatch: false,
            totalFileSizeParsed: false,
            abortedAtHeaders: true
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
            abortedAtHeaders: true
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
          abortedAtHeaders: true
        });
      };
      try {
        handle = fn({
          method: "GET",
          url: latestPlaybackUrl,
          headers: {
            Range: "bytes=0-1048575"
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
          }
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
        pairFailureKind: "GM_METADATA_FAILED"
      };
    }
    let pageResponse;
    try {
      pageResponse = await pageFetchFn(latestPlaybackUrl, {
        headers: {
          Range: "bytes=0-1048575"
        }
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
        pairFailureKind: "PAGE_FETCH_ERROR"
      };
    }
    const pageStatus = pageResponse.status;
    const rawContentLength = pageResponse.headers ? pageResponse.headers.get("Content-Length") : null;
    const pageContentLengthPresent = Boolean(rawContentLength !== null && rawContentLength !== void 0);
    const parsedContentLength = rawContentLength !== null ? parseInt(rawContentLength, 10) : NaN;
    const pageContentLengthMatch = pageContentLengthPresent && parsedContentLength === MAX_BYTES;
    if (pageStatus !== 206) {
      try {
        if (pageResponse.body && typeof pageResponse.body.cancel === "function") {
          await pageResponse.body.cancel();
        }
      } catch {
      }
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
        pairFailureKind: "PAGE_STATUS_NOT_206"
      };
    }
    if (!pageContentLengthMatch) {
      try {
        if (pageResponse.body && typeof pageResponse.body.cancel === "function") {
          await pageResponse.body.cancel();
        }
      } catch {
      }
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
        pairFailureKind: "PAGE_CONTENT_LENGTH_MISMATCH"
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
        pairFailureKind: "PAGE_STREAM_UNAVAILABLE"
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
      pairFailureKind: pageBytesMatch ? void 0 : "PAGE_BYTES_MISMATCH"
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
      // Ephemeral in-memory transport verification state for current page session
      __publicField(this, "transportVerificationState", "UNTESTED");
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
      const perfEntries = typeof performance !== "undefined" && typeof performance.getEntriesByType === "function" ? performance.getEntriesByType("resource") : [];
      let actualPlaybackDetected = false;
      const rendition720p = effectiveRenditions.find((r) => r.resolution === "720p" || r.height === 720);
      if (rendition720p) {
        try {
          const cParsed = new URL(rendition720p.fullDirectUrl);
          const cachedPath = cParsed.pathname.toLowerCase();
          for (const entry of perfEntries) {
            const rawUrl = entry.name;
            if (rawUrl && typeof rawUrl === "string") {
              const p = new URL(rawUrl, typeof window !== "undefined" ? window.location.href : "https://astalavr.com");
              const initiator = (entry.initiatorType || "").toLowerCase();
              if ((initiator === "video" || initiator === "media") && p.hostname === "cdn3.astalavr.com" && p.pathname.toLowerCase() === cachedPath) {
                actualPlaybackDetected = true;
                break;
              }
            }
          }
        } catch {
        }
      }
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
        const controlMetaStatus = this.transportVerificationState;
        const rangeDataStatus = this.transportVerificationState;
        html += `
        <div id="astalavr-transport-status-section" style="border-top: 1px solid #374151; padding-top: 6px; margin-bottom: 8px;">
          <div style="font-weight: bold; color: #60a5fa; margin-bottom: 4px;">Browser transport</div>
          <div style="font-size: 11px; line-height: 1.6;">
            <div id="astalavr-transport-actual-status">Actual playback: <strong>${actualPlaybackDetected ? "DETECTED" : "WAITING"}</strong></div>
            <div id="astalavr-transport-control-status">Control metadata: <strong>${controlMetaStatus}</strong></div>
            <div id="astalavr-transport-range-status">Range data: <strong>${rangeDataStatus}</strong></div>
          </div>
        </div>
      `;
      }
      this.contentElement.innerHTML = html;
      if (effectiveRenditions.length > 0) {
        const devDetails = document.createElement("details");
        devDetails.id = "astalavr-dev-diagnostics";
        devDetails.style.marginTop = "8px";
        devDetails.style.borderTop = "1px solid #374151";
        devDetails.style.paddingTop = "6px";
        const devSummary = document.createElement("summary");
        devSummary.id = "astalavr-dev-diagnostics-summary";
        devSummary.textContent = "Developer diagnostics";
        devSummary.style.cursor = "pointer";
        devSummary.style.color = "#9ca3af";
        devSummary.style.fontWeight = "bold";
        devSummary.style.fontSize = "11px";
        devSummary.style.userSelect = "none";
        devSummary.style.marginBottom = "6px";
        devDetails.appendChild(devSummary);
        const devContainer = document.createElement("div");
        devContainer.id = "astalavr-dev-diagnostics-content";
        devContainer.style.display = "flex";
        devContainer.style.flexDirection = "column";
        devContainer.style.gap = "6px";
        devContainer.style.marginTop = "6px";
        const testPairBtn = document.createElement("button");
        testPairBtn.id = "astalavr-test-pair-range-btn";
        testPairBtn.textContent = "\u25B6 Test paired 1MiB Range";
        testPairBtn.style.width = "100%";
        testPairBtn.style.padding = "6px 12px";
        testPairBtn.style.backgroundColor = "#d97706";
        testPairBtn.style.color = "#ffffff";
        testPairBtn.style.border = "none";
        testPairBtn.style.borderRadius = "4px";
        testPairBtn.style.cursor = "pointer";
        testPairBtn.style.fontWeight = "bold";
        const testPairResultEl = document.createElement("div");
        testPairResultEl.id = "astalavr-test-pair-range-result";
        testPairResultEl.style.fontSize = "11px";
        testPairResultEl.style.padding = "6px 8px";
        testPairResultEl.style.borderRadius = "4px";
        testPairResultEl.style.display = "none";
        testPairResultEl.style.lineHeight = "1.4";
        const updateTransportStatusLabels = () => {
          const ctrlEl = document.getElementById("astalavr-transport-control-status");
          if (ctrlEl) ctrlEl.innerHTML = `Control metadata: <strong>${this.transportVerificationState}</strong>`;
          const rangeEl = document.getElementById("astalavr-transport-range-status");
          if (rangeEl) rangeEl.innerHTML = `Range data: <strong>${this.transportVerificationState}</strong>`;
        };
        testPairBtn.onclick = () => {
          this.isTestingBrowserMedia = true;
          if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = void 0;
          }
          testPairBtn.disabled = true;
          testPairBtn.textContent = "\u23F3 Testing paired 1MiB (GM metadata + page data)...";
          testPairResultEl.style.display = "none";
          testActualPlaybackPaired1MiB(
            effectiveRenditions,
            typeof performance !== "undefined" ? performance : {}
          ).then((res) => {
            testPairBtn.disabled = false;
            testPairBtn.textContent = "\u25B6 Test paired 1MiB Range";
            testPairResultEl.style.display = "block";
            if (!res.actualPlaybackUrlFound) {
              this.transportVerificationState = "FAILED";
              updateTransportStatusLabels();
              testPairResultEl.style.backgroundColor = "#1e293b";
              testPairResultEl.style.color = "#f1f5f9";
              testPairResultEl.innerHTML = `<div><strong>PAIR_ACTUAL_PLAYBACK_URL_FOUND=</strong>NO</div><div>(No matching video resource found in performance entries yet. Please start playback first.)</div>`;
              return;
            }
            if (res.pass) {
              this.transportVerificationState = "VERIFIED";
              updateTransportStatusLabels();
              testPairResultEl.style.backgroundColor = "#065f46";
              testPairResultEl.style.color = "#d1fae5";
              testPairResultEl.innerHTML = `
              <div><strong>PAIR_ACTUAL_PLAYBACK_URL_FOUND=</strong>YES</div>
              <div><strong>PAIR_RANGE_TEST=</strong>PASS</div>
              <div style="margin-top: 4px; border-top: 1px solid rgba(255,255,255,0.2); padding-top: 2px;"><strong>GM_METADATA_STATUS=</strong>${res.gmMetadataStatus ?? "unknown"}</div>
              <div><strong>GM_CONTENT_RANGE_PRESENT=</strong>${res.gmContentRangePresent ? "YES" : "NO"}</div>
              <div><strong>GM_CONTENT_RANGE_MATCH=</strong>${res.gmContentRangeMatch ? "YES" : "NO"}</div>
              <div><strong>GM_TOTAL_FILE_SIZE_PARSED=</strong>${res.gmTotalFileSizeParsed ? "YES" : "NO"}</div>
              <div><strong>GM_ABORTED_AT_HEADERS=</strong>${res.gmAbortedAtHeaders ? "YES" : "NO"}</div>
              <div style="margin-top: 4px; border-top: 1px solid rgba(255,255,255,0.2); padding-top: 2px;"><strong>PAGE_DATA_STATUS=</strong>${res.pageDataStatus ?? "unknown"}</div>
              <div><strong>PAGE_CONTENT_LENGTH_PRESENT=</strong>${res.pageContentLengthPresent ? "YES" : "NO"}</div>
              <div><strong>PAGE_CONTENT_LENGTH_MATCH=</strong>${res.pageContentLengthMatch ? "YES" : "NO"}</div>
              <div><strong>PAGE_BYTES_READ=</strong>${res.pageBytesRead ?? 0}</div>
              <div><strong>PAGE_MAX_BYTES_READ=</strong>${res.pageMaxBytesRead}</div>
            `;
            } else {
              this.transportVerificationState = "FAILED";
              updateTransportStatusLabels();
              testPairResultEl.style.backgroundColor = "#7f1d1d";
              testPairResultEl.style.color = "#fee2e2";
              let failDetails = `
              <div><strong>PAIR_ACTUAL_PLAYBACK_URL_FOUND=</strong>YES</div>
              <div><strong>PAIR_RANGE_TEST=</strong>FAIL</div>
              <div><strong>PAIR_FAILURE_KIND=</strong>${res.pairFailureKind || "UNKNOWN"}</div>
            `;
              if (res.gmMetadataStatus !== void 0) {
                failDetails += `<div style="margin-top: 4px; border-top: 1px solid rgba(255,255,255,0.2); padding-top: 2px;"><strong>GM_METADATA_STATUS=</strong>${res.gmMetadataStatus}</div>`;
              }
              if (res.gmContentRangePresent !== void 0) {
                failDetails += `<div><strong>GM_CONTENT_RANGE_PRESENT=</strong>${res.gmContentRangePresent ? "YES" : "NO"}</div>`;
              }
              if (res.gmContentRangeMatch !== void 0) {
                failDetails += `<div><strong>GM_CONTENT_RANGE_MATCH=</strong>${res.gmContentRangeMatch ? "YES" : "NO"}</div>`;
              }
              if (res.gmTotalFileSizeParsed !== void 0) {
                failDetails += `<div><strong>GM_TOTAL_FILE_SIZE_PARSED=</strong>${res.gmTotalFileSizeParsed ? "YES" : "NO"}</div>`;
              }
              if (res.gmAbortedAtHeaders !== void 0) {
                failDetails += `<div><strong>GM_ABORTED_AT_HEADERS=</strong>${res.gmAbortedAtHeaders ? "YES" : "NO"}</div>`;
              }
              if (res.pageDataStatus !== void 0) {
                failDetails += `<div style="margin-top: 4px; border-top: 1px solid rgba(255,255,255,0.2); padding-top: 2px;"><strong>PAGE_DATA_STATUS=</strong>${res.pageDataStatus}</div>`;
              }
              if (res.pageContentLengthPresent !== void 0) {
                failDetails += `<div><strong>PAGE_CONTENT_LENGTH_PRESENT=</strong>${res.pageContentLengthPresent ? "YES" : "NO"}</div>`;
              }
              if (res.pageContentLengthMatch !== void 0) {
                failDetails += `<div><strong>PAGE_CONTENT_LENGTH_MATCH=</strong>${res.pageContentLengthMatch ? "YES" : "NO"}</div>`;
              }
              if (res.pageBytesRead !== void 0) {
                failDetails += `<div><strong>PAGE_BYTES_READ=</strong>${res.pageBytesRead}</div>`;
              }
              failDetails += `<div><strong>PAGE_MAX_BYTES_READ=</strong>${res.pageMaxBytesRead}</div>`;
              testPairResultEl.innerHTML = failDetails;
            }
          });
        };
        devContainer.appendChild(testPairBtn);
        devContainer.appendChild(testPairResultEl);
        devDetails.appendChild(devContainer);
        this.contentElement.appendChild(devDetails);
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
