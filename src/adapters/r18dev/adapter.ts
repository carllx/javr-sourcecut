import type {
  IdentificationCandidate,
  IdentificationSourceAdapter,
  IngestionQuery,
} from "../../core/ingestion.js";
import type {
  IdentificationEvidenceInput,
  PerformerInput,
  SourceReferenceInput,
  WorkIdentifier,
} from "../../core/catalog-types.js";
import { R18DevClient, type R18DevClientOptions } from "./client.js";
import {
  generateContentIdCandidates,
  parseJavIdentifier,
  verifyPostFetchIdentity,
  type ParsedJavIdentifier,
} from "./identifier.js";
import type { R18MovieDetailResponse } from "./types.js";

export interface R18DevAdapterOptions extends R18DevClientOptions {
  client?: R18DevClient;
}

export class R18DevAdapter implements IdentificationSourceAdapter {
  public readonly provider: string = "r18dev";
  private client: R18DevClient;

  constructor(options: R18DevAdapterOptions = {}) {
    this.client =
      options.client ||
      new R18DevClient({
        baseUrl: options.baseUrl,
        fetchFn: options.fetchFn,
      });
  }

  public canHandle(query: IngestionQuery): boolean {
    if (query.provider === "r18dev") {
      return true;
    }
    if (query.sourceUrl && /r18\.dev/i.test(query.sourceUrl)) {
      return true;
    }
    return this.resolveJavIdentifier(query) !== null;
  }

  public async search(query: IngestionQuery): Promise<IdentificationCandidate[]> {
    const parsed = this.resolveJavIdentifier(query);
    if (!parsed) {
      return [];
    }

    const candidateCids = generateContentIdCandidates(parsed);
    let matchedDetail: R18MovieDetailResponse | null = null;

    for (const cid of candidateCids) {
      const detail = await this.client.fetchDetail(cid);
      if (detail) {
        verifyPostFetchIdentity(parsed, detail);
        matchedDetail = detail;
        break;
      }
    }

    if (!matchedDetail) {
      return [];
    }

    return [this.mapDetailToCandidate(parsed, matchedDetail)];
  }

  private resolveJavIdentifier(query: IngestionQuery): ParsedJavIdentifier | null {
    if (query.catalogId) {
      const parsed = parseJavIdentifier(query.catalogId);
      if (parsed) return parsed;
    }

    if (query.provider === "r18dev" && query.providerAssetId) {
      const parsed = parseJavIdentifier(query.providerAssetId);
      if (parsed) return parsed;
    }

    if (query.filename) {
      const parsed = parseJavIdentifier(query.filename);
      if (parsed) return parsed;
    }

    if (query.rawTitle) {
      const parsed = parseJavIdentifier(query.rawTitle);
      if (parsed) return parsed;
    }

    if (query.sourceUrl) {
      const parsed = parseJavIdentifier(query.sourceUrl);
      if (parsed) return parsed;
    }

    return null;
  }

  private mapDetailToCandidate(
    parsed: ParsedJavIdentifier,
    detail: R18MovieDetailResponse
  ): IdentificationCandidate {
    const now = new Date().toISOString();

    // 1. Work Identifiers
    const workIdentifiers: WorkIdentifier[] = [];
    const seenId = new Set<string>();
    const addIdent = (scheme: string, value: string) => {
      const key = `${scheme}:${value.trim().toUpperCase()}`;
      if (!seenId.has(key)) {
        seenId.add(key);
        workIdentifiers.push({ scheme, value });
      }
    };

    const mainCatalogId = detail.dvd_id || parsed.canonical;
    addIdent("catalog_id", mainCatalogId);

    if (detail.dvd_id) {
      const dvdParsed = parseJavIdentifier(detail.dvd_id);
      if (dvdParsed) {
        addIdent("catalog_id", `${dvdParsed.rawSeries.toUpperCase()}-${dvdParsed.numericCore}`);
        addIdent("catalog_id", dvdParsed.canonical);
      }
    } else {
      addIdent("catalog_id", `${parsed.rawSeries.toUpperCase()}-${parsed.numericCore}`);
    }

    addIdent("dmm_cid", detail.content_id);
    addIdent("r18dev_content_id", detail.content_id);

    // 2. Performers: provenance without speculative alias merge
    const performers: PerformerInput[] = (detail.actresses || []).map((actress) => {
      const name =
        actress.name_kanji?.trim() ||
        actress.name_romaji?.trim() ||
        actress.name_kana?.trim() ||
        "Unknown";
      return {
        name,
        region: "asian" as const,
      };
    });

    // 3. Studio / Maker / Label / Series
    const studio =
      detail.maker_name_ja ||
      detail.maker_name_en ||
      detail.label_name_ja ||
      detail.label_name_en;

    const director =
      detail.directors?.[0]?.name_kanji || detail.directors?.[0]?.name_romaji;

    const title = detail.title_ja || detail.title_en || parsed.canonical;

    // 4. Source References
    const sourceUrl = `https://r18.dev/videos/vod/movies/detail/-/combined=${encodeURIComponent(detail.content_id)}/json`;
    const sourceReferences: SourceReferenceInput[] = [
      {
        provider: "r18dev",
        sourceUrl,
        providerAssetId: detail.content_id,
        rawTitle: detail.title_ja || detail.title_en,
      },
    ];

    // 5. Identification Evidences
    const evidences: IdentificationEvidenceInput[] = [
      {
        source: "r18dev",
        evidenceKey: "content_id",
        evidenceValue: detail.content_id,
        recordedAt: now,
      },
    ];

    const pushEvidence = (key: string, val: string | undefined | null) => {
      if (val) {
        evidences.push({
          source: "r18dev",
          evidenceKey: key,
          evidenceValue: val,
          recordedAt: now,
        });
      }
    };

    pushEvidence("dvd_id", detail.dvd_id);
    pushEvidence("title_ja", detail.title_ja);
    pushEvidence("title_en", detail.title_en);
    pushEvidence("release_date", detail.release_date);
    pushEvidence("maker_ja", detail.maker_name_ja);
    pushEvidence("maker_en", detail.maker_name_en);
    pushEvidence("label_ja", detail.label_name_ja);
    pushEvidence("label_en", detail.label_name_en);
    pushEvidence("series_ja", detail.series_name_ja);
    pushEvidence("series_en", detail.series_name_en);

    // Actress provenance (source ID, Kanji, Romaji, Kana)
    for (const actress of detail.actresses || []) {
      pushEvidence("performer:source_id", String(actress.id));
      pushEvidence(`performer:${actress.id}:source_id`, String(actress.id));
      pushEvidence(`performer:${actress.id}:kanji`, actress.name_kanji);
      pushEvidence(`performer:${actress.id}:romaji`, actress.name_romaji);
      pushEvidence(`performer:${actress.id}:kana`, actress.name_kana);
    }

    return {
      title,
      studio,
      director,
      releaseDate: detail.release_date,
      workIdentifiers,
      performers: performers.length > 0 ? performers : undefined,
      sourceReferences,
      evidences,
    };
  }
}
