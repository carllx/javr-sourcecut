// ==UserScript==
// @name         Eporner Companion (javr-sourcecut)
// @namespace    https://github.com/carllx/javr-sourcecut
// @version      0.1.1
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


"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // companion/src/card-parser.ts
  var EPORNER_CARD_SELECTORS = [
    "div.mb",
    "div.mbcontent",
    "div[id^='vf']",
    ".video-box",
    ".mb5"
  ];
  var EPORNER_URL_PATTERNS = [
    /(?:https?:\/\/[^/]+)?\/video-([a-zA-Z0-9]+)/i,
    /(?:https?:\/\/[^/]+)?\/video\/([a-zA-Z0-9]+)/i,
    /(?:https?:\/\/[^/]+)?\/hd-porn\/([a-zA-Z0-9]+)/i
  ];
  function isNative4kFilterActive(searchQuery) {
    try {
      const raw = searchQuery !== void 0 ? searchQuery : typeof window !== "undefined" ? window.location.search : "";
      if (!raw) return false;
      const queryString = raw.includes("?") ? raw.slice(raw.indexOf("?")) : raw;
      const params = new URLSearchParams(queryString);
      return params.get("quality") === "2160";
    } catch {
      return false;
    }
  }
  function extractVideoId(url) {
    for (const pattern of EPORNER_URL_PATTERNS) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  }
  function isResolution4kPlus(text) {
    if (!text) return false;
    const normalized = text.toLowerCase();
    if (/\b(?:4k|5k|6k|8k|2160p|2880p|4320p)\b/i.test(normalized)) {
      return true;
    }
    if (/vr\s*(?:4k|5k|6k|8k|2160p)/i.test(normalized)) {
      return true;
    }
    const kFormatMatch = normalized.match(/(\d+)k\s*\(?(\d+)p\)?/i);
    if (kFormatMatch && kFormatMatch[2]) {
      const p = parseInt(kFormatMatch[2], 10);
      if (p >= 2160) return true;
    }
    const wxMatch = normalized.match(/(\d{3,})x(\d{3,})/i);
    if (wxMatch && wxMatch[2]) {
      const height = parseInt(wxMatch[2], 10);
      if (height >= 2160) return true;
    }
    const heightMatch = normalized.match(/(\d{4,})p?/);
    if (heightMatch && heightMatch[1]) {
      const height = parseInt(heightMatch[1], 10);
      if (height >= 2160) {
        return true;
      }
    }
    return false;
  }
  function extractCardResolution(cardEl) {
    const mvhdico = cardEl.querySelector(".mvhdico");
    if (mvhdico) {
      const spans = mvhdico.querySelectorAll("span");
      const nonVrTexts = [];
      const allTexts = [];
      spans.forEach((s) => {
        const text = s.textContent?.trim();
        if (text) {
          allTexts.push(text);
          if (!s.classList.contains("vrico")) {
            nonVrTexts.push(text);
          }
        }
      });
      if (nonVrTexts.length > 0) {
        return nonVrTexts.join(" ");
      }
      if (allTexts.length > 0) {
        return allTexts.join(" ");
      }
      const directText = mvhdico.textContent?.trim();
      if (directText) {
        return directText;
      }
    }
    const badgeEls = cardEl.querySelectorAll(
      ".mvhd, .mv4k, .mvvr, .mvhdef, .hd-label, .quality, span.mvhdef, span.mvhd, span.mv4k"
    );
    const badgeTexts = [];
    badgeEls.forEach((el) => {
      const t = el.textContent?.trim();
      if (t) badgeTexts.push(t);
    });
    if (badgeTexts.length > 0) {
      return badgeTexts.join(" ");
    }
    const fullText = cardEl.textContent || "";
    const match = fullText.match(
      /\b(4K\s*\(?2160p\)?|4K\s*2160p|4K|2160p|VR\s*4K|VR|1080p\s*60fps|1080p|720p|480p|3840x2160)\b/i
    );
    if (match && match[1]) {
      return match[1].trim();
    }
    return "unknown";
  }
  function parseCandidateCards(root = document) {
    const cardElements = [];
    for (const selector of EPORNER_CARD_SELECTORS) {
      const found = root.querySelectorAll(selector);
      found.forEach((rawEl) => {
        const el = rawEl.closest(".mb, div[id^='vf'], .video-box, .mb5") || rawEl;
        if (!cardElements.includes(el)) {
          cardElements.push(el);
        }
      });
    }
    const results = [];
    const seenVideoIds = /* @__PURE__ */ new Set();
    for (const element of cardElements) {
      const linkEl = element.querySelector(
        "a[href*='/video-'], a[href*='/video/'], a[href*='/hd-porn/'], .mbtit a"
      );
      if (!linkEl) continue;
      const href = linkEl.getAttribute("href") || linkEl.href;
      const videoId = extractVideoId(href);
      if (!videoId || seenVideoIds.has(videoId)) continue;
      seenVideoIds.add(videoId);
      const advertisedResolution = extractCardResolution(element);
      const is4kPlus = isResolution4kPlus(advertisedResolution);
      const url = href.startsWith("http") ? href : `https://www.eporner.com${href.startsWith("/") ? "" : "/"}${href}`;
      results.push({
        videoId,
        url,
        element,
        advertisedResolution,
        is4kPlus
      });
    }
    return results;
  }
  function applyHardFilter(cards) {
    const kept = [];
    let removedCount = 0;
    for (const card of cards) {
      if (card.is4kPlus) {
        kept.push(card);
      } else {
        card.element.remove();
        removedCount++;
      }
    }
    return { kept, removedCount };
  }
  function applySoftFilter(cards, onlyAv1Active, profiles) {
    for (const card of cards) {
      const profile = profiles?.get(card.videoId) || card.profile;
      if (onlyAv1Active) {
        if (profile && profile.probeStatus === "no_av1") {
          card.element.classList.add("javr-soft-hidden");
          card.element.style.setProperty("display", "none", "important");
        } else {
          card.element.classList.remove("javr-soft-hidden");
          card.element.style.removeProperty("display");
        }
      } else {
        card.element.classList.remove("javr-soft-hidden");
        card.element.style.removeProperty("display");
      }
    }
  }

  // companion/src/cache.ts
  var CACHE_STORAGE_KEY = "javr_eporner_av1_cache_v1";
  var CACHE_SCHEMA_VERSION = 1;
  var DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
  function isProfileExpired(profile, ttlMs = DEFAULT_CACHE_TTL_MS, now = Date.now()) {
    if (!profile || typeof profile.updatedAt !== "number" || isNaN(profile.updatedAt) || profile.updatedAt <= 0) {
      return true;
    }
    return now - profile.updatedAt > ttlMs;
  }
  var TampermonkeyStorageAdapter = class {
    async get(key, defaultValue) {
      if (typeof GM_getValue !== "undefined") {
        return GM_getValue(key, defaultValue);
      }
      if (typeof localStorage !== "undefined") {
        const item = localStorage.getItem(key);
        if (item !== null) {
          try {
            return JSON.parse(item);
          } catch {
            return defaultValue;
          }
        }
      }
      return defaultValue;
    }
    async set(key, value) {
      if (typeof GM_setValue !== "undefined") {
        GM_setValue(key, value);
        return;
      }
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(key, JSON.stringify(value));
      }
    }
    async delete(key) {
      if (typeof GM_deleteValue !== "undefined") {
        GM_deleteValue(key);
        return;
      }
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(key);
      }
    }
  };
  var RenditionCacheManager = class {
    constructor(storage, ttlMs = DEFAULT_CACHE_TTL_MS) {
      __publicField(this, "storage");
      __publicField(this, "memoryCache", /* @__PURE__ */ new Map());
      __publicField(this, "isLoaded", false);
      __publicField(this, "ttlMs");
      this.storage = storage || new TampermonkeyStorageAdapter();
      this.ttlMs = ttlMs;
    }
    async loadCache(now = Date.now()) {
      if (this.isLoaded) {
        return this.memoryCache;
      }
      const raw = await this.storage.get(
        CACHE_STORAGE_KEY,
        null
      );
      this.memoryCache.clear();
      if (raw && raw.version === CACHE_SCHEMA_VERSION && raw.profiles) {
        for (const [id, profile] of Object.entries(raw.profiles)) {
          if (profile && (profile.probeStatus === "detected" || profile.probeStatus === "no_av1") && !isProfileExpired(profile, this.ttlMs, now)) {
            this.memoryCache.set(id, profile);
          }
        }
      }
      this.isLoaded = true;
      return this.memoryCache;
    }
    getProfile(videoId, now = Date.now()) {
      const profile = this.memoryCache.get(videoId);
      if (!profile) return void 0;
      if (isProfileExpired(profile, this.ttlMs, now)) {
        this.memoryCache.delete(videoId);
        return void 0;
      }
      return profile;
    }
    async saveProfile(profile) {
      if (profile.probeStatus !== "detected" && profile.probeStatus !== "no_av1") {
        return false;
      }
      const withTimestamp = {
        ...profile,
        updatedAt: profile.updatedAt && profile.updatedAt > 0 ? profile.updatedAt : Date.now()
      };
      this.memoryCache.set(profile.videoId, withTimestamp);
      await this.persist();
      return true;
    }
    async persist() {
      const serialized = {
        version: CACHE_SCHEMA_VERSION,
        profiles: Object.fromEntries(this.memoryCache.entries())
      };
      await this.storage.set(CACHE_STORAGE_KEY, serialized);
    }
    async clear() {
      this.memoryCache.clear();
      if (this.storage.delete) {
        await this.storage.delete(CACHE_STORAGE_KEY);
      } else {
        await this.storage.set(CACHE_STORAGE_KEY, null);
      }
    }
  };

  // companion/src/detail-parser.ts
  function extractLinkRendition(href, linkText, codecClass) {
    let height = 0;
    const resMatch = linkText.match(/(\d+)p/i) || href.match(/\/(\d+)\//) || href.match(/-(\d+)p/i);
    if (resMatch && resMatch[1]) {
      height = parseInt(resMatch[1], 10);
    }
    const isAv1 = codecClass === "av1" || /av1/i.test(linkText) || /-av1\.mp4/i.test(href);
    return { height, isAv1 };
  }
  function parseDetailPageHtml(html, videoId, sourceUrl) {
    if (!html || typeof html !== "string" || html.trim().length === 0) {
      return {
        videoId,
        sourceUrl,
        maxResolution: "unknown",
        av1Resolutions: [],
        highestAv1Resolution: null,
        has4kAv1: false,
        probeStatus: "error",
        error: "Empty HTML response",
        updatedAt: Date.now()
      };
    }
    if (/cf-challenge|checking your browser|attention required|cf-turnstile|access denied|just a moment\.\.\./i.test(
      html
    )) {
      return {
        videoId,
        sourceUrl,
        maxResolution: "unknown",
        av1Resolutions: [],
        highestAv1Resolution: null,
        has4kAv1: false,
        probeStatus: "error",
        error: "Cloudflare/Anti-bot challenge detected",
        updatedAt: Date.now()
      };
    }
    const hasEpornerTitle = /<title>[^<]*eporner[^<]*<\/title>/i.test(html) || /<meta property="og:title"/i.test(html);
    const hasDownloadArea = /id="downloaddiv"/i.test(html) || /class="download-/i.test(html);
    const hasPlayerArea = /id="ep_player"/i.test(html) || /class="player/i.test(html) || /<video/i.test(html);
    if (!hasEpornerTitle && !hasDownloadArea && !hasPlayerArea) {
      return {
        videoId,
        sourceUrl,
        maxResolution: "unknown",
        av1Resolutions: [],
        highestAv1Resolution: null,
        has4kAv1: false,
        probeStatus: "unknown",
        error: "Unrecognized HTML page structure",
        updatedAt: Date.now()
      };
    }
    const downloadLinkRegex = /<span class="download-(av1|h264|webm|other)">\s*(?:or\s*)?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/span>/gi;
    const av1Heights = [];
    const allHeights = [];
    for (const match of html.matchAll(downloadLinkRegex)) {
      const codecClass = match[1].toLowerCase();
      const href = match[2];
      const linkText = match[3].replace(/<[^>]+>/g, "").trim();
      const { height, isAv1 } = extractLinkRendition(href, linkText, codecClass);
      if (height > 0) {
        allHeights.push(height);
        if (isAv1 && !av1Heights.includes(height)) {
          av1Heights.push(height);
        }
      }
    }
    if (allHeights.length === 0) {
      const fallbackLinkRegex = /<a\s+href="([^"]*(?:dload|\/download\/)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
      for (const match of html.matchAll(fallbackLinkRegex)) {
        const href = match[1];
        const linkText = match[2].replace(/<[^>]+>/g, "").trim();
        const { height, isAv1 } = extractLinkRendition(href, linkText);
        if (height > 0) {
          allHeights.push(height);
          if (isAv1 && !av1Heights.includes(height)) {
            av1Heights.push(height);
          }
        }
      }
    }
    av1Heights.sort((a, b) => b - a);
    allHeights.sort((a, b) => b - a);
    const av1Resolutions = av1Heights.map((h) => `${h}p`);
    const highestAv1Resolution = av1Resolutions.length > 0 ? av1Resolutions[0] : null;
    const has4kAv1 = av1Heights.some((h) => h >= 2160);
    const maxResolution = allHeights.length > 0 ? `${allHeights[0]}p` : av1Heights.length > 0 ? `${av1Heights[0]}p` : "unknown";
    let probeStatus = "unknown";
    let errorMsg;
    if (av1Resolutions.length > 0) {
      probeStatus = "detected";
    } else if (allHeights.length > 0) {
      probeStatus = "no_av1";
    } else {
      probeStatus = "unknown";
      errorMsg = "No download rendition links parsed from detail page";
    }
    return {
      videoId,
      sourceUrl,
      maxResolution,
      av1Resolutions,
      highestAv1Resolution,
      has4kAv1,
      probeStatus,
      error: errorMsg,
      updatedAt: Date.now()
    };
  }

  // companion/src/probe-queue.ts
  var TampermonkeyRequester = class {
    async fetchText(url) {
      if (typeof GM_xmlhttpRequest !== "undefined") {
        return new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: "GET",
            url,
            timeout: 15e3,
            headers: {
              "User-Agent": navigator.userAgent,
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            },
            onload: (response) => {
              if (response.status >= 200 && response.status < 300) {
                resolve(response.responseText);
              } else {
                reject(new Error(`HTTP ${response.status} ${response.statusText}`));
              }
            },
            onerror: (err) => reject(new Error("Network Error")),
            ontimeout: () => reject(new Error("Request Timeout"))
          });
        });
      }
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      return await res.text();
    }
  };
  var ProbeQueue = class {
    constructor(options = {}) {
      __publicField(this, "concurrency");
      __publicField(this, "maxAutoRetries");
      __publicField(this, "baseBackoffMs");
      __publicField(this, "requester");
      __publicField(this, "cacheManager");
      __publicField(this, "onProfileUpdate");
      __publicField(this, "onStatsChange");
      __publicField(this, "queue", []);
      __publicField(this, "inFlight", /* @__PURE__ */ new Set());
      // videoIds currently being probed
      __publicField(this, "registeredCards", /* @__PURE__ */ new Map());
      __publicField(this, "activeWorkers", 0);
      __publicField(this, "isPaused", false);
      this.concurrency = options.concurrency ?? 2;
      this.maxAutoRetries = options.maxAutoRetries ?? 2;
      this.baseBackoffMs = options.baseBackoffMs ?? 300;
      this.requester = options.requester || new TampermonkeyRequester();
      this.cacheManager = options.cacheManager;
      this.onProfileUpdate = options.onProfileUpdate;
      this.onStatsChange = options.onStatsChange;
    }
    enqueue(card, highPriority = false) {
      if (!card.is4kPlus) return;
      this.registeredCards.set(card.videoId, card);
      if (this.cacheManager) {
        const cached = this.cacheManager.getProfile(card.videoId);
        if (cached && (cached.probeStatus === "detected" || cached.probeStatus === "no_av1")) {
          card.profile = cached;
          this.onProfileUpdate?.(cached, card);
          this.onStatsChange?.();
          return;
        }
      }
      if (this.inFlight.has(card.videoId)) {
        return;
      }
      const existingIndex = this.queue.findIndex((item2) => item2.card.videoId === card.videoId);
      if (existingIndex >= 0) {
        if (highPriority && !this.queue[existingIndex].isHighPriority) {
          const [item2] = this.queue.splice(existingIndex, 1);
          item2.isHighPriority = true;
          this.queue.unshift(item2);
        }
        return;
      }
      const item = {
        card,
        retryCount: 0,
        isHighPriority: highPriority
      };
      if (highPriority) {
        this.queue.unshift(item);
      } else {
        this.queue.push(item);
      }
      if (!card.profile) {
        card.profile = {
          videoId: card.videoId,
          sourceUrl: card.url,
          maxResolution: card.advertisedResolution,
          av1Resolutions: [],
          highestAv1Resolution: null,
          has4kAv1: false,
          probeStatus: "pending"
        };
        this.onProfileUpdate?.(card.profile, card);
        this.onStatsChange?.();
      }
      this.processQueue();
    }
    /**
     * Prioritize card that entered viewport.
     */
    prioritize(videoId) {
      const card = this.registeredCards.get(videoId);
      if (card) {
        this.enqueue(card, true);
      }
    }
    /**
     * Manual retry triggered by user clicking the error badge.
     * Clears error, resets retries, puts at the very front of the queue.
     */
    retryManual(videoId) {
      const card = this.registeredCards.get(videoId);
      if (!card) return;
      this.inFlight.delete(videoId);
      this.queue = this.queue.filter((item2) => item2.card.videoId !== videoId);
      card.profile = {
        videoId: card.videoId,
        sourceUrl: card.url,
        maxResolution: card.advertisedResolution,
        av1Resolutions: [],
        highestAv1Resolution: null,
        has4kAv1: false,
        probeStatus: "pending",
        error: void 0
      };
      this.onProfileUpdate?.(card.profile, card);
      this.onStatsChange?.();
      const item = {
        card,
        retryCount: 0,
        isHighPriority: true
      };
      this.queue.unshift(item);
      this.processQueue();
    }
    async processQueue() {
      if (this.isPaused) return;
      while (this.activeWorkers < this.concurrency && this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) break;
        this.activeWorkers++;
        this.inFlight.add(item.card.videoId);
        this.executeProbe(item).finally(() => {
          this.activeWorkers--;
          this.inFlight.delete(item.card.videoId);
          this.processQueue();
        });
      }
    }
    async executeProbe(item) {
      const { card, retryCount } = item;
      card.profile = {
        ...card.profile || {
          videoId: card.videoId,
          sourceUrl: card.url,
          maxResolution: card.advertisedResolution,
          av1Resolutions: [],
          highestAv1Resolution: null,
          has4kAv1: false
        },
        probeStatus: "probing",
        updatedAt: Date.now()
      };
      this.onProfileUpdate?.(card.profile, card);
      this.onStatsChange?.();
      try {
        const html = await this.requester.fetchText(card.url);
        const profile = parseDetailPageHtml(html, card.videoId, card.url);
        if (profile.probeStatus === "error" || profile.probeStatus === "unknown") {
          throw new Error(profile.error || "Parsing failed");
        }
        card.profile = profile;
        if (this.cacheManager) {
          await this.cacheManager.saveProfile(profile);
        }
        this.onProfileUpdate?.(profile, card);
        this.onStatsChange?.();
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (retryCount < this.maxAutoRetries) {
          const nextRetry = retryCount + 1;
          const delayMs = this.baseBackoffMs * Math.pow(2, retryCount);
          setTimeout(() => {
            this.queue.unshift({
              card,
              retryCount: nextRetry,
              isHighPriority: true
            });
            this.processQueue();
          }, delayMs);
        } else {
          const errorProfile = {
            videoId: card.videoId,
            sourceUrl: card.url,
            maxResolution: card.advertisedResolution,
            av1Resolutions: [],
            highestAv1Resolution: null,
            has4kAv1: false,
            probeStatus: "error",
            error: errorMessage,
            updatedAt: Date.now()
          };
          card.profile = errorProfile;
          this.onProfileUpdate?.(errorProfile, card);
          this.onStatsChange?.();
        }
      }
    }
    getRegisteredCards() {
      return this.registeredCards;
    }
    getInFlightCount() {
      return this.inFlight.size;
    }
    getQueueLength() {
      return this.queue.length;
    }
    pause() {
      this.isPaused = true;
    }
    resume() {
      this.isPaused = false;
      this.processQueue();
    }
  };

  // companion/src/ui/styles.ts
  var COMPANION_CSS = `
/* Floating Toolbar */
.javr-floating-toolbar {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 999999;
  background: rgba(18, 18, 24, 0.92);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  padding: 12px 16px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.3);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 13px;
  color: #f0f0f5;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 260px;
  user-select: none;
  transition: all 0.2s ease;
}

.javr-toolbar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.5px;
  color: #ffd700;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  padding-bottom: 6px;
}

.javr-toolbar-controls {
  display: flex;
  gap: 8px;
}

.javr-btn {
  flex: 1;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.18);
  color: #fff;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  transition: all 0.15s ease;
}

.javr-btn:hover {
  background: rgba(255, 255, 255, 0.16);
  border-color: rgba(255, 255, 255, 0.35);
}

.javr-btn.active {
  background: #2563eb;
  border-color: #3b82f6;
  color: #ffffff;
  box-shadow: 0 0 10px rgba(59, 130, 246, 0.5);
}

.javr-btn.active-gold {
  background: #b45309;
  border-color: #f59e0b;
  color: #ffffff;
  box-shadow: 0 0 10px rgba(245, 158, 11, 0.5);
}

.javr-stats-line {
  font-size: 11px;
  color: #a0a0b0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  padding-top: 4px;
}

.javr-stat-item {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.javr-stat-val {
  font-weight: 600;
  color: #ffffff;
}

.javr-stat-val.gold { color: #f59e0b; }
.javr-stat-val.green { color: #10b981; }
.javr-stat-val.cyan { color: #06b6d4; }
.javr-stat-val.gray { color: #9ca3af; }
.javr-stat-val.red { color: #ef4444; }

/* In-Card Format Badge */
.javr-card-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 100;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.3px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.6);
  pointer-events: auto;
  transition: all 0.2s ease;
}

.javr-badge-4k-av1-4k {
  background: linear-gradient(135deg, #059669 0%, #10b981 100%);
  color: #ffffff;
  border: 1px solid #34d399;
}

.javr-badge-4k-av1-1080p {
  background: linear-gradient(135deg, #0284c7 0%, #0ea5e9 100%);
  color: #ffffff;
  border: 1px solid #38bdf8;
}

.javr-badge-4k-no-av1 {
  background: rgba(35, 35, 45, 0.85);
  color: #9ca3af;
  border: 1px solid rgba(255, 255, 255, 0.15);
}

.javr-badge-probing {
  background: rgba(30, 41, 59, 0.9);
  color: #38bdf8;
  border: 1px solid #0284c7;
  animation: javr-pulse 1.5s infinite ease-in-out;
}

.javr-badge-error {
  background: rgba(127, 29, 29, 0.9);
  color: #fca5a5;
  border: 1px solid #ef4444;
  cursor: pointer;
}

.javr-badge-error:hover {
  background: #dc2626;
  color: #ffffff;
}

@keyframes javr-pulse {
  0% { opacity: 0.6; }
  50% { opacity: 1; }
  100% { opacity: 0.6; }
}

.javr-soft-hidden {
  display: none !important;
}
`;
  function injectStyles() {
    if (typeof document === "undefined") return;
    const styleId = "javr-companion-styles";
    if (document.getElementById(styleId)) return;
    const styleEl = document.createElement("style");
    styleEl.id = styleId;
    styleEl.textContent = COMPANION_CSS;
    document.head.appendChild(styleEl);
  }

  // companion/src/ui/floating-toolbar.ts
  var FloatingToolbar = class {
    constructor(callbacks = {}) {
      __publicField(this, "container");
      __publicField(this, "hardFilterBtn");
      __publicField(this, "softFilterBtn");
      __publicField(this, "statsContainer");
      __publicField(this, "isHardFilterActive", false);
      __publicField(this, "isNative4kActive", false);
      __publicField(this, "isSoftFilterActive", false);
      __publicField(this, "callbacks");
      this.callbacks = callbacks;
      this.container = document.createElement("div");
      this.container.className = "javr-floating-toolbar";
      this.container.id = "javr-floating-toolbar";
      const header = document.createElement("div");
      header.className = "javr-toolbar-header";
      header.innerHTML = `<span>\u26A1 Eporner Companion</span><span style="font-size:10px;color:#9ca3af;">v0.1.1</span>`;
      this.container.appendChild(header);
      const controls = document.createElement("div");
      controls.className = "javr-toolbar-controls";
      this.hardFilterBtn = document.createElement("button");
      this.hardFilterBtn.className = "javr-btn";
      this.hardFilterBtn.textContent = "\u7B5B\u9009 4K+";
      this.hardFilterBtn.onclick = () => {
        if (this.isHardFilterActive || this.isNative4kActive) return;
        this.isHardFilterActive = true;
        this.updateButtonStates();
        this.callbacks.onActivateHardFilter?.();
      };
      this.softFilterBtn = document.createElement("button");
      this.softFilterBtn.className = "javr-btn";
      this.softFilterBtn.textContent = "\u53EA\u770B AV1";
      this.softFilterBtn.onclick = () => {
        this.isSoftFilterActive = !this.isSoftFilterActive;
        this.updateButtonStates();
        this.callbacks.onToggleSoftFilter?.(this.isSoftFilterActive);
      };
      controls.appendChild(this.hardFilterBtn);
      controls.appendChild(this.softFilterBtn);
      this.container.appendChild(controls);
      this.statsContainer = document.createElement("div");
      this.statsContainer.className = "javr-stats-line";
      this.statsContainer.innerHTML = `<span>\u7B49\u5F85\u7B5B\u9009...</span>`;
      this.container.appendChild(this.statsContainer);
    }
    mount(root = document.body) {
      if (!document.getElementById("javr-floating-toolbar")) {
        root.appendChild(this.container);
      }
    }
    updateStats(stats) {
      this.statsContainer.innerHTML = `
      <div class="javr-stat-item">4K: <span class="javr-stat-val gold">${stats.total4kPlus}</span></div>
      <div class="javr-stat-item">AV1: <span class="javr-stat-val green">${stats.confirmedAv1}</span> (<span class="javr-stat-val cyan">${stats.confirmed4kAv1} 4K</span>)</div>
      ${stats.probing > 0 ? `<div class="javr-stat-item">\u63A2\u6D4B: <span class="javr-stat-val cyan">${stats.probing}</span></div>` : ""}
      ${stats.errorCount > 0 ? `<div class="javr-stat-item">\u5931\u8D25: <span class="javr-stat-val red">${stats.errorCount}</span></div>` : ""}
    `;
    }
    setNative4kActive(active = true) {
      this.isNative4kActive = active;
      if (active) {
        this.isHardFilterActive = true;
      }
      this.updateButtonStates();
    }
    setHardFilterActive(active) {
      this.isHardFilterActive = active;
      this.updateButtonStates();
    }
    setSoftFilterActive(active) {
      this.isSoftFilterActive = active;
      this.updateButtonStates();
    }
    updateButtonStates() {
      if (this.isNative4kActive) {
        this.hardFilterBtn.classList.add("active-gold");
        this.hardFilterBtn.textContent = "\u2713 Eporner 4K+";
        this.hardFilterBtn.disabled = true;
        this.hardFilterBtn.style.cursor = "default";
        this.hardFilterBtn.title = "Eporner \u539F\u751F 4K \u7B5B\u9009\u5DF2\u542F\u7528";
      } else if (this.isHardFilterActive) {
        this.hardFilterBtn.classList.add("active-gold");
        this.hardFilterBtn.textContent = "\u5DF2\u7B5B\u9009 4K+";
        this.hardFilterBtn.disabled = true;
        this.hardFilterBtn.style.cursor = "default";
        this.hardFilterBtn.removeAttribute("title");
      } else {
        this.hardFilterBtn.classList.remove("active-gold");
        this.hardFilterBtn.textContent = "\u7B5B\u9009 4K+";
        this.hardFilterBtn.disabled = false;
        this.hardFilterBtn.style.cursor = "pointer";
        this.hardFilterBtn.removeAttribute("title");
      }
      if (this.isSoftFilterActive) {
        this.softFilterBtn.classList.add("active");
      } else {
        this.softFilterBtn.classList.remove("active");
      }
    }
    getElement() {
      return this.container;
    }
  };

  // companion/src/ui/format-badge.ts
  var FormatBadgeRenderer = class {
    constructor(options = {}) {
      __publicField(this, "onRetry");
      this.onRetry = options.onRetry;
    }
    mountBadge(card, profile) {
      let badgeEl = card.element.querySelector(".javr-card-badge");
      if (!badgeEl) {
        badgeEl = document.createElement("div");
        badgeEl.className = "javr-card-badge";
        const computedPos = window.getComputedStyle(card.element).position;
        if (!computedPos || computedPos === "static") {
          card.element.style.position = "relative";
        }
        const thumbContainer = card.element.querySelector(".mbimg, .thumb, .mb5, a") || card.element;
        if (thumbContainer.parentElement === card.element) {
          thumbContainer.style.position = "relative";
          thumbContainer.appendChild(badgeEl);
        } else {
          card.element.appendChild(badgeEl);
        }
      }
      this.updateBadge(badgeEl, card, profile || card.profile);
      card.badgeContainer = badgeEl;
      return badgeEl;
    }
    updateBadge(badgeEl, card, profile) {
      if (!profile) {
        badgeEl.className = "javr-card-badge javr-badge-4k-no-av1";
        badgeEl.textContent = "4K";
        badgeEl.onclick = null;
        badgeEl.title = "";
        return;
      }
      badgeEl.onclick = null;
      badgeEl.title = "";
      switch (profile.probeStatus) {
        case "detected": {
          if (profile.has4kAv1) {
            badgeEl.className = "javr-card-badge javr-badge-4k-av1-4k";
            badgeEl.textContent = "4K \xB7 AV1 4K";
            badgeEl.title = `AV1 Renditions: ${profile.av1Resolutions.join(", ")}`;
          } else {
            const highest = profile.highestAv1Resolution || "AV1";
            badgeEl.className = "javr-card-badge javr-badge-4k-av1-1080p";
            badgeEl.textContent = `4K \xB7 AV1 ${highest}`;
            badgeEl.title = `Highest AV1: ${highest} (Available: ${profile.av1Resolutions.join(", ")})`;
          }
          break;
        }
        case "no_av1": {
          badgeEl.className = "javr-card-badge javr-badge-4k-no-av1";
          badgeEl.textContent = "4K \xB7 NO AV1";
          badgeEl.title = "No AV1 rendition available (H.264 only)";
          break;
        }
        case "probing": {
          badgeEl.className = "javr-card-badge javr-badge-probing";
          badgeEl.textContent = "4K \xB7 \u23F3";
          badgeEl.title = "Probing AV1 formats...";
          break;
        }
        case "pending": {
          badgeEl.className = "javr-card-badge javr-badge-4k-no-av1";
          badgeEl.textContent = "4K \xB7 ?";
          badgeEl.title = "Waiting to probe format capability";
          break;
        }
        case "error":
        case "unknown":
        default: {
          badgeEl.className = "javr-card-badge javr-badge-error";
          badgeEl.textContent = "4K \xB7 \u26A0\uFE0F \u91CD\u8BD5";
          badgeEl.title = `${profile.error || "Probe failed"} - \u70B9\u51FB\u91CD\u65B0\u63A2\u6D4B`;
          badgeEl.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.onRetry?.(card.videoId);
          };
          break;
        }
      }
    }
  };

  // companion/src/index.ts
  var EpornerCompanionApp = class {
    constructor(options = {}) {
      __publicField(this, "cacheManager");
      __publicField(this, "queue");
      __publicField(this, "toolbar");
      __publicField(this, "badgeRenderer");
      __publicField(this, "intersectionObserver");
      __publicField(this, "mutationObserver");
      __publicField(this, "allCandidateCards", /* @__PURE__ */ new Map());
      __publicField(this, "isHardFilterActive", false);
      __publicField(this, "isNative4kPrefilter", false);
      __publicField(this, "isSoftFilterActive", false);
      __publicField(this, "searchQuery");
      __publicField(this, "mutationDebounceTimer");
      this.searchQuery = options.searchQuery;
      this.cacheManager = options.cacheManager || new RenditionCacheManager();
      this.badgeRenderer = new FormatBadgeRenderer({
        onRetry: (videoId) => this.queue.retryManual(videoId)
      });
      this.toolbar = new FloatingToolbar({
        onActivateHardFilter: () => this.handleActivateHardFilter(),
        onToggleSoftFilter: (active) => this.handleToggleSoftFilter(active)
      });
      this.queue = new ProbeQueue({
        concurrency: 2,
        maxAutoRetries: 2,
        cacheManager: this.cacheManager,
        onProfileUpdate: (profile, card) => this.handleProfileUpdate(profile, card),
        onStatsChange: () => this.updateStats()
      });
    }
    async init() {
      injectStyles();
      await this.cacheManager.loadCache();
      this.setupIntersectionObserver();
      this.toolbar.mount();
      this.isNative4kPrefilter = isNative4kFilterActive(this.searchQuery);
      if (this.isNative4kPrefilter) {
        this.isHardFilterActive = true;
        this.toolbar.setNative4kActive(true);
      }
      this.scanAndProcess(document.body);
      this.setupMutationObserver();
    }
    setupIntersectionObserver() {
      if (typeof IntersectionObserver === "undefined") return;
      this.intersectionObserver = new IntersectionObserver(
        (entries) => {
          if (!this.isHardFilterActive) return;
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const cardEl = entry.target;
              const videoId = cardEl.getAttribute("data-javr-vid");
              if (videoId) {
                this.queue.prioritize(videoId);
              }
            }
          }
        },
        {
          rootMargin: "200px 0px",
          // Preload cards slightly before entering viewport
          threshold: 0.1
        }
      );
    }
    setupMutationObserver() {
      if (typeof MutationObserver === "undefined") return;
      this.mutationObserver = new MutationObserver(() => {
        if (this.mutationDebounceTimer) clearTimeout(this.mutationDebounceTimer);
        this.mutationDebounceTimer = setTimeout(() => {
          this.scanAndProcess(document.body);
        }, 150);
      });
      this.mutationObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
    }
    scanAndProcess(root = document.body) {
      const discovered = parseCandidateCards(root);
      if (this.isHardFilterActive) {
        const { kept } = applyHardFilter(discovered);
        this.registerCandidateCards(kept);
      } else {
        this.registerCandidateCards(discovered);
      }
      this.applyVisibility();
      this.updateStats();
    }
    registerCandidateCards(cards) {
      for (const card of cards) {
        const existing = this.allCandidateCards.get(card.videoId);
        if (existing) {
          existing.element = card.element;
          existing.element.setAttribute("data-javr-vid", card.videoId);
          if (!existing.profile && this.cacheManager) {
            const cached = this.cacheManager.getProfile(card.videoId);
            if (cached) {
              existing.profile = cached;
            }
          }
        } else {
          if (!card.profile && this.cacheManager) {
            const cached = this.cacheManager.getProfile(card.videoId);
            if (cached) {
              card.profile = cached;
            }
          }
          this.allCandidateCards.set(card.videoId, card);
          card.element.setAttribute("data-javr-vid", card.videoId);
          if (card.is4kPlus) {
            this.badgeRenderer.mountBadge(card, card.profile);
            if (this.intersectionObserver) {
              this.intersectionObserver.observe(card.element);
            }
            if (this.isHardFilterActive) {
              this.queue.enqueue(card);
            }
          }
        }
      }
    }
    handleActivateHardFilter() {
      if (this.isHardFilterActive) return;
      this.isHardFilterActive = true;
      const currentCards = Array.from(this.allCandidateCards.values());
      const { kept } = applyHardFilter(currentCards);
      this.allCandidateCards.clear();
      for (const card of kept) {
        this.allCandidateCards.set(card.videoId, card);
        this.badgeRenderer.mountBadge(card, card.profile);
        this.queue.enqueue(card);
      }
      this.applyVisibility();
      this.updateStats();
    }
    handleToggleSoftFilter(active) {
      this.isSoftFilterActive = active;
      this.applyVisibility();
    }
    handleProfileUpdate(profile, card) {
      const canonicalCard = this.allCandidateCards.get(card.videoId) || card;
      canonicalCard.profile = profile;
      card.profile = profile;
      this.badgeRenderer.mountBadge(canonicalCard, profile);
      this.applyVisibility();
      this.updateStats();
    }
    applyVisibility() {
      const cards = Array.from(this.allCandidateCards.values());
      applySoftFilter(cards, this.isSoftFilterActive);
    }
    updateStats() {
      const cards = Array.from(this.allCandidateCards.values());
      const total4kPlus = cards.filter((c) => c.is4kPlus).length;
      let confirmedAv1 = 0;
      let confirmed4kAv1 = 0;
      let confirmedNoAv1 = 0;
      let probing = 0;
      let errorCount = 0;
      for (const card of cards) {
        if (!card.is4kPlus) continue;
        const status = card.profile?.probeStatus;
        if (status === "detected") {
          confirmedAv1++;
          if (card.profile?.has4kAv1) {
            confirmed4kAv1++;
          }
        } else if (status === "no_av1") {
          confirmedNoAv1++;
        } else if (status === "probing") {
          probing++;
        } else if (status === "error") {
          errorCount++;
        }
      }
      const stats = {
        totalCards: cards.length,
        total4kPlus,
        confirmedAv1,
        confirmed4kAv1,
        confirmedNoAv1,
        probing,
        errorCount
      };
      this.toolbar.updateStats(stats);
    }
    destroy() {
      if (this.mutationDebounceTimer) {
        clearTimeout(this.mutationDebounceTimer);
      }
      this.intersectionObserver?.disconnect();
      this.mutationObserver?.disconnect();
      this.toolbar.getElement().remove();
    }
  };
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const isEporner = /eporner\.com/i.test(window.location.hostname);
    if (isEporner || window.__JAVR_COMPANION_AUTOSTART__) {
      const app = new EpornerCompanionApp();
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => app.init());
      } else {
        app.init();
      }
    }
  }
})();
