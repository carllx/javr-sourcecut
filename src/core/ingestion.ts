import { basename, dirname } from "node:path";
import type {
  MediaCatalog,
  WorkRecord,
  WorkIdentifier,
  PerformerInput,
  SourceReferenceInput,
  IdentificationEvidenceInput,
  ReviewCandidateRecord,
  ReviewResolutionInput,
  LocalFileInput,
} from "./catalog.js";
import { extractCatalogCandidates } from "./identity.js";

export type { LocalFileInput };

export type SourceFailureCode =
  | "HTTP_403"
  | "HTTP_429"
  | "HTTP_503"
  | "AUTH_FAILED"
  | "CHALLENGE_SHELL"
  | "MALFORMED_RESPONSE"
  | "NETWORK_ERROR"
  | "IDENTITY_MISMATCH";

export class SourceQueryFailure extends Error {
  public readonly code: SourceFailureCode;
  public readonly retryable: boolean;

  constructor(code: SourceFailureCode, message: string, retryable = true) {
    super(message);
    this.name = "SourceQueryFailure";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface IdentificationCandidate {
  workIdentifiers: WorkIdentifier[];
  title: string;
  studio?: string;
  performers?: PerformerInput[];
  sourceReferences?: SourceReferenceInput[];
  director?: string;
  releaseDate?: string;
  shootDate?: string;
  evidences?: IdentificationEvidenceInput[];
}

export interface IngestionQuery {
  catalogId?: string;
  rawTitle?: string;
  performers?: string[];
  sourceUrl?: string;
  provider?: string;
  providerAssetId?: string;
  studio?: string;
  filename?: string;
}

export interface IdentificationSourceAdapter {
  readonly provider: string;
  canHandle?(query: IngestionQuery): boolean;
  search(query: IngestionQuery): Promise<IdentificationCandidate[]>;
}

export interface IngestionInput {
  localFile: {
    path: string;
    sizeBytes?: number;
    format?: string;
    codec?: string;
    resolution?: string;
  };
  clues?: {
    catalogId?: string;
    rawTitle?: string;
    performers?: string[];
    studio?: string;
    sourceUrl?: string;
    provider?: string;
    providerAssetId?: string;
  };
  sourceReference?: SourceReferenceInput;
  sourceQueryError?: SourceQueryFailure;
}

export type ReviewReason =
  | "approximate_identifier_mismatch"
  | "same_performer_different_works"
  | "conflicting_studio"
  | "conflicting_title"
  | "multiple_candidates"
  | "no_candidates_found"
  | "unconfirmed_identity";

export type IngestionResult =
  | {
      status: "library_ready";
      work: WorkRecord;
      provenanceNotes?: string[];
    }
  | {
      status: "pending_review";
      work: WorkRecord;
      reviewReason: ReviewReason;
      candidates?: IdentificationCandidate[];
    }
  | {
      status: "query_failed";
      retryable: boolean;
      errorCode: SourceFailureCode;
      errorMessage: string;
      work?: WorkRecord;
    };

type EvaluationResult =
  | { status: "unambiguous"; candidate: IdentificationCandidate }
  | { status: "ambiguous"; reason: ReviewReason };

function normalizeCatalogId(id: string): string {
  return id.replace(/[-_\s]/g, "").toUpperCase();
}

function checkTitleConflict(a: string, b: string): boolean {
  const normA = a.trim().toLowerCase();
  const normB = b.trim().toLowerCase();
  if (normA === normB || normA.includes(normB) || normB.includes(normA)) {
    return false;
  }
  const wordsA = normA.split(/[\s\-_,.:;!?]+/).filter((w) => w.length > 1);
  const wordsB = new Set(normB.split(/[\s\-_,.:;!?]+/).filter((w) => w.length > 1));
  const commonWords = wordsA.filter((w) => wordsB.has(w));
  if (commonWords.length > 0) {
    return false;
  }
  const cjkCharsA = normA.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || [];
  const cjkCharsB = new Set(normB.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []);
  const commonCjk = cjkCharsA.filter((c) => cjkCharsB.has(c));
  if (commonCjk.length >= 2) {
    return false;
  }
  return true;
}

function getPerformerNames(p: PerformerInput): Set<string> {
  const set = new Set<string>();
  if (p.name) set.add(p.name.trim().toLowerCase());
  for (const a of p.aliases || []) {
    if (a) set.add(a.trim().toLowerCase());
  }
  return set;
}

function normalizeTitleForEquivalence(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b(4k|8k|2k|1080p|720p|2160p|60fps|vr|av1|h264|hevc)\b/gi, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function areTitlesPositivelyEquivalent(a: string, b: string): boolean {
  const normA = normalizeTitleForEquivalence(a);
  const normB = normalizeTitleForEquivalence(b);
  return normA.length > 2 && normA === normB;
}

function areCandidatesEquivalent(a: IdentificationCandidate, b: IdentificationCandidate): boolean {
  // 1. Shared matching Work Identifier
  for (const idA of a.workIdentifiers || []) {
    const normA = normalizeCatalogId(idA.value);
    for (const idB of b.workIdentifiers || []) {
      const normB = normalizeCatalogId(idB.value);
      if (normA === normB && idA.scheme === idB.scheme) {
        return true;
      }
    }
  }

  // 2. Shared matching provider + providerAssetId
  for (const refA of a.sourceReferences || []) {
    if (!refA.providerAssetId) continue;
    for (const refB of b.sourceReferences || []) {
      if (
        refB.providerAssetId &&
        refA.provider === refB.provider &&
        refA.providerAssetId === refB.providerAssetId
      ) {
        return true;
      }
    }
  }

  // 3. Shared normalized title + shared performer (name or alias) + non-conflicting studio
  // (Only if they do not have distinct conflicting work identifiers)
  const hasConflictingIdents = (a.workIdentifiers || []).some((idA) => {
    const normA = normalizeCatalogId(idA.value);
    return (b.workIdentifiers || []).some((idB) => {
      const normB = normalizeCatalogId(idB.value);
      return idA.scheme === idB.scheme && normA !== normB;
    });
  });

  if (!hasConflictingIdents) {
    if (areTitlesPositivelyEquivalent(a.title, b.title)) {
      const namesA = new Set<string>();
      for (const p of a.performers || []) {
        for (const name of getPerformerNames(p)) namesA.add(name);
      }
      const namesB = new Set<string>();
      for (const p of b.performers || []) {
        for (const name of getPerformerNames(p)) namesB.add(name);
      }

      const sharesPerformer = Array.from(namesA).some((name) => namesB.has(name));
      if (sharesPerformer) {
        if (a.studio && b.studio && a.studio.trim().toLowerCase() !== b.studio.trim().toLowerCase()) {
          return false;
        }
        return true;
      }
    }
  }

  return false;
}

function mergeTwoCandidates(target: IdentificationCandidate, source: IdentificationCandidate): IdentificationCandidate {
  const identMap = new Map<string, WorkIdentifier>();
  for (const ident of [...(target.workIdentifiers || []), ...(source.workIdentifiers || [])]) {
    const key = `${ident.scheme}:${normalizeCatalogId(ident.value)}`;
    if (!identMap.has(key)) {
      identMap.set(key, ident);
    }
  }

  const performerMap = new Map<string, PerformerInput>();
  for (const p of [...(target.performers || []), ...(source.performers || [])]) {
    const key = p.name.trim().toLowerCase();
    const existing = performerMap.get(key);
    if (!existing) {
      performerMap.set(key, { ...p });
    } else {
      const combinedAliases = Array.from(
        new Set([...(existing.aliases || []), ...(p.aliases || [])])
      );
      performerMap.set(key, {
        ...existing,
        aliases: combinedAliases.length > 0 ? combinedAliases : undefined,
        dateOfBirth: existing.dateOfBirth || p.dateOfBirth,
        region: existing.region || p.region,
      });
    }
  }

  const refMap = new Map<string, SourceReferenceInput>();
  for (const r of [...(target.sourceReferences || []), ...(source.sourceReferences || [])]) {
    const key = `${r.provider}:${r.providerAssetId || r.sourceUrl}`;
    if (!refMap.has(key)) {
      refMap.set(key, r);
    }
  }

  const combinedEvidences = [...(target.evidences || []), ...(source.evidences || [])];

  return {
    title: target.title || source.title,
    studio: target.studio || source.studio,
    director: target.director || source.director,
    releaseDate: target.releaseDate || source.releaseDate,
    shootDate: target.shootDate || source.shootDate,
    workIdentifiers: Array.from(identMap.values()),
    performers: Array.from(performerMap.values()),
    sourceReferences: Array.from(refMap.values()),
    evidences: combinedEvidences.length > 0 ? combinedEvidences : undefined,
  };
}

function deduplicateAndMergeCandidates(candidates: IdentificationCandidate[]): IdentificationCandidate[] {
  const merged: IdentificationCandidate[] = [];
  for (const candidate of candidates) {
    const existingIndex = merged.findIndex((m) => areCandidatesEquivalent(m, candidate));
    if (existingIndex >= 0) {
      merged[existingIndex] = mergeTwoCandidates(merged[existingIndex], candidate);
    } else {
      merged.push({ ...candidate });
    }
  }
  return merged;
}

export class IngestionService {
  private catalog: MediaCatalog;
  private adapters: IdentificationSourceAdapter[];

  constructor(catalog: MediaCatalog, adapters: IdentificationSourceAdapter[] = []) {
    this.catalog = catalog;
    this.adapters = adapters;
  }

  private evaluateCandidates(
    query: IngestionQuery,
    candidates: IdentificationCandidate[]
  ): EvaluationResult {
    if (candidates.length === 0) {
      return { status: "ambiguous", reason: "no_candidates_found" };
    }

    if (candidates.length > 1) {
      const candidateTitles = new Set(candidates.map((c) => c.title.trim().toLowerCase()));
      if (query.performers && query.performers.length > 0 && candidateTitles.size > 1) {
        return { status: "ambiguous", reason: "same_performer_different_works" };
      }
      return { status: "ambiguous", reason: "multiple_candidates" };
    }

    const cand = candidates[0];

    // Rule 1: Corroboration of strong catalog ID clue when present in query
    if (query.catalogId) {
      const normQueryId = normalizeCatalogId(query.catalogId);
      const matchingIdent = cand.workIdentifiers?.find(
        (i) =>
          (i.scheme === "catalog_id" || i.scheme === "scene_id") &&
          normalizeCatalogId(i.value) === normQueryId
      );

      if (!matchingIdent) {
        return { status: "ambiguous", reason: "approximate_identifier_mismatch" };
      }
    }

    // Rule 2: Corroboration of providerAssetId when present in query
    if (query.providerAssetId) {
      const normQueryAssetId = query.providerAssetId.trim().toLowerCase();
      const normQueryProvider = query.provider?.trim().toLowerCase();

      // If provider is missing, provider-local asset ID cannot be scoped or trusted for auto-confirmation
      if (!normQueryProvider) {
        // Only allow confirmation if there is independent strong evidence (e.g. matching catalog ID)
        if (!query.catalogId) {
          return { status: "ambiguous", reason: "approximate_identifier_mismatch" };
        }
      } else {
        const matchingRef = (cand.sourceReferences || []).find((r) => {
          const assetMatches = r.providerAssetId?.trim().toLowerCase() === normQueryAssetId;
          if (!assetMatches) return false;
          return r.provider.trim().toLowerCase() === normQueryProvider;
        });

        if (!matchingRef) {
          return { status: "ambiguous", reason: "approximate_identifier_mismatch" };
        }
      }
    }

    // Rule 3: Conflicting Studio check
    if (query.studio && cand.studio) {
      const normQueryStudio = query.studio.trim().toLowerCase();
      const normCandStudio = cand.studio.trim().toLowerCase();
      if (normQueryStudio !== normCandStudio) {
        return { status: "ambiguous", reason: "conflicting_studio" };
      }
    }

    // Rule 4: Conflicting Title check
    if (query.rawTitle && cand.title) {
      if (checkTitleConflict(query.rawTitle, cand.title)) {
        return { status: "ambiguous", reason: "conflicting_title" };
      }
    }

    // Rule 5: Non-ID Western Work (no catalogId and no providerAssetId in query)
    if (!query.catalogId && !query.providerAssetId) {
      const hasTitle = query.rawTitle && query.rawTitle.trim().length > 0;
      const hasPerformers = query.performers && query.performers.length > 0;

      // If query only has performer, but no title/catalogId -> same performer different works
      if (!hasTitle && hasPerformers) {
        return { status: "ambiguous", reason: "same_performer_different_works" };
      }

      // Strong Western Work corroboration: title matches AND performer(s) corroborate
      if (hasTitle && hasPerformers) {
        const titleMatches = areTitlesPositivelyEquivalent(query.rawTitle!, cand.title);
        const performersMatch = (cand.performers || []).some((cp) => {
          const candNames = getPerformerNames(cp);
          return query.performers!.some((qp) => candNames.has(qp.trim().toLowerCase()));
        });
        const studioMatches =
          !query.studio ||
          !cand.studio ||
          query.studio.trim().toLowerCase() === cand.studio.trim().toLowerCase();

        if (titleMatches && performersMatch && studioMatches) {
          return { status: "unambiguous", candidate: cand };
        }
      }

      // If no strong corroboration was established (e.g. title only without performers/IDs, or mismatch)
      return { status: "ambiguous", reason: "unconfirmed_identity" };
    }

    return { status: "unambiguous", candidate: cand };
  }

  public async ingest(input: IngestionInput): Promise<IngestionResult> {
    const filePath = input.localFile?.path?.trim();
    if (!filePath) {
      throw new Error("Invalid ingestion input: Local file path is required.");
    }

    const filename = basename(filePath);
    const normalizedPath = filePath.replace(/\\/g, "/");
    const dirPath = dirname(normalizedPath);

    // 1. Extract clues: filename first, then innermost containing directory upwards
    const filenameCandidates = extractCatalogCandidates(filename, "observed-filename", "medium");

    const dirSegments = dirPath.split("/").filter(Boolean);
    let dirCandidates: ReturnType<typeof extractCatalogCandidates> = [];
    for (let i = dirSegments.length - 1; i >= 0; i--) {
      const segment = dirSegments[i];
      if (/^[a-zA-Z]:$/i.test(segment)) continue; // skip drive letter
      const segCandidates = extractCatalogCandidates(segment, "observed-directory", "medium");
      if (segCandidates.length > 0) {
        dirCandidates = segCandidates;
        break;
      }
    }

    const extractedCatalogId =
      filenameCandidates.length > 0
        ? filenameCandidates[0].hyphenated
        : dirCandidates.length > 0
          ? dirCandidates[0].hyphenated
          : undefined;

    const query: IngestionQuery = {
      catalogId: input.clues?.catalogId ?? extractedCatalogId,
      rawTitle: input.clues?.rawTitle ?? input.sourceReference?.rawTitle,
      performers: input.clues?.performers,
      studio: input.clues?.studio,
      sourceUrl: input.clues?.sourceUrl ?? input.sourceReference?.sourceUrl,
      providerAssetId: input.clues?.providerAssetId ?? input.sourceReference?.providerAssetId,
      provider: input.clues?.provider ?? input.sourceReference?.provider,
      filename,
    };

    // Build recorded evidences for full provenance
    const recordedEvidences: IdentificationEvidenceInput[] = [];
    const now = new Date().toISOString();

    recordedEvidences.push({
      source: "observed-filename",
      evidenceKey: "filename",
      evidenceValue: filename,
      recordedAt: now,
    });

    if (dirPath && dirPath !== "." && dirPath !== "/") {
      recordedEvidences.push({
        source: "observed-directory",
        evidenceKey: "directory",
        evidenceValue: dirPath,
        recordedAt: now,
      });

      if (dirCandidates.length > 0) {
        recordedEvidences.push({
          source: "observed-directory",
          evidenceKey: "directory_catalog_candidate",
          evidenceValue: dirCandidates[0].hyphenated,
          recordedAt: now,
        });
      }
    }

    const mediaProps: [keyof typeof input.localFile, string][] = [
      ["codec", "codec"],
      ["resolution", "resolution"],
      ["format", "format"],
      ["sizeBytes", "size_bytes"],
    ];
    for (const [prop, key] of mediaProps) {
      const val = input.localFile[prop];
      if (val !== undefined && val !== null && val !== "") {
        recordedEvidences.push({
          source: "media-properties",
          evidenceKey: key,
          evidenceValue: String(val),
          recordedAt: now,
        });
      }
    }

    if (query.provider) {
      recordedEvidences.push({
        source: input.clues?.provider ? "user-clue" : "source-reference",
        evidenceKey: "provider",
        evidenceValue: query.provider,
        recordedAt: now,
      });
    }

    if (query.catalogId) {
      recordedEvidences.push({
        source: input.clues?.catalogId
          ? "user-clue"
          : filenameCandidates.length > 0
            ? "observed-filename"
            : "observed-directory",
        evidenceKey: "catalog_id",
        evidenceValue: query.catalogId,
        recordedAt: now,
      });
    }

    if (query.rawTitle) {
      recordedEvidences.push({
        source: "observed-title",
        evidenceKey: "raw_title",
        evidenceValue: query.rawTitle,
        recordedAt: now,
      });
    }

    if (query.performers && query.performers.length > 0) {
      recordedEvidences.push({
        source: input.sourceReference ? "source-reference" : "user-clue",
        evidenceKey: "declared_performers",
        evidenceValue: JSON.stringify(query.performers),
        recordedAt: now,
      });
    }

    if (query.studio) {
      recordedEvidences.push({
        source: "user-clue",
        evidenceKey: "studio",
        evidenceValue: query.studio,
        recordedAt: now,
      });
    }

    if (query.sourceUrl) {
      recordedEvidences.push({
        source: "source-reference",
        evidenceKey: "source_url",
        evidenceValue: query.sourceUrl,
        recordedAt: now,
      });
    }

    if (query.providerAssetId) {
      recordedEvidences.push({
        source: "source-reference",
        evidenceKey: "provider_asset_id",
        evidenceValue: query.providerAssetId,
        recordedAt: now,
      });
    }

    // 2. Query adapters
    const rawCandidates: IdentificationCandidate[] = [];
    let firstQueryError: SourceQueryFailure | null = input.sourceQueryError ?? null;

    for (const adapter of this.adapters) {
      if (adapter.canHandle && !adapter.canHandle(query)) {
        continue;
      }
      try {
        const adapterResults = await adapter.search(query);
        for (const res of adapterResults) {
          rawCandidates.push(res);
          recordedEvidences.push({
            source: `source-adapter:${adapter.provider}`,
            evidenceKey: "search-candidate",
            evidenceValue: JSON.stringify({
              title: res.title,
              identifiers: res.workIdentifiers,
              performers: res.performers?.map((p) => p.name),
            }),
            recordedAt: now,
          });
        }
      } catch (err: any) {
        if (!firstQueryError) {
          firstQueryError =
            err instanceof SourceQueryFailure
              ? err
              : new SourceQueryFailure("NETWORK_ERROR", err?.message || String(err), true);
        }
      }
    }

    // 3. Handle Query Failure (403, 429, challenge, auth, malformed) when no adapter succeeded
    if (rawCandidates.length === 0 && firstQueryError) {
      const queryError = firstQueryError;
      const failedWork = this.catalog.recordPendingMedia({
        work: {
          title: query.rawTitle || query.catalogId || "Pending Ingestion Work",
          identifiers: query.catalogId ? [{ scheme: "catalog_id", value: query.catalogId }] : [],
        },
        reviewStatus: "query_failed",
        reviewReason: `${queryError.code}: ${queryError.message}`,
        localFile: input.localFile,
        sourceReferences: input.sourceReference ? [input.sourceReference] : [],
        evidences: [
          ...recordedEvidences,
          {
            source: "ingestion-error",
            evidenceKey: queryError.code,
            evidenceValue: queryError.message,
            recordedAt: now,
          },
        ],
      });

      return {
        status: "query_failed",
        retryable: queryError.retryable,
        errorCode: queryError.code,
        errorMessage: queryError.message,
        work: failedWork,
      };
    }

    // 4. Deduplicate and merge equivalent candidates across adapters
    const candidates = deduplicateAndMergeCandidates(rawCandidates);

    // 5. Candidate Arbitration
    const evaluation = this.evaluateCandidates(query, candidates);

    if (evaluation.status === "unambiguous") {
      const cand = evaluation.candidate;
      const combinedSourceReferences = [
        ...(cand.sourceReferences || []),
        ...(input.sourceReference ? [input.sourceReference] : []),
      ];

      const work = this.catalog.recordConfirmedMedia({
        work: {
          title: cand.title,
          identifiers: cand.workIdentifiers,
          director: cand.director,
          releaseDate: cand.releaseDate,
          shootDate: cand.shootDate,
        },
        performers: cand.performers || [],
        localFile: input.localFile,
        sourceReferences: combinedSourceReferences,
        evidences: [...recordedEvidences, ...(cand.evidences || [])],
      });

      return {
        status: "library_ready",
        work,
      };
    }

    // Ambiguous -> 待整理 (pending_review)
    const pendingTitle =
      candidates.length === 1
        ? candidates[0].title
        : query.rawTitle || query.catalogId || "Pending Ingestion Work";

    // Preserve all source references across ALL competing candidates
    const allCandidateSourceRefs: SourceReferenceInput[] = [];
    const seenRefs = new Set<string>();
    for (const c of candidates) {
      for (const r of c.sourceReferences || []) {
        const key = `${r.provider}:${r.providerAssetId || r.sourceUrl}`;
        if (!seenRefs.has(key)) {
          seenRefs.add(key);
          allCandidateSourceRefs.push(r);
        }
      }
    }
    if (input.sourceReference) {
      const key = `${input.sourceReference.provider}:${input.sourceReference.providerAssetId || input.sourceReference.sourceUrl}`;
      if (!seenRefs.has(key)) {
        seenRefs.add(key);
        allCandidateSourceRefs.push(input.sourceReference);
      }
    }

    const reviewCandidates: ReviewCandidateRecord[] = candidates.map((c) => ({
      title: c.title,
      studio: c.studio,
      director: c.director,
      releaseDate: c.releaseDate,
      shootDate: c.shootDate,
      identifiers: c.workIdentifiers || [],
      performers: c.performers || [],
      sourceReferences: c.sourceReferences || [],
      evidences: c.evidences,
    }));

    const pendingWork = this.catalog.recordPendingMedia({
      work: {
        title: pendingTitle,
        identifiers: query.catalogId ? [{ scheme: "catalog_id", value: query.catalogId }] : [],
      },
      reviewStatus: "pending_review",
      reviewReason: evaluation.reason,
      performers: candidates[0]?.performers,
      localFile: input.localFile,
      sourceReferences: allCandidateSourceRefs,
      evidences: recordedEvidences,
      reviewCandidates,
    });

    return {
      status: "pending_review",
      work: pendingWork,
      reviewReason: evaluation.reason,
      candidates,
    };
  }

  public resolveReview(workId: string, resolution: ReviewResolutionInput): WorkRecord {
    return this.catalog.resolveReview(workId, resolution);
  }
}
