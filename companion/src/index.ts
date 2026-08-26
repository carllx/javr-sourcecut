import type { CandidateCard, FilterStats, RenditionProfile } from "./types.js";
import {
  parseCandidateCards,
  applyHardFilter,
  applySoftFilter,
  isNative4kFilterActive,
} from "./card-parser.js";
import { RenditionCacheManager } from "./cache.js";
import { ProbeQueue } from "./probe-queue.js";
import { injectStyles } from "./ui/styles.js";
import { FloatingToolbar } from "./ui/floating-toolbar.js";
import { FormatBadgeRenderer } from "./ui/format-badge.js";

export interface CompanionAppOptions {
  searchQuery?: string;
  cacheManager?: RenditionCacheManager;
}

export class EpornerCompanionApp {
  private cacheManager: RenditionCacheManager;
  private queue: ProbeQueue;
  private toolbar: FloatingToolbar;
  private badgeRenderer: FormatBadgeRenderer;
  private intersectionObserver?: IntersectionObserver;
  private mutationObserver?: MutationObserver;

  private allCandidateCards = new Map<string, CandidateCard>();
  private isHardFilterActive = false;
  private isNative4kPrefilter = false;
  private isSoftFilterActive = false;
  private searchQuery?: string;
  private mutationDebounceTimer?: ReturnType<typeof setTimeout>;

  constructor(options: CompanionAppOptions = {}) {
    this.searchQuery = options.searchQuery;
    this.cacheManager = options.cacheManager || new RenditionCacheManager();
    this.badgeRenderer = new FormatBadgeRenderer({
      onRetry: (videoId) => this.queue.retryManual(videoId),
    });

    this.toolbar = new FloatingToolbar({
      onActivateHardFilter: () => this.handleActivateHardFilter(),
      onToggleSoftFilter: (active) => this.handleToggleSoftFilter(active),
    });

    this.queue = new ProbeQueue({
      concurrency: 2,
      maxAutoRetries: 2,
      cacheManager: this.cacheManager,
      onProfileUpdate: (profile, card) => this.handleProfileUpdate(profile, card),
      onStatsChange: () => this.updateStats(),
    });
  }

  async init(): Promise<void> {
    injectStyles();
    await this.cacheManager.loadCache();

    this.setupIntersectionObserver();
    this.toolbar.mount();

    // Check upstream native 4K filter in URL query
    this.isNative4kPrefilter = isNative4kFilterActive(this.searchQuery);
    if (this.isNative4kPrefilter) {
      this.isHardFilterActive = true;
      this.toolbar.setNative4kActive(true);
    }

    // Initial scan
    this.scanAndProcess(document.body);

    // Watch for dynamic DOM changes (e.g. infinite scroll, pagination)
    this.setupMutationObserver();
  }

  private setupIntersectionObserver(): void {
    if (typeof IntersectionObserver === "undefined") return;

    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        // Strictly gate AV1 probing until Hard Filter is activated
        if (!this.isHardFilterActive) return;

        for (const entry of entries) {
          if (entry.isIntersecting) {
            const cardEl = entry.target as HTMLElement;
            const videoId = cardEl.getAttribute("data-javr-vid");
            if (videoId) {
              this.queue.prioritize(videoId);
            }
          }
        }
      },
      {
        rootMargin: "200px 0px", // Preload cards slightly before entering viewport
        threshold: 0.1,
      }
    );
  }

  private setupMutationObserver(): void {
    if (typeof MutationObserver === "undefined") return;

    this.mutationObserver = new MutationObserver(() => {
      if (this.mutationDebounceTimer) clearTimeout(this.mutationDebounceTimer);
      this.mutationDebounceTimer = setTimeout(() => {
        this.scanAndProcess(document.body);
      }, 150);
    });

    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  scanAndProcess(root: ParentNode = document.body): void {
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

  private registerCandidateCards(cards: CandidateCard[]): void {
    for (const card of cards) {
      if (!this.allCandidateCards.has(card.videoId)) {
        this.allCandidateCards.set(card.videoId, card);
        card.element.setAttribute("data-javr-vid", card.videoId);

        // Mount badge if 4K+
        if (card.is4kPlus) {
          this.badgeRenderer.mountBadge(card);

          if (this.intersectionObserver) {
            this.intersectionObserver.observe(card.element);
          }

          // Enqueue for AV1 probing ONLY if 4K+ hard filter is active
          if (this.isHardFilterActive) {
            this.queue.enqueue(card);
          }
        }
      }
    }
  }

  private handleActivateHardFilter(): void {
    if (this.isHardFilterActive) return;
    this.isHardFilterActive = true;

    // 1. Remove all sub-4K cards currently in DOM
    const currentCards = Array.from(this.allCandidateCards.values());
    const { kept } = applyHardFilter(currentCards);

    // 2. Re-index remaining 4K cards and enqueue for AV1 probing
    this.allCandidateCards.clear();
    for (const card of kept) {
      this.allCandidateCards.set(card.videoId, card);
      this.badgeRenderer.mountBadge(card);
      // Start automatic probing for remaining 4K candidates
      this.queue.enqueue(card);
    }

    this.applyVisibility();
    this.updateStats();
  }

  private handleToggleSoftFilter(active: boolean): void {
    this.isSoftFilterActive = active;
    this.applyVisibility();
  }

  private handleProfileUpdate(profile: RenditionProfile, card: CandidateCard): void {
    card.profile = profile;
    this.badgeRenderer.mountBadge(card, profile);
    this.applyVisibility();
  }

  private applyVisibility(): void {
    const cards = Array.from(this.allCandidateCards.values());
    applySoftFilter(cards, this.isSoftFilterActive);
  }

  private updateStats(): void {
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

    const stats: FilterStats = {
      totalCards: cards.length,
      total4kPlus,
      confirmedAv1,
      confirmed4kAv1,
      confirmedNoAv1,
      probing,
      errorCount,
    };

    this.toolbar.updateStats(stats);
  }

  destroy(): void {
    if (this.mutationDebounceTimer) {
      clearTimeout(this.mutationDebounceTimer);
    }
    this.intersectionObserver?.disconnect();
    this.mutationObserver?.disconnect();
    this.toolbar.getElement().remove();
  }
}

// Auto-boot if running in browser userscript environment
if (typeof window !== "undefined" && typeof document !== "undefined") {
  const isEporner = /eporner\.com/i.test(window.location.hostname);
  if (isEporner || (window as any).__JAVR_COMPANION_AUTOSTART__) {
    const app = new EpornerCompanionApp();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => app.init());
    } else {
      app.init();
    }
  }
}
