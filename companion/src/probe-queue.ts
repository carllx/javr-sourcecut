import type { CandidateCard, RenditionProfile, Requester } from "./types.js";
import { parseDetailPageHtml } from "./detail-parser.js";
import type { RenditionCacheManager } from "./cache.js";

export class TampermonkeyRequester implements Requester {
  async fetchText(url: string): Promise<string> {
    if (typeof GM_xmlhttpRequest !== "undefined") {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          timeout: 15000,
          headers: {
            "User-Agent": navigator.userAgent,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          onload: (response) => {
            if (response.status >= 200 && response.status < 300) {
              resolve(response.responseText);
            } else {
              reject(new Error(`HTTP ${response.status} ${response.statusText}`));
            }
          },
          onerror: (err) => reject(new Error("Network Error")),
          ontimeout: () => reject(new Error("Request Timeout")),
        });
      });
    }

    // Native fetch fallback
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  }
}

export interface QueueItem {
  card: CandidateCard;
  retryCount: number;
  isHighPriority: boolean;
}

export interface ProbeQueueOptions {
  concurrency?: number;
  maxAutoRetries?: number;
  baseBackoffMs?: number;
  requester?: Requester;
  cacheManager?: RenditionCacheManager;
  onProfileUpdate?: (profile: RenditionProfile, card: CandidateCard) => void;
  onStatsChange?: () => void;
}

export class ProbeQueue {
  private concurrency: number;
  private maxAutoRetries: number;
  private baseBackoffMs: number;
  private requester: Requester;
  private cacheManager?: RenditionCacheManager;
  private onProfileUpdate?: (profile: RenditionProfile, card: CandidateCard) => void;
  private onStatsChange?: () => void;

  private queue: QueueItem[] = [];
  private inFlight = new Set<string>(); // videoIds currently being probed
  private registeredCards = new Map<string, CandidateCard>();
  private activeWorkers = 0;
  private isPaused = false;

  constructor(options: ProbeQueueOptions = {}) {
    this.concurrency = options.concurrency ?? 2;
    this.maxAutoRetries = options.maxAutoRetries ?? 2;
    this.baseBackoffMs = options.baseBackoffMs ?? 300;
    this.requester = options.requester || new TampermonkeyRequester();
    this.cacheManager = options.cacheManager;
    this.onProfileUpdate = options.onProfileUpdate;
    this.onStatsChange = options.onStatsChange;
  }

  enqueue(card: CandidateCard, highPriority = false): void {
    if (!card.is4kPlus) return;

    this.registeredCards.set(card.videoId, card);

    // Check if we already have a cached conclusive result
    if (this.cacheManager) {
      const cached = this.cacheManager.getProfile(card.videoId);
      if (cached && (cached.probeStatus === "detected" || cached.probeStatus === "no_av1")) {
        card.profile = cached;
        this.onProfileUpdate?.(cached, card);
        this.onStatsChange?.();
        return;
      }
    }

    // Avoid duplicate enqueuing if already in flight or queued
    if (this.inFlight.has(card.videoId)) {
      return;
    }

    const existingIndex = this.queue.findIndex((item) => item.card.videoId === card.videoId);
    if (existingIndex >= 0) {
      if (highPriority && !this.queue[existingIndex].isHighPriority) {
        // Move to front
        const [item] = this.queue.splice(existingIndex, 1);
        item.isHighPriority = true;
        this.queue.unshift(item);
      }
      return;
    }

    const item: QueueItem = {
      card,
      retryCount: 0,
      isHighPriority: highPriority,
    };

    if (highPriority) {
      this.queue.unshift(item);
    } else {
      this.queue.push(item);
    }

    // Set initial pending state
    if (!card.profile) {
      card.profile = {
        videoId: card.videoId,
        sourceUrl: card.url,
        maxResolution: card.advertisedResolution,
        av1Resolutions: [],
        highestAv1Resolution: null,
        has4kAv1: false,
        probeStatus: "pending",
      };
      this.onProfileUpdate?.(card.profile, card);
      this.onStatsChange?.();
    }

    this.processQueue();
  }

