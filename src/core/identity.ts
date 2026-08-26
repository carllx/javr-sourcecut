import type {
  CandidateProvenance,
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
  "VID",
  "ASSET",
  "ITEM",
  "FILE",
  "ID",
  "MOV",
  "MOVIE",
  "MP",
  "MKV",
  "AVI",
  "WEBM",
  "FLV",
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
  "ASTALAVR",
  "PIKPAK",
]);

const CATALOG_ID_PATTERN =
  /(?:^|[^a-zA-Z0-9])([a-zA-Z]{2,8})[-_]?(\d{1,6})(?=[^a-zA-Z0-9]|$)/g;

export function sanitizeFilename(input: string): string {
  return input
    .replace(/[:]/g, " - ")
    .replace(/[\\/*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*-\s*/g, " - ")
    .trim();
}

export function extractCatalogCandidates(
  text: string,
  provenance: CandidateProvenance = "observed-title",
  confidence: "high" | "medium" | "low" = "medium"
): CatalogCandidate[] {
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
        raw: `${match[1]}-${digits}`,
        provenance,
        confidence,
      });
    }
  }
  return candidates;
}

export function extractCatalogId(
  text: string
): { canonical: string; hyphenated: string; raw: string } | null {
  const candidates = extractCatalogCandidates(text, "observed-title", "medium");
  return candidates.length > 0 ? candidates[0] : null;
}

function isMeaningfulPerformerName(name: string): boolean {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  return !GENERIC_TAG_WORDS.has(lower) && lower.length > 1;
}

