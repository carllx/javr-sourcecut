import type { CandidateCard, RenditionProfile } from "./types.js";

export const EPORNER_CARD_SELECTORS = [
  "div.mb",
  "div.mbcontent",
  "div[id^='vf']",
  ".video-box",
  ".mb5",
];

const EPORNER_URL_PATTERNS = [
  /(?:https?:\/\/[^/]+)?\/video-([a-zA-Z0-9]+)/i,
  /(?:https?:\/\/[^/]+)?\/video\/([a-zA-Z0-9]+)/i,
  /(?:https?:\/\/[^/]+)?\/hd-porn\/([a-zA-Z0-9]+)/i,
];

/**
 * Extracts Eporner video ID from a relative or absolute URL.
 */
export function extractVideoId(url: string): string | null {
  for (const pattern of EPORNER_URL_PATTERNS) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

/**
 * Determines whether the advertised resolution text meets the 4K+ threshold (>= 2160p).
 */
export function isResolution4kPlus(text: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();

  // Match 4K, 5K, 6K, 8K, 2160p, 2880p, 4320p
  if (/\b(?:4k|5k|6k|8k|2160p|2880p|4320p)\b/i.test(normalized)) {
    return true;
  }
  // Check VR tag with 4K+
  if (/vr\s*(?:4k|5k|6k|8k|2160p)/i.test(normalized)) {
    return true;
  }
  // Match 4K (2160p) format as used in Eporner .mvhdico spans
  const kFormatMatch = normalized.match(/(\d+)k\s*\(?(\d+)p\)?/i);
  if (kFormatMatch && kFormatMatch[2]) {
    const p = parseInt(kFormatMatch[2], 10);
    if (p >= 2160) return true;
  }
  // Match width x height format (e.g. 3840x2160)
  const wxMatch = normalized.match(/(\d{3,})x(\d{3,})/i);
  if (wxMatch && wxMatch[2]) {
    const height = parseInt(wxMatch[2], 10);
    if (height >= 2160) return true;
  }
  // Match explicit numeric heights >= 2160
  const heightMatch = normalized.match(/(\d{4,})p?/);
  if (heightMatch && heightMatch[1]) {
    const height = parseInt(heightMatch[1], 10);
    if (height >= 2160) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts resolution string from a card element.
 * Fully covers legacy .mvhdico containers as well as modern badge classes.
 */
export function extractCardResolution(cardEl: HTMLElement): string {
  // 1. Check legacy .mvhdico container (used on Eporner list pages)
  const mvhdico = cardEl.querySelector(".mvhdico");
  if (mvhdico) {
    const spans = mvhdico.querySelectorAll("span");
    const nonVrTexts: string[] = [];
    const allTexts: string[] = [];
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

  // 2. Check explicit badge classes
  const badgeEls = cardEl.querySelectorAll(
    ".mvhd, .mv4k, .mvvr, .mvhdef, .hd-label, .quality, span.mvhdef, span.mvhd, span.mv4k"
  );
  const badgeTexts: string[] = [];
  badgeEls.forEach((el) => {
    const t = el.textContent?.trim();
    if (t) badgeTexts.push(t);
  });

  if (badgeTexts.length > 0) {
    return badgeTexts.join(" ");
  }

  // 3. Fallback: check all text in card
  const fullText = cardEl.textContent || "";
  const match = fullText.match(
    /\b(4K\s*\(?2160p\)?|4K\s*2160p|4K|2160p|VR\s*4K|VR|1080p\s*60fps|1080p|720p|480p|3840x2160)\b/i
  );
  if (match && match[1]) {
    return match[1].trim();
  }

  return "unknown";
}

/**
 * Finds all candidate card elements in a given root container.
 */
export function parseCandidateCards(root: ParentNode = document): CandidateCard[] {
  const cardElements: HTMLElement[] = [];
  
  // Find matching elements
  for (const selector of EPORNER_CARD_SELECTORS) {
    const found = root.querySelectorAll<HTMLElement>(selector);
    found.forEach((el) => {
      if (!cardElements.includes(el)) {
        cardElements.push(el);
      }
    });
  }

  const results: CandidateCard[] = [];
  const seenVideoIds = new Set<string>();

  for (const element of cardElements) {
    // Find link inside card
    const linkEl = element.querySelector<HTMLAnchorElement>(
      "a[href*='/video-'], a[href*='/video/'], a[href*='/hd-porn/'], .mbtit a"
    );
    if (!linkEl) continue;

    const href = linkEl.getAttribute("href") || linkEl.href;
    const videoId = extractVideoId(href);
    if (!videoId || seenVideoIds.has(videoId)) continue;
    seenVideoIds.add(videoId);

    const advertisedResolution = extractCardResolution(element);
    const is4kPlus = isResolution4kPlus(advertisedResolution);

    // Format full absolute or relative URL
    const url = href.startsWith("http")
      ? href
      : `https://www.eporner.com${href.startsWith("/") ? "" : "/"}${href}`;

    results.push({
      videoId,
      url,
      element,
      advertisedResolution,
      is4kPlus,
    });
  }

  return results;
}

/**
 * Hard Filter: Permanently removes all <4K cards from the DOM.
 */
export function applyHardFilter(cards: CandidateCard[]): {
  kept: CandidateCard[];
  removedCount: number;
} {
  const kept: CandidateCard[] = [];
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

/**
 * Soft Filter: Toggles display of confirmed NO AV1 cards.
 * Optimistic Visibility: pending, probing, unknown, and error cards remain visible.
 */
export function applySoftFilter(
  cards: CandidateCard[],
  onlyAv1Active: boolean,
  profiles?: Map<string, RenditionProfile>
): void {
  for (const card of cards) {
    const profile = profiles?.get(card.videoId) || card.profile;
    
    if (onlyAv1Active) {
      if (profile && profile.probeStatus === "no_av1") {
        card.element.classList.add("javr-soft-hidden");
        card.element.style.display = "none";
      } else {
        // Optimistic visibility: detected, pending, probing, unknown, error
        card.element.classList.remove("javr-soft-hidden");
        card.element.style.removeProperty("display");
      }
    } else {
      // Restore visibility
      card.element.classList.remove("javr-soft-hidden");
      card.element.style.removeProperty("display");
    }
  }
}