  /**
   * Prioritize card that entered viewport.
   */
  prioritize(videoId: string): void {
    const card = this.registeredCards.get(videoId);
    if (card) {
      this.enqueue(card, true);
    }
  }

  /**
   * Manual retry triggered by user clicking the error badge.
   * Clears error, resets retries, puts at the very front of the queue.
   */
  retryManual(videoId: string): void {
    const card = this.registeredCards.get(videoId);
    if (!card) return;

    this.inFlight.delete(videoId);

    // Remove any existing queued entry
    this.queue = this.queue.filter((item) => item.card.videoId !== videoId);

    // Reset card profile to pending
    card.profile = {
      videoId: card.videoId,
      sourceUrl: card.url,
      maxResolution: card.advertisedResolution,
      av1Resolutions: [],
      highestAv1Resolution: null,
      has4kAv1: false,
      probeStatus: "pending",
      error: undefined,
    };
    this.onProfileUpdate?.(card.profile, card);
    this.onStatsChange?.();

    // Re-enqueue as high priority
    const item: QueueItem = {
      card,
      retryCount: 0,
      isHighPriority: true,
    };
    this.queue.unshift(item);
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.isPaused) return;

    while (this.activeWorkers < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;

      this.activeWorkers++;
      this.inFlight.add(item.card.videoId);

      // Execute worker asynchronously
      this.executeProbe(item).finally(() => {
        this.activeWorkers--;
        this.inFlight.delete(item.card.videoId);
        this.processQueue();
      });
    }
  }

  private async executeProbe(item: QueueItem): Promise<void> {
    const { card, retryCount } = item;

    // Set status to probing
    card.profile = {
      ...(card.profile || {
        videoId: card.videoId,
        sourceUrl: card.url,
        maxResolution: card.advertisedResolution,
        av1Resolutions: [],
        highestAv1Resolution: null,
        has4kAv1: false,
      }),
      probeStatus: "probing",
      updatedAt: Date.now(),
    };
    this.onProfileUpdate?.(card.profile, card);
    this.onStatsChange?.();

    try {
      const html = await this.requester.fetchText(card.url);
      const profile = parseDetailPageHtml(html, card.videoId, card.url);

      if (profile.probeStatus === "error" || profile.probeStatus === "unknown") {
        throw new Error(profile.error || "Parsing failed");
      }

      // Success: detected or verified no_av1
      card.profile = profile;
      if (this.cacheManager) {
        await this.cacheManager.saveProfile(profile);
      }
      this.onProfileUpdate?.(profile, card);
      this.onStatsChange?.();
    } catch (err: any) {
      const errorMessage = err?.message || String(err);

      if (retryCount < this.maxAutoRetries) {
        // Schedule auto-retry with exponential backoff
        const nextRetry = retryCount + 1;
        const delayMs = this.baseBackoffMs * Math.pow(2, retryCount);

        setTimeout(() => {
          this.queue.unshift({
            card,
            retryCount: nextRetry,
            isHighPriority: true,
          });
          this.processQueue();
        }, delayMs);
      } else {
        // Exhausted auto retries -> settle into Error state
        const errorProfile: RenditionProfile = {
          videoId: card.videoId,
          sourceUrl: card.url,
          maxResolution: card.advertisedResolution,
          av1Resolutions: [],
          highestAv1Resolution: null,
          has4kAv1: false,
          probeStatus: "error",
          error: errorMessage,
          updatedAt: Date.now(),
        };
        card.profile = errorProfile;
        this.onProfileUpdate?.(errorProfile, card);
        this.onStatsChange?.();
      }
    }
  }

  getRegisteredCards(): Map<string, CandidateCard> {
    return this.registeredCards;
  }

  getInFlightCount(): number {
    return this.inFlight.size;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  pause(): void {
    this.isPaused = true;
  }

  resume(): void {
    this.isPaused = false;
    this.processQueue();
  }
}
