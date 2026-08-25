import type { ProgressiveMediaIdentity, SourceDescriptor } from "../types.js";

const GENERIC_TAG_WORDS = new Set([
  "asian",
  "japanese",
  "toys",
  "60 fps",
  "60fps",
  "vr",
  "vr porn",
  "amateur",
  "hd",
  "4k",
  "pov",
  "brunette",
  "blowjob",
  "milf",
  "teen",
  "teens",
  "big tits",
  "massage",
  "threesome",
  "lesbian",
  "anal",
  "hardcore",
  "fetish",
  "solo",
  "test",
]);

const IGNORED_CATALOG_PREFIXES = new Set([
  "TEST",
  "VIDEO",
  "UPLOAD",
  "SAMPLE",
  "DOWNLOAD",
  "CHANNEL",
  "PART",
  "CLIP",
  "SCENE",
  "DATE",
  "HTTP",
  "HTTPS",
  "EPORNER",
]);

const CATALOG_ID_PATTERN = /\b([a-zA-Z]{2,8})[-_]?(\d{2,6})\b/g;

export function sanitizeFilename(input: string): string {
  return input
    .replace(/[:]/g, " - ")
    .replace(/[\\/*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*-\s*/g, " - ")
    .trim();
}

export function extractCatalogId(text: string): { canonical: string; hyphenated: string; raw: string } | null {
  const matches = Array.from(text.matchAll(CATALOG_ID_PATTERN));
  for (const match of matches) {
    const prefix = match[1].toUpperCase();
    const digits = match[2];
    if (!IGNORED_CATALOG_PREFIXES.has(prefix)) {
      return {
        canonical: `${prefix}${digits}`,
        hyphenated: `${prefix}-${digits}`,
        raw: match[0],
      };
    }
  }
  return null;
}

export function filterRealPerformers(performers: string[]): string[] {
  return performers.filter((p) => {
    const lower = p.trim().toLowerCase();
    return !GENERIC_TAG_WORDS.has(lower) && lower.length > 1;
  });
}

export function buildMediaIdentity(descriptor: SourceDescriptor): ProgressiveMediaIdentity {
  const title = descriptor.rawTitle || "";
  const catalogMatch = extractCatalogId(title) || extractCatalogId(descriptor.sourceUrl);

  let realPerformers = filterRealPerformers(descriptor.declaredPerformers);

  if (catalogMatch) {
    const canonicalCatalogId = catalogMatch.canonical;
    const hyphenated = catalogMatch.hyphenated;
    const searchAliases = Array.from(
      new Set([
        canonicalCatalogId,
        hyphenated,
        canonicalCatalogId.toLowerCase(),
        hyphenated.toLowerCase(),
      ])
    );

    if (realPerformers.length === 0) {
      // Try extracting performer from remaining title
      const remainingTitle = title
        .replace(new RegExp(catalogMatch.raw, "i"), "")
        .replace(/[-_–—]/g, " ")
        .trim();
      const cleaned = sanitizeFilename(remainingTitle);
      if (cleaned.length > 2 && !GENERIC_TAG_WORDS.has(cleaned.toLowerCase())) {
        realPerformers = [cleaned];
      }
    }

    const performerObjects = realPerformers.map((p) => ({ preferredName: p }));
    const performerGroup = realPerformers.join("_");

    const baseName = sanitizeFilename(
      performerGroup ? `${performerGroup} - ${canonicalCatalogId}` : canonicalCatalogId
    );

    return {
      provider: descriptor.provider,
      providerAssetId: descriptor.providerAssetId,
      observedTitle: title,
      canonicalCatalogId,
      searchAliases,
      performers: performerObjects,
      confidence: realPerformers.length > 0 ? "high" : "medium",
      baseName,
    };
  }

  // Deterministic fallback
  const sanitizedTitle = sanitizeFilename(title);
  const baseName = sanitizeFilename(
    `${descriptor.provider}-${descriptor.providerAssetId} - ${sanitizedTitle}`
  );

  return {
    provider: descriptor.provider,
    providerAssetId: descriptor.providerAssetId,
    observedTitle: title,
    searchAliases: [descriptor.providerAssetId],
    performers: realPerformers.map((p) => ({ preferredName: p })),
    confidence: "fallback",
    baseName,
  };
}
