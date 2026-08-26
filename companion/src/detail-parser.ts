import type { ProbeStatus, RenditionProfile } from "./types.js";

export interface ParsedDetailResult {
  profile: RenditionProfile;
  isValidStructure: boolean;
}

/**
 * Extracts resolution height and AV1 codec classification from link attributes.
 */
export function extractLinkRendition(
  href: string,
  linkText: string,
  codecClass?: string
): { height: number; isAv1: boolean } {
  let height = 0;
  const resMatch =
    linkText.match(/(\d+)p/i) || href.match(/\/(\d+)\//) || href.match(/-(\d+)p/i);
  if (resMatch && resMatch[1]) {
    height = parseInt(resMatch[1], 10);
  }

  const isAv1 =
    codecClass === "av1" || /av1/i.test(linkText) || /-av1\.mp4/i.test(href);

  return { height, isAv1 };
}

/**
 * Parses Eporner video detail page HTML and extracts AV1 and overall rendition information.
 * Enforces strict validation to prevent network/HTML errors from being falsely classified as NO AV1.
 */
export function parseDetailPageHtml(
  html: string,
  videoId: string,
  sourceUrl: string
): RenditionProfile {
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
      updatedAt: Date.now(),
    };
  }

  // Detect Cloudflare or bot challenge pages
  if (
    /cf-challenge|checking your browser|attention required|cf-turnstile|access denied|just a moment\.\.\./i.test(
      html
    )
  ) {
    return {
      videoId,
      sourceUrl,
      maxResolution: "unknown",
      av1Resolutions: [],
      highestAv1Resolution: null,
      has4kAv1: false,
      probeStatus: "error",
      error: "Cloudflare/Anti-bot challenge detected",
      updatedAt: Date.now(),
    };
  }

  // Structural sanity checks: Eporner video pages contain standard markers
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
      updatedAt: Date.now(),
    };
  }

  // Extract all download links
  const downloadLinkRegex =
    /<span class="download-(av1|h264|webm|other)">\s*(?:or\s*)?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/span>/gi;

  const av1Heights: number[] = [];
  const allHeights: number[] = [];

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

  // Fallback: check direct download links without span wrappers
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

  // Sort descending by resolution height
  av1Heights.sort((a, b) => b - a);
  allHeights.sort((a, b) => b - a);

  const av1Resolutions = av1Heights.map((h) => `${h}p`);
  const highestAv1Resolution = av1Resolutions.length > 0 ? av1Resolutions[0] : null;
  const has4kAv1 = av1Heights.some((h) => h >= 2160);

  const maxResolution =
    allHeights.length > 0
      ? `${allHeights[0]}p`
      : av1Heights.length > 0
      ? `${av1Heights[0]}p`
      : "unknown";

  let probeStatus: ProbeStatus = "unknown";
  let errorMsg: string | undefined;

  if (av1Resolutions.length > 0) {
    probeStatus = "detected";
  } else if (allHeights.length > 0) {
    probeStatus = "no_av1";
  } else {
    // Eporner markers matched, but 0 download renditions found -> unknown, NOT no_av1
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
    updatedAt: Date.now(),
  };
}