export function normalizePerformers(
  performers: (string | PerformerIdentity)[]
): PerformerIdentity[] {
  const normalized: PerformerIdentity[] = [];
  for (const item of performers) {
    if (typeof item === "string") {
      if (isMeaningfulPerformerName(item)) {
        normalized.push({ preferredName: item.trim() });
      }
    } else if (item && typeof item.preferredName === "string") {
      if (isMeaningfulPerformerName(item.preferredName)) {
        normalized.push({
          preferredName: item.preferredName.trim(),
          aliases: item.aliases ? item.aliases.map((a: string) => a.trim()).filter(Boolean) : undefined,
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

export function extractLegacyWorkAliases(
  identity?: ProgressiveMediaIdentity,
  provider?: string,
  providerAssetId?: string
): string[] {
  const aliases: string[] = [];
  if (identity?.canonicalCatalogId) {
    aliases.push(identity.canonicalCatalogId);
    aliases.push(identity.canonicalCatalogId.toLowerCase());
  }
  if (identity?.catalogCandidates) {
    for (const c of identity.catalogCandidates) {
      if (c.confidence !== "low") {
        aliases.push(c.canonical, c.hyphenated);
      }
    }
  }
  if (provider && providerAssetId) {
    aliases.push(`${provider}:${providerAssetId}`);
  }
  return aliases;
}

export function buildMediaIdentity(
  descriptor: SourceDescriptor
): ProgressiveMediaIdentity {
  const title = descriptor.rawTitle || "";
  const candidatesFromTitle = extractCatalogCandidates(title, "observed-title", "medium");
  const candidatesFromUrl = extractCatalogCandidates(descriptor.sourceUrl, "source-url", "medium");
  const candidatesFromFilenames = (descriptor.observedFilenames || []).flatMap((fn) =>
    extractCatalogCandidates(fn, "observed-filename", "low")
  );

  const allCandidates: CatalogCandidate[] = [];
  const seenCanonical = new Set<string>();

  for (const c of [...candidatesFromTitle, ...candidatesFromUrl, ...candidatesFromFilenames]) {
    if (!seenCanonical.has(c.canonical)) {
      seenCanonical.add(c.canonical);
      allCandidates.push(c);
    }
  }

  // Only candidates with sufficient confidence (medium or high, e.g. from title, URL, declared metadata)
  // may be promoted to canonical catalog ID and authoritative duplicate work aliases.
  // Low-confidence candidates (e.g. filename-only clues) are retained as indexing/search clues only.
  const authoritativeCandidates = allCandidates.filter((c) => c.confidence !== "low");
  const primaryCandidate = authoritativeCandidates.length > 0 ? authoritativeCandidates[0] : null;
  const realPerformers = normalizePerformers(descriptor.declaredPerformers || []);

  // 1. Work-identity search aliases (used for strong duplicate checks and authoritative indexing)
  // Note: Provider asset ID is provider-scoped (e.g. "eporner:12345") to prevent cross-provider collisions.
  const workAliasesSet = new Set<string>();
  if (descriptor.provider && descriptor.providerAssetId) {
    workAliasesSet.add(`${descriptor.provider}:${descriptor.providerAssetId}`);
  }

  // 2. Performer-identity search aliases (used for discovery/search indexing only, NOT duplicates)
  const performerAliasesSet = new Set<string>();
  for (const p of realPerformers) {
    performerAliasesSet.add(p.preferredName);
    if (p.aliases) {
      for (const alias of p.aliases) {
        performerAliasesSet.add(alias);
      }
    }
  }

  // 3. General discovery search aliases (includes bare providerAssetId and low-confidence clues for discovery)
  const generalSearchAliasesSet = new Set<string>();
  if (descriptor.providerAssetId) {
    generalSearchAliasesSet.add(descriptor.providerAssetId);
  }
  for (const c of allCandidates) {
    generalSearchAliasesSet.add(c.canonical);
    generalSearchAliasesSet.add(c.hyphenated);
  }

  if (primaryCandidate) {
    const canonicalCatalogId = primaryCandidate.canonical;
    const hyphenated = primaryCandidate.hyphenated;

    workAliasesSet.add(canonicalCatalogId);
    workAliasesSet.add(hyphenated);
    workAliasesSet.add(canonicalCatalogId.toLowerCase());
    workAliasesSet.add(hyphenated.toLowerCase());

    for (const c of authoritativeCandidates) {
      workAliasesSet.add(c.canonical);
      workAliasesSet.add(c.hyphenated);
    }

    const performerGroup = formatPerformerGroup(realPerformers);
    const baseName = sanitizeFilename(
      performerGroup
        ? `${performerGroup} - ${canonicalCatalogId}`
        : canonicalCatalogId
    );

    const workSearchAliases = Array.from(workAliasesSet);
    const performerSearchAliases = Array.from(performerAliasesSet);
    const searchAliases = Array.from(
      new Set([...workSearchAliases, ...performerSearchAliases, ...generalSearchAliasesSet])
    );

    return {
      provider: descriptor.provider,
      providerAssetId: descriptor.providerAssetId,
      observedTitle: title,
      observedFilenames: descriptor.observedFilenames,
      canonicalCatalogId,
      catalogCandidates: allCandidates,
      workSearchAliases,
      performerSearchAliases,
      searchAliases,
      performers: realPerformers,
      confidence: realPerformers.length > 0 ? "high" : "medium",
      provenance: primaryCandidate.provenance,
      baseName,
    };
  }

  // Deterministic fallback identity when no catalog ID is detected or confidence is low-only
  const sanitizedTitle = sanitizeFilename(title);
  const baseName = sanitizeFilename(
    `${descriptor.provider}-${descriptor.providerAssetId} - ${sanitizedTitle}`
  );

  const workSearchAliases = Array.from(workAliasesSet);
  const performerSearchAliases = Array.from(performerAliasesSet);
  const searchAliases = Array.from(
    new Set([...workSearchAliases, ...performerSearchAliases, ...generalSearchAliasesSet])
  );

  return {
    provider: descriptor.provider,
    providerAssetId: descriptor.providerAssetId,
    observedTitle: title,
    observedFilenames: descriptor.observedFilenames,
    canonicalCatalogId: undefined,
    catalogCandidates: allCandidates.length > 0 ? allCandidates : undefined,
    workSearchAliases,
    performerSearchAliases,
    searchAliases,
    performers: realPerformers,
    confidence: "fallback",
    provenance: "observed-title",
    baseName,
  };
}
