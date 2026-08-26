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

  const primaryCandidate = allCandidates.length > 0 ? allCandidates[0] : null;
  const realPerformers = normalizePerformers(descriptor.declaredPerformers || []);

  // 1. Work-identity search aliases (used for strong duplicate checks and indexing)
  const workAliasesSet = new Set<string>();
  if (descriptor.providerAssetId) {
    workAliasesSet.add(descriptor.providerAssetId);
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

  if (primaryCandidate) {
    const canonicalCatalogId = primaryCandidate.canonical;
    const hyphenated = primaryCandidate.hyphenated;

    workAliasesSet.add(canonicalCatalogId);
    workAliasesSet.add(hyphenated);
    workAliasesSet.add(canonicalCatalogId.toLowerCase());
    workAliasesSet.add(hyphenated.toLowerCase());

    for (const c of allCandidates) {
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
    const searchAliases = Array.from(new Set([...workSearchAliases, ...performerSearchAliases]));

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

  // Deterministic fallback identity when no catalog ID is detected
  const sanitizedTitle = sanitizeFilename(title);
  const baseName = sanitizeFilename(
    `${descriptor.provider}-${descriptor.providerAssetId} - ${sanitizedTitle}`
  );

  const workSearchAliases = Array.from(workAliasesSet);
  const performerSearchAliases = Array.from(performerAliasesSet);
  const searchAliases = Array.from(new Set([...workSearchAliases, ...performerSearchAliases]));

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
