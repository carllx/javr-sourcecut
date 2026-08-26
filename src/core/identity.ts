import type {
  CatalogCandidate,
  PerformerIdentity,
  ProgressiveMediaIdentity,
  SourceDescriptor,
} from "../types.js";

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

const CATALOG_ID_PATTERN = /\b([a-zA-Z]{2,8})[-_]?(\d{1,6})\b/g;

export function sanitizeFilename(input: string): string {
  return input
    .replace(/[:]/g, " - ")
    .replace(/[\\/*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*-\s*/g, " - ")
    .trim();
}

export function extractCatalogCandidates(text: string): CatalogCandidate[] {
  if (!text) return [];
  const candidates: CatalogCandidate[] = [];
  const matches = Array.from(text.matchAll(CATALOG_ID_PATTERN));
  for (const match of matches) {
    const prefix = match[1].toUpperCase();
    const digits = match[2];
    if (!IGNORED_CATALOG_PREFIXES.has(prefix)) {
      candidates.push({
        canonical: `${prefix}${digits}`,
        hyphenated: `${prefix}-${digits}`,
        raw: match[0],
        confidence: "high",
      });
    }
  }
  return candidates;
}

export function extractCatalogId(
  text: string
): { canonical: string; hyphenated: string; raw: string } | null {
  const candidates = extractCatalogCandidates(text);
  return candidates.length > 0 ? candidates[0] : null;
}

export function normalizePerformers(
  performers: (string | PerformerIdentity)[]
): PerformerIdentity[] {
  const normalized: PerformerIdentity[] = [];
  for (const item of performers) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      const lower = trimmed.toLowerCase();
      if (!GENERIC_TAG_WORDS.has(lower) && lower.length > 1) {
        normalized.push({ preferredName: trimmed });
      }
    } else if (item && typeof item.preferredName === "string") {
      const trimmed = item.preferredName.trim();
      const lower = trimmed.toLowerCase();
      if (!GENERIC_TAG_WORDS.has(lower) && lower.length > 1) {
        normalized.push({
          preferredName: trimmed,
          aliases: item.aliases ? item.aliases.map((a) => a.trim()).filter(Boolean) : undefined,
          hints: item.hints,
        });
      }
    }
  }
  return normalized;
}

export function formatPerformerGroup(performers: PerformerIdentity[]): string {
  return performers
    .map((p) => {
      if (p.aliases && p.aliases.length > 0) {
        return `${p.preferredName} (${p.aliases.join(", ")})`;
      }
      return p.preferredName;
    })
    .join("_");
}

export function buildMediaIdentity(
  descriptor: SourceDescriptor
): ProgressiveMediaIdentity {
  const title = descriptor.rawTitle || "";
  const candidatesFromTitle = extractCatalogCandidates(title);
  const candidatesFromUrl = extractCatalogCandidates(descriptor.sourceUrl);
  const candidatesFromFilenames = (descriptor.observedFilenames || []).flatMap((fn) =>
    extractCatalogCandidates(fn)
  );

  const allCandidates: CatalogCandidate[] = [];
  const seenCanonical = new Set<string>();

  for (const c of [...candidatesFromTitle, ...candidatesFromUrl, ...candidatesFromFilenames]) {
    if (!seenCanonical.has(c.canonical)) {
      seenCanonical.add(c.canonical);
      allCandidates.push(c);
    }
  }

  const primaryCandidate = allCandidates.length > 0 ? allCandidates[0] : null;
  const realPerformers = normalizePerformers(descriptor.declaredPerformers || []);

  const searchAliasesSet = new Set<string>();
  if (descriptor.providerAssetId) {
    searchAliasesSet.add(descriptor.providerAssetId);
  }

  for (const p of realPerformers) {
    searchAliasesSet.add(p.preferredName);
    if (p.aliases) {
      for (const alias of p.aliases) {
        searchAliasesSet.add(alias);
      }
    }
  }

  if (primaryCandidate) {
    const canonicalCatalogId = primaryCandidate.canonical;
    const hyphenated = primaryCandidate.hyphenated;

    searchAliasesSet.add(canonicalCatalogId);
    searchAliasesSet.add(hyphenated);
    searchAliasesSet.add(canonicalCatalogId.toLowerCase());
    searchAliasesSet.add(hyphenated.toLowerCase());

    for (const c of allCandidates) {
      searchAliasesSet.add(c.canonical);
      searchAliasesSet.add(c.hyphenated);
    }

    const performerGroup = formatPerformerGroup(realPerformers);
    const baseName = sanitizeFilename(
      performerGroup
        ? `${performerGroup} - ${canonicalCatalogId}`
        : canonicalCatalogId
    );

    return {
      provider: descriptor.provider,
      providerAssetId: descriptor.providerAssetId,
      observedTitle: title,
      observedFilenames: descriptor.observedFilenames,
      canonicalCatalogId,
      catalogCandidates: allCandidates,
      searchAliases: Array.from(searchAliasesSet),
      performers: realPerformers,
      confidence: realPerformers.length > 0 ? "high" : "medium",
      baseName,
    };
  }

  // Deterministic fallback identity when no catalog ID is detected
  const sanitizedTitle = sanitizeFilename(title);
  const baseName = sanitizeFilename(
    `${descriptor.provider}-${descriptor.providerAssetId} - ${sanitizedTitle}`
  );

  return {
    provider: descriptor.provider,
    providerAssetId: descriptor.providerAssetId,
    observedTitle: title,
    observedFilenames: descriptor.observedFilenames,
    canonicalCatalogId: undefined,
    catalogCandidates: allCandidates.length > 0 ? allCandidates : undefined,
    searchAliases: Array.from(searchAliasesSet),
    performers: realPerformers,
    confidence: "fallback",
    baseName,
  };
}
