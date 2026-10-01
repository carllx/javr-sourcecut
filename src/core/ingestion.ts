import { basename } from "node:path";
import type {
  MediaCatalog,
  WorkRecord,
  WorkIdentifier,
  PerformerInput,
  SourceReferenceInput,
  IdentificationEvidenceInput,
  ReviewResolutionInput,
} from "./catalog.js";
import { extractCatalogCandidates } from "./identity.js";

export type SourceFailureCode =
  | "HTTP_403"
  | "HTTP_429"
  | "AUTH_FAILED"
  | "CHALLENGE_SHELL"
  | "MALFORMED_RESPONSE"
  | "NETWORK_ERROR";

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
  // Extract words / CJK n-grams
  const wordsA = normA.split(/[\s\-_,.:;!?]+/).filter((w) => w.length > 1);
  const wordsB = new Set(normB.split(/[\s\-_,.:;!?]+/).filter((w) => w.length > 1));
  const commonWords = wordsA.filter((w) => wordsB.has(w));
  if (commonWords.length > 0) {
    return false;
  }
  // Check CJK character overlap if present
  const cjkCharsA = normA.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || [];
  const cjkCharsB = new Set(normB.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []);
  const commonCjk = cjkCharsA.filter((c) => cjkCharsB.has(c));
  if (commonCjk.length >= 2) {
    return false;
  }
  return true;
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

    // 1. Work Identity check: candidate must have a stable identifier or provider asset ID
    const hasWorkIdentifier = cand.workIdentifiers && cand.workIdentifiers.length > 0;
    const hasProviderAssetId = cand.sourceReferences?.some((r) => r.providerAssetId);
    if (!hasWorkIdentifier && !hasProviderAssetId) {
      return { status: "ambiguous", reason: "unconfirmed_identity" };
    }

    // 2. Approximate Catalog Number check (anti-false-positive)
    if (query.catalogId) {
      const candCatalogId = cand.workIdentifiers?.find(
        (i) => i.scheme === "catalog_id" || !i.scheme
      )?.value;

      if (candCatalogId) {
        const normQuery = normalizeCatalogId(query.catalogId);
        const normCand = normalizeCatalogId(candCatalogId);
        if (normQuery !== normCand) {
          return { status: "ambiguous", reason: "approximate_identifier_mismatch" };
        }
      }
    }

    // 3. Conflicting Studio check
    if (query.studio && cand.studio) {
      const normQueryStudio = query.studio.trim().toLowerCase();
      const normCandStudio = cand.studio.trim().toLowerCase();
      if (normQueryStudio !== normCandStudio) {
        return { status: "ambiguous", reason: "conflicting_studio" };
      }
    }

    // 4. Conflicting Title check
    if (query.rawTitle && cand.title) {
      if (checkTitleConflict(query.rawTitle, cand.title)) {
        return { status: "ambiguous", reason: "conflicting_title" };
      }
    }

    // 5. Performer-only match without verified title or catalog ID
    if (
      query.performers &&
      query.performers.length > 0 &&
      !query.catalogId &&
      (!query.rawTitle || query.rawTitle.length === 0)
    ) {
      return { status: "ambiguous", reason: "same_performer_different_works" };
    }

    return { status: "unambiguous", candidate: cand };
  }

  public async ingest(input: IngestionInput): Promise<IngestionResult> {
    const filePath = input.localFile?.path?.trim();
    if (!filePath) {
      throw new Error("Invalid ingestion input: Local file path is required.");
    }

    const filename = basename(filePath);

    // 1. Extract clues
    const filenameCandidates = extractCatalogCandidates(filename, "observed-filename", "medium");
    const extractedCatalogId =
      filenameCandidates.length > 0 ? filenameCandidates[0].hyphenated : undefined;

    const query: IngestionQuery = {
      catalogId: input.clues?.catalogId ?? extractedCatalogId,
      rawTitle: input.clues?.rawTitle ?? input.sourceReference?.rawTitle,
      performers: input.clues?.performers,
      studio: input.clues?.studio,
      sourceUrl: input.clues?.sourceUrl ?? input.sourceReference?.sourceUrl,
      providerAssetId: input.clues?.providerAssetId ?? input.sourceReference?.providerAssetId,
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

    if (query.catalogId) {
      recordedEvidences.push({
        source: input.clues?.catalogId ? "user-clue" : "observed-filename",
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
        source: "user-clue",
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
    const candidates: IdentificationCandidate[] = [];
    let firstQueryError: SourceQueryFailure | null = null;

    for (const adapter of this.adapters) {
      if (adapter.canHandle && !adapter.canHandle(query)) {
        continue;
      }
      try {
        const adapterResults = await adapter.search(query);
        for (const res of adapterResults) {
          candidates.push(res);
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

    // 3. Handle Query Failure (403, 429, challenge, auth, malformed) when no other adapter succeeded
    if (candidates.length === 0 && firstQueryError) {
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

    // 4. Candidate Arbitration
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

    const combinedSourceRefs = [
      ...(candidates[0]?.sourceReferences || []),
      ...(input.sourceReference ? [input.sourceReference] : []),
    ];

    const pendingWork = this.catalog.recordPendingMedia({
      work: {
        title: pendingTitle,
        identifiers: query.catalogId ? [{ scheme: "catalog_id", value: query.catalogId }] : [],
      },
      reviewStatus: "pending_review",
      reviewReason: evaluation.reason,
      performers: candidates[0]?.performers,
      localFile: input.localFile,
      sourceReferences: combinedSourceRefs,
      evidences: recordedEvidences,
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
