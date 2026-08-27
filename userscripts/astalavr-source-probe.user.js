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
    const sources = root.querySelectorAll("dl8-video source, video source, source");
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
      const mimeType = typeAttr || "video/mp4";
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

  // companion/src/astalavr-index.ts
  var AstalaVrProbeApp = class {
    constructor() {
      __publicField(this, "panelElement", null);
      __publicField(this, "statusElement", null);
      __publicField(this, "contentElement", null);
      __publicField(this, "mutationObserver");
      __publicField(this, "pollInterval");
    }
    init() {
      this.createPanel();
      this.checkAndRender();
      if (typeof MutationObserver !== "undefined") {
        this.mutationObserver = new MutationObserver(() => {
          this.checkAndRender();
        });
        this.mutationObserver.observe(document.body || document.documentElement, {
          childList: true,
          subtree: true
        });
      }
      this.pollInterval = setInterval(() => {
        this.checkAndRender();
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
      const renditions = parseAstalaVrDomRenditions(document);
      const assetId = detection.videoId || "unknown";
      this.statusElement.textContent = "STATUS: REAL_PAGE_ACTIVE";
      this.statusElement.style.backgroundColor = "#065f46";
      this.statusElement.style.color = "#d1fae5";
      let html = `
      <div style="margin-bottom: 6px;"><strong>ASSET_ID:</strong> ${assetId}</div>
      <div style="margin-bottom: 8px;"><strong>RENDITION_COUNT:</strong> ${renditions.length}</div>
    `;
      if (renditions.length === 0) {
        html += `<div style="color: #f87171;">&lt;dl8-video&gt; found, but no &lt;source&gt; tags rendered yet.</div>`;
      } else {
        html += `<div style="border-top: 1px solid #374151; padding-top: 6px; margin-bottom: 8px;">`;
        for (const r of renditions) {
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
      if (renditions.length > 0) {
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
        copyBtn.style.marginTop = "4px";
        copyBtn.onclick = () => {
          const payload = JSON.stringify(
            {
              assetId,
              renditions: renditions.map((r) => ({
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
        this.contentElement.appendChild(copyBtn);
      }
    }
    destroy() {
      if (this.pollInterval) clearInterval(this.pollInterval);
      this.mutationObserver?.disconnect();
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
