import type { CandidateCard, RenditionProfile } from "../types.js";

export interface FormatBadgeOptions {
  onRetry?: (videoId: string) => void;
}

export class FormatBadgeRenderer {
  private onRetry?: (videoId: string) => void;

  constructor(options: FormatBadgeOptions = {}) {
    this.onRetry = options.onRetry;
  }

  mountBadge(card: CandidateCard, profile?: RenditionProfile): HTMLElement {
    // Find or create badge container inside card
    let badgeEl = card.element.querySelector<HTMLElement>(".javr-card-badge");
    if (!badgeEl) {
      badgeEl = document.createElement("div");
      badgeEl.className = "javr-card-badge";
      
      // Ensure card element is positioned for absolute badge placement
      const computedPos = window.getComputedStyle(card.element).position;
      if (!computedPos || computedPos === "static") {
        card.element.style.position = "relative";
      }

      // Prepend to card thumbnail container or card root
      const thumbContainer = card.element.querySelector(".mbimg, .thumb, .mb5, a") || card.element;
      if (thumbContainer.parentElement === card.element) {
        (thumbContainer as HTMLElement).style.position = "relative";
        thumbContainer.appendChild(badgeEl);
      } else {
        card.element.appendChild(badgeEl);
      }
    }

    this.updateBadge(badgeEl, card, profile || card.profile);
    card.badgeContainer = badgeEl;
    return badgeEl;
  }

  updateBadge(badgeEl: HTMLElement, card: CandidateCard, profile?: RenditionProfile): void {
    if (!profile) {
      badgeEl.className = "javr-card-badge javr-badge-4k-no-av1";
      badgeEl.textContent = "4K";
      badgeEl.onclick = null;
      badgeEl.title = "";
      return;
    }

    // Clear previous onclick
    badgeEl.onclick = null;
    badgeEl.title = "";

    switch (profile.probeStatus) {
      case "detected": {
        if (profile.has4kAv1) {
          badgeEl.className = "javr-card-badge javr-badge-4k-av1-4k";
          badgeEl.textContent = "4K · AV1 4K";
          badgeEl.title = `AV1 Renditions: ${profile.av1Resolutions.join(", ")}`;
        } else {
          const highest = profile.highestAv1Resolution || "AV1";
          badgeEl.className = "javr-card-badge javr-badge-4k-av1-1080p";
          badgeEl.textContent = `4K · AV1 ${highest}`;
          badgeEl.title = `Highest AV1: ${highest} (Available: ${profile.av1Resolutions.join(", ")})`;
        }
        break;
      }
      case "no_av1": {
        badgeEl.className = "javr-card-badge javr-badge-4k-no-av1";
        badgeEl.textContent = "4K · NO AV1";
        badgeEl.title = "No AV1 rendition available (H.264 only)";
        break;
      }
      case "probing": {
        badgeEl.className = "javr-card-badge javr-badge-probing";
        badgeEl.textContent = "4K · ⏳";
        badgeEl.title = "Probing AV1 formats...";
        break;
      }
      case "pending": {
        badgeEl.className = "javr-card-badge javr-badge-4k-no-av1";
        badgeEl.textContent = "4K · ?";
        badgeEl.title = "Waiting to probe format capability";
        break;
      }
      case "error":
      case "unknown":
      default: {
        badgeEl.className = "javr-card-badge javr-badge-error";
        badgeEl.textContent = "4K · ⚠️ 重试";
        badgeEl.title = `${profile.error || "Probe failed"} - 点击重新探测`;
        badgeEl.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.onRetry?.(card.videoId);
        };
        break;
      }
    }
  }
}
