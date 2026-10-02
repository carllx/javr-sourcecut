import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MediaCatalog } from "../../src/core/catalog.js";
import {
  IngestionService,
  SourceQueryFailure,
  type IdentificationSourceAdapter,
  type IngestionInput,
  type IdentificationCandidate,
  type IngestionQuery,
} from "../../src/core/ingestion.js";

describe("Unified Ingestion Tracer Bullet (Issue #36)", () => {
  let tempDir: string;
  let dbPath: string;
  let catalog: MediaCatalog;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ingestion-test-"));
    dbPath = join(tempDir, "catalog.sqlite");
    catalog = MediaCatalog.open(dbPath);
  });

  afterEach(() => {
    try {
      catalog.close();
    } catch {
      // ignore
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("automatically confirms reliable and unambiguous Work identity + Local File into Library Ready", async () => {
    const fakeAdapter: IdentificationSourceAdapter = {
      provider: "fake-provider",
      search: async (query: IngestionQuery): Promise<IdentificationCandidate[]> => {
        expect(query.catalogId).toBe("WAVR-110");
        return [
          {
            workIdentifiers: [{ scheme: "catalog_id", value: "WAVR-110" }],
            title: "Alice in VR Wonderland",
            studio: "W-Agency",
            performers: [{ name: "Alice", aliases: ["Alice A."] }],
            sourceReferences: [
              {
                provider: "fake-provider",
                sourceUrl: "https://example.com/works/wavr-110",
                providerAssetId: "wavr110",
                rawTitle: "Alice in VR Wonderland 4K",
              },
            ],
            releaseDate: "2024-05-01",
          },
        ];
      },
    };

    const service = new IngestionService(catalog, [fakeAdapter]);

    const input: IngestionInput = {
      localFile: {
        path: "D:/Media/WAVR-110.mp4",
        sizeBytes: 1024000,
        codec: "av1",
        resolution: "2160p",
      },
    };

    const result = await service.ingest(input);

    expect(result.status).toBe("library_ready");
    if (result.status === "library_ready") {
      expect(result.work.isLibraryReady).toBe(true);
      expect(result.work.title).toBe("Alice in VR Wonderland");
      expect(result.work.identifiers).toEqual([{ scheme: "catalog_id", value: "WAVR-110" }]);
      expect(result.work.performers[0].name).toBe("Alice");
      expect(result.work.localFiles).toHaveLength(1);
      expect(result.work.localFiles[0].path).toBe("D:/Media/WAVR-110.mp4");

      // Verify provenance is recorded
      expect(result.work.evidences.some((e) => e.source === "observed-filename")).toBe(true);
      expect(result.work.evidences.some((e) => e.source.startsWith("source-adapter:"))).toBe(true);
      expect(result.work.sourceReferences).toHaveLength(1);

      // Verify persistence and restoration in a fresh catalog instance
      catalog.close();
      const reopened = MediaCatalog.open(dbPath);
      try {
        const restored = reopened.getWork(result.work.id);
        expect(restored).not.toBeNull();
        expect(restored?.isLibraryReady).toBe(true);
        expect(restored?.title).toBe("Alice in VR Wonderland");

        const foundById = reopened.findWorkByIdentifier("catalog_id", "WAVR-110");
        expect(foundById?.id).toBe(result.work.id);

        const foundFile = reopened.findLocalFileByPath("D:/Media/WAVR-110.mp4");
        expect(foundFile?.workId).toBe(result.work.id);
      } finally {
        reopened.close();
      }
    }
  });

  it("routes approximate catalog number (近似番号) to 待整理, not auto-confirming", async () => {
    // Clue is MDVR-28, adapter returns MDVR-288 (prefix match trap)
    const fakeAdapter: IdentificationSourceAdapter = {
      provider: "test-adapter",
      search: async (_query): Promise<IdentificationCandidate[]> => {
        return [
          {
            workIdentifiers: [{ scheme: "catalog_id", value: "MDVR-288" }],
            title: "Trap Candidate MDVR-288",
            studio: "Moodyz",
            performers: [{ name: "Bob" }],
          },
        ];
      },
    };

    const service = new IngestionService(catalog, [fakeAdapter]);

    const input: IngestionInput = {
      localFile: { path: "D:/Media/MDVR-28.mp4" },
      clues: { catalogId: "MDVR-28" },
    };

    const result = await service.ingest(input);

    expect(result.status).toBe("pending_review");
    if (result.status === "pending_review") {
      expect(result.work.isLibraryReady).toBe(false);
      expect(result.work.reviewStatus).toBe("pending_review");
      expect(result.reviewReason).toBe("approximate_identifier_mismatch");
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates?.[0].workIdentifiers[0].value).toBe("MDVR-288");

      // Verify it appears in pending reviews
      const pendingReviews = catalog.getPendingReviews();
      expect(pendingReviews.some((w) => w.id === result.work.id)).toBe(true);
    }
  });

  it("routes same performer with different candidate works to 待整理, not auto-confirming", async () => {
    // Clue specifies performer only, adapter returns multiple works by that performer
    const fakeAdapter: IdentificationSourceAdapter = {
      provider: "test-adapter",
      search: async (_query): Promise<IdentificationCandidate[]> => {
        return [
          {
            workIdentifiers: [{ scheme: "catalog_id", value: "WRK-001" }],
            title: "Alice Scene 1",
            performers: [{ name: "Alice" }],
          },
          {
            workIdentifiers: [{ scheme: "catalog_id", value: "WRK-002" }],
            title: "Alice Scene 2",
            performers: [{ name: "Alice" }],
          },
        ];
      },
    };

    const service = new IngestionService(catalog, [fakeAdapter]);

    const input: IngestionInput = {
      localFile: { path: "D:/Media/Alice_Scene.mp4" },
      clues: { performers: ["Alice"] },
    };

    const result = await service.ingest(input);

    expect(result.status).toBe("pending_review");
    if (result.status === "pending_review") {
      expect(result.work.isLibraryReady).toBe(false);
      expect(result.reviewReason).toBe("same_performer_different_works");
      expect(result.candidates).toHaveLength(2);
    }
  });

  it("routes conflicting studio/title metadata to 待整理, not auto-confirming", async () => {
    const fakeAdapter: IdentificationSourceAdapter = {
      provider: "test-adapter",
      search: async (_query): Promise<IdentificationCandidate[]> => {
        return [
          {
            workIdentifiers: [{ scheme: "catalog_id", value: "SIVR-340" }],
            title: "Winter Mountain Trip",
            studio: "IdeaPocket", // Clue says S1
            performers: [{ name: "Niko" }],
          },
        ];
      },
    };

    const service = new IngestionService(catalog, [fakeAdapter]);

    const input: IngestionInput = {
      localFile: { path: "D:/Media/SIVR-340.mp4" },
      clues: {
        catalogId: "SIVR-340",
        studio: "S1", // Contradicts IdeaPocket
      },
    };

    const result = await service.ingest(input);

    expect(result.status).toBe("pending_review");
    if (result.status === "pending_review") {
      expect(result.work.isLibraryReady).toBe(false);
      expect(result.reviewReason).toBe("conflicting_studio");
    }
  });

  describe("Failure Modes (403, 429, Challenge, Auth, Malformed)", () => {
    it("treats HTTP 403 as retryable query failure, NOT as 'no metadata'", async () => {
      const failingAdapter: IdentificationSourceAdapter = {
        provider: "geo-blocked-adapter",
        search: async (): Promise<IdentificationCandidate[]> => {
          throw new SourceQueryFailure("HTTP_403", "403 Forbidden: Geo-blocked IP", true);
        },
      };

      const service = new IngestionService(catalog, [failingAdapter]);
      const result = await service.ingest({
        localFile: { path: "D:/Media/TEST-001.mp4" },
      });

      expect(result.status).toBe("query_failed");
      if (result.status === "query_failed") {
        expect(result.retryable).toBe(true);
        expect(result.errorCode).toBe("HTTP_403");
        expect(result.errorMessage).toContain("403 Forbidden");

        // Verify it was NOT recorded as "no metadata"
        if (result.work) {
          expect(result.work.reviewStatus).toBe("query_failed");
          expect(result.work.isLibraryReady).toBe(false);
        }
      }
    });

    it("treats HTTP 429 rate limit as retryable query failure", async () => {
      const failingAdapter: IdentificationSourceAdapter = {
        provider: "rate-limited-adapter",
        search: async (): Promise<IdentificationCandidate[]> => {
          throw new SourceQueryFailure("HTTP_429", "429 Too Many Requests: Rate limited", true);
        },
      };

      const service = new IngestionService(catalog, [failingAdapter]);
      const result = await service.ingest({
        localFile: { path: "D:/Media/TEST-429.mp4" },
      });

      expect(result.status).toBe("query_failed");
      if (result.status === "query_failed") {
        expect(result.retryable).toBe(true);
        expect(result.errorCode).toBe("HTTP_429");
      }
    });

    it("treats Cloudflare Turnstile challenge shell (HTTP 200 HTML) as retryable failure", async () => {
      const challengeAdapter: IdentificationSourceAdapter = {
        provider: "cf-adapter",
        search: async (): Promise<IdentificationCandidate[]> => {
          throw new SourceQueryFailure(
            "CHALLENGE_SHELL",
            "Turnstile challenge detected in HTTP 200 HTML response",
            true
          );
        },
      };

      const service = new IngestionService(catalog, [challengeAdapter]);
      const result = await service.ingest({
        localFile: { path: "D:/Media/TEST-CF.mp4" },
      });

      expect(result.status).toBe("query_failed");
      if (result.status === "query_failed") {
        expect(result.retryable).toBe(true);
        expect(result.errorCode).toBe("CHALLENGE_SHELL");
      }
    });

    it("treats malformed structural response as retryable query failure", async () => {
      const malformedAdapter: IdentificationSourceAdapter = {
        provider: "broken-adapter",
        search: async (): Promise<IdentificationCandidate[]> => {
          throw new SourceQueryFailure(
            "MALFORMED_RESPONSE",
            "Unexpected HTML structure / JSON syntax error",
            true
          );
        },
      };

      const service = new IngestionService(catalog, [malformedAdapter]);
      const result = await service.ingest({
        localFile: { path: "D:/Media/TEST-BROKEN.mp4" },
      });

      expect(result.status).toBe("query_failed");
      if (result.status === "query_failed") {
        expect(result.retryable).toBe(true);
        expect(result.errorCode).toBe("MALFORMED_RESPONSE");
      }
    });

    it("distinguishes clean zero results ('no metadata') from query failure", async () => {
      const emptyAdapter: IdentificationSourceAdapter = {
        provider: "empty-adapter",
        search: async (): Promise<IdentificationCandidate[]> => {
          return []; // Clean search succeeded, 0 candidates
        },
      };

      const service = new IngestionService(catalog, [emptyAdapter]);
      const result = await service.ingest({
        localFile: { path: "D:/Media/UNKNOWN-999.mp4" },
      });

      // 0 candidates enters pending_review (待整理), NOT query_failed
      expect(result.status).toBe("pending_review");
      if (result.status === "pending_review") {
        expect(result.reviewReason).toBe("no_candidates_found");
        expect(result.work.isLibraryReady).toBe(false);
      }
    });
  });

  it("updates central Catalog upon manual confirmation/correction and serves as shared truth", async () => {
    // 1. Initial ingestion lands in 待整理 due to ambiguity
    const ambiguousAdapter: IdentificationSourceAdapter = {
      provider: "test-adapter",
      search: async (): Promise<IdentificationCandidate[]> => {
        return [
          {
            workIdentifiers: [{ scheme: "catalog_id", value: "MDVR-288" }],
            title: "Approximate Candidate MDVR-288",
            performers: [{ name: "Alice" }],
          },
        ];
      },
    };

    const service = new IngestionService(catalog, [ambiguousAdapter]);
    const initResult = await service.ingest({
      localFile: { path: "D:/Media/MDVR-28.mp4" },
      clues: { catalogId: "MDVR-28" },
    });

    expect(initResult.status).toBe("pending_review");
    const workId = initResult.work!.id;

    // 2. User manually corrects / resolves the pending item
    const resolvedWork = service.resolveReview(workId, {
      title: "Corrected Title MDVR-28",
      identifiers: [{ scheme: "catalog_id", value: "MDVR-028" }],
      performers: [{ name: "Alice Example", aliases: ["Alice"] }],
      notes: "User confirmed catalog number MDVR-028",
    });

    expect(resolvedWork.isLibraryReady).toBe(true);
    expect(resolvedWork.reviewStatus).toBe("ready");
    expect(resolvedWork.title).toBe("Corrected Title MDVR-28");
    expect(resolvedWork.performers[0].name).toBe("Alice Example");
    expect(
      resolvedWork.evidences.some((e) => e.source === "user-manual-correction")
    ).toBe(true);

    // 3. Verify that reopen restores this corrected Work as shared truth
    catalog.close();
    const reopened = MediaCatalog.open(dbPath);
    try {
      const workFromDb = reopened.getWork(workId);
      expect(workFromDb?.isLibraryReady).toBe(true);
      expect(workFromDb?.title).toBe("Corrected Title MDVR-28");
      expect(workFromDb?.reviewStatus).toBe("ready");

      // Verify lookup by newly confirmed identifier
      const foundByIdent = reopened.findWorkByIdentifier("catalog_id", "MDVR-028");
      expect(foundByIdent?.id).toBe(workId);

      // Verify local file association
      const file = reopened.findLocalFileByPath("D:/Media/MDVR-28.mp4");
      expect(file?.workId).toBe(workId);

      // Verify it is no longer in pending reviews
      const pendingList = reopened.getPendingReviews();
      expect(pendingList.some((w) => w.id === workId)).toBe(false);
    } finally {
      reopened.close();
    }
  });

  it("never renames, moves, or deletes local media files during ingestion", async () => {
    // Create an actual media file on disk
    const dummyFilePath = join(tempDir, "ORIGINAL-WAVR-110.mp4");
    const dummyContent = "dummy video content bytes";
    writeFileSync(dummyFilePath, dummyContent, "utf-8");

    expect(existsSync(dummyFilePath)).toBe(true);

    const fakeAdapter: IdentificationSourceAdapter = {
      provider: "fake-provider",
      search: async () => [
        {
          workIdentifiers: [{ scheme: "catalog_id", value: "WAVR-110" }],
          title: "Unmodified File Work",
          performers: [{ name: "Alice" }],
        },
      ],
    };

    const service = new IngestionService(catalog, [fakeAdapter]);

    // Perform ingestion
    const result = await service.ingest({
      localFile: { path: dummyFilePath },
    });

    expect(result.status).toBe("library_ready");

    // Assert that the file at the original path is untouched, unchanged, and present
    expect(existsSync(dummyFilePath)).toBe(true);
    expect(readFileSync(dummyFilePath, "utf-8")).toBe(dummyContent);
  });

  it("routes candidate without work identifier or provider asset ID to 待整理 (unconfirmed_identity)", async () => {
    const unconfirmedAdapter: IdentificationSourceAdapter = {
      provider: "vague-adapter",
      search: async () => [
        {
          workIdentifiers: [], // empty identifiers!
          title: "Vague Candidate Without ID",
          performers: [{ name: "Alice" }],
        },
      ],
    };

    const service = new IngestionService(catalog, [unconfirmedAdapter]);
    const result = await service.ingest({
      localFile: { path: "D:/Media/Vague_Scene.mp4" },
    });

    expect(result.status).toBe("pending_review");
    if (result.status === "pending_review") {
      expect(result.reviewReason).toBe("unconfirmed_identity");
      expect(result.work.isLibraryReady).toBe(false);
    }
  });

  it("falls back to secondary adapter if primary adapter experiences a query failure", async () => {
    const failingPrimaryAdapter: IdentificationSourceAdapter = {
      provider: "failing-primary",
      search: async () => {
        throw new SourceQueryFailure("HTTP_403", "Primary adapter blocked");
      },
    };

    const workingSecondaryAdapter: IdentificationSourceAdapter = {
      provider: "working-secondary",
      search: async () => [
        {
          workIdentifiers: [{ scheme: "catalog_id", value: "WAVR-200" }],
          title: "Secondary Adapter Success",
          performers: [{ name: "Bob" }],
        },
      ],
    };

    const service = new IngestionService(catalog, [
      failingPrimaryAdapter,
      workingSecondaryAdapter,
    ]);

    const result = await service.ingest({
      localFile: { path: "D:/Media/WAVR-200.mp4" },
      clues: { catalogId: "WAVR-200" },
    });

    // Successfully completed via secondary adapter!
    expect(result.status).toBe("library_ready");
    if (result.status === "library_ready") {
      expect(result.work.title).toBe("Secondary Adapter Success");
    }
  });

  it("routes conflicting title metadata to 待整理", async () => {
    const fakeAdapter: IdentificationSourceAdapter = {
      provider: "test-adapter",
      search: async () => [
        {
          workIdentifiers: [{ scheme: "catalog_id", value: "WAVR-300" }],
          title: "Snowy Mountain Winter",
          performers: [{ name: "Alice" }],
        },
      ],
    };

    const service = new IngestionService(catalog, [fakeAdapter]);
    const result = await service.ingest({
      localFile: { path: "D:/Media/WAVR-300.mp4" },
      clues: {
        rawTitle: "Tropical Beach Summer Party", // Contradicts Snowy Mountain Winter
      },
    });

    expect(result.status).toBe("pending_review");
    if (result.status === "pending_review") {
      expect(result.reviewReason).toBe("conflicting_title");
    }
  });

  it("does not auto-confirm when query has catalog ID but candidate has unrelated or missing catalog identifier", async () => {
    // Query has SIVR-340, but candidate only has an unrelated DMM CID without SIVR-340
    const fakeAdapter: IdentificationSourceAdapter = {
      provider: "dmm-provider",
      search: async () => [
        {
          workIdentifiers: [{ scheme: "dmm_cid", value: "unrelated999" }],
          title: "Some Other Work",
          performers: [{ name: "Alice" }],
        },
      ],
    };

    const service = new IngestionService(catalog, [fakeAdapter]);
    const result = await service.ingest({
      localFile: { path: "D:/Media/SIVR-340.mp4" },
      clues: { catalogId: "SIVR-340" },
    });

    expect(result.status).toBe("pending_review");
    if (result.status === "pending_review") {
      expect(result.work.isLibraryReady).toBe(false);
      expect(result.reviewReason).toBe("approximate_identifier_mismatch");
    }
  });

  it("auto-confirms Western Work into Library Ready when provider, title, and performer match strongly without catalog ID", async () => {
    // Western work: No catalog ID, no providerAssetId/scene ID
    const westernAdapter: IdentificationSourceAdapter = {
      provider: "badoinkvr",
      search: async (query) => {
        expect(query.rawTitle).toBe("Kush Queen");
        return [
          {
            workIdentifiers: [], // No catalog number!
            title: "Kush Queen",
            studio: "BaDoinkVR",
            performers: [{ name: "Jade Kush" }],
            sourceReferences: [
              {
                provider: "badoinkvr",
                sourceUrl: "https://badoinkvr.com/scenes/kush-queen",
                rawTitle: "Kush Queen",
              },
            ],
          },
        ];
      },
    };

    const service = new IngestionService(catalog, [westernAdapter]);
    const result = await service.ingest({
      localFile: { path: "D:/Media/Jade Kush - Kush Queen - BaDoinkVR.mp4" },
      clues: {
        rawTitle: "Kush Queen",
        studio: "BaDoinkVR",
        performers: ["Jade Kush"],
      },
    });

    expect(result.status).toBe("library_ready");
    if (result.status === "library_ready") {
      expect(result.work.isLibraryReady).toBe(true);
      expect(result.work.title).toBe("Kush Queen");
      expect(result.work.performers[0].name).toBe("Jade Kush");
      expect(result.work.sourceReferences[0].provider).toBe("badoinkvr");
    }
  });

  it("merges equivalent candidates from multiple adapters for the same Work into Library Ready without multiple_candidates ambiguity", async () => {
    // Two adapters returning the same work (e.g. DMM and Eporner agreeing on WAVR-110)
    const dmmAdapter: IdentificationSourceAdapter = {
      provider: "dmm",
      search: async () => [
        {
          workIdentifiers: [
            { scheme: "catalog_id", value: "WAVR-110" },
            { scheme: "dmm_cid", value: "wavr00110" },
          ],
          title: "Alice in VR Wonderland",
          studio: "W-Agency",
          performers: [{ name: "Alice", aliases: ["アリス"] }],
          sourceReferences: [
            {
              provider: "dmm",
              sourceUrl: "https://www.dmm.co.jp/mono/dvd/-/detail/=/cid=wavr00110",
              providerAssetId: "wavr00110",
            },
          ],
        },
      ],
    };

    const epornerAdapter: IdentificationSourceAdapter = {
      provider: "eporner",
      search: async () => [
        {
          workIdentifiers: [{ scheme: "catalog_id", value: "WAVR-110" }],
          title: "Alice in VR Wonderland 4K",
          performers: [{ name: "Alice" }],
          sourceReferences: [
            {
              provider: "eporner",
              sourceUrl: "https://www.eporner.com/video-12345/alice-vr/",
              providerAssetId: "12345",
            },
          ],
        },
      ],
    };

    const service = new IngestionService(catalog, [dmmAdapter, epornerAdapter]);
    const result = await service.ingest({
      localFile: { path: "D:/Media/WAVR-110.mp4" },
      clues: { catalogId: "WAVR-110" },
    });

    // Should be merged into 1 candidate and confirmed to Library Ready!
    expect(result.status).toBe("library_ready");
    if (result.status === "library_ready") {
      expect(result.work.isLibraryReady).toBe(true);
      expect(result.work.title).toBe("Alice in VR Wonderland");

      // Verify merged source references from BOTH adapters
      expect(result.work.sourceReferences).toHaveLength(2);
      expect(result.work.sourceReferences.some((r) => r.provider === "dmm")).toBe(true);
      expect(result.work.sourceReferences.some((r) => r.provider === "eporner")).toBe(true);

      // Verify merged identifiers
      expect(result.work.identifiers).toHaveLength(2);
      expect(result.work.identifiers.some((i) => i.scheme === "catalog_id")).toBe(true);
      expect(result.work.identifiers.some((i) => i.scheme === "dmm_cid")).toBe(true);
    }
  });

  it("persists all competing candidates and key provenance across Catalog close and reopen for pending review items", async () => {
    // Ingest a file with true ambiguity (2 distinct candidate works)
    const ambiguousAdapter: IdentificationSourceAdapter = {
      provider: "multi-work-adapter",
      search: async () => [
        {
          workIdentifiers: [{ scheme: "catalog_id", value: "WRK-101" }],
          title: "Alice First Scene",
          studio: "Studio Alpha",
          performers: [{ name: "Alice", aliases: ["Ali"] }],
          sourceReferences: [
            {
              provider: "multi-work-adapter",
              sourceUrl: "https://example.com/works/wrk-101",
              providerAssetId: "asset-101",
              rawTitle: "Alice First Scene 4K",
            },
          ],
        },
        {
          workIdentifiers: [{ scheme: "catalog_id", value: "WRK-202" }],
          title: "Alice Second Scene",
          studio: "Studio Beta",
          performers: [{ name: "Alice", aliases: ["Alicia"] }],
          sourceReferences: [
            {
              provider: "multi-work-adapter",
              sourceUrl: "https://example.com/works/wrk-202",
              providerAssetId: "asset-202",
              rawTitle: "Alice Second Scene 4K",
            },
          ],
        },
      ],
    };

    const service = new IngestionService(catalog, [ambiguousAdapter]);
    const result = await service.ingest({
      localFile: { path: "D:/Media/Alice_Unclear.mp4" },
      clues: { performers: ["Alice"] },
    });

    expect(result.status).toBe("pending_review");
    const workId = result.work!.id;

    // Verify both candidates are in result
    expect(result.candidates).toHaveLength(2);

    // Close SQLite database
    catalog.close();

    // Reopen from disk in a fresh instance
    const reopened = MediaCatalog.open(dbPath);
    try {
      const restoredWork = reopened.getWork(workId);
      expect(restoredWork).not.toBeNull();
      expect(restoredWork?.isLibraryReady).toBe(false);
      expect(restoredWork?.reviewStatus).toBe("pending_review");
      expect(restoredWork?.reviewReason).toBe("same_performer_different_works");

      // Verify all competing candidates survived reopen with full details!
      expect(restoredWork?.reviewCandidates).toBeDefined();
      expect(restoredWork?.reviewCandidates).toHaveLength(2);

      const cand1 = restoredWork?.reviewCandidates?.[0];
      expect(cand1?.title).toBe("Alice First Scene");
      expect(cand1?.studio).toBe("Studio Alpha");
      expect(cand1?.identifiers[0]).toEqual({ scheme: "catalog_id", value: "WRK-101" });
      expect(cand1?.performers[0].name).toBe("Alice");
      expect(cand1?.performers[0].aliases).toEqual(["Ali"]);
      expect(cand1?.sourceReferences[0].providerAssetId).toBe("asset-101");
      expect(cand1?.sourceReferences[0].sourceUrl).toBe("https://example.com/works/wrk-101");

      const cand2 = restoredWork?.reviewCandidates?.[1];
      expect(cand2?.title).toBe("Alice Second Scene");
      expect(cand2?.studio).toBe("Studio Beta");
      expect(cand2?.identifiers[0]).toEqual({ scheme: "catalog_id", value: "WRK-202" });
      expect(cand2?.performers[0].name).toBe("Alice");
      expect(cand2?.performers[0].aliases).toEqual(["Alicia"]);
      expect(cand2?.sourceReferences[0].providerAssetId).toBe("asset-202");
      expect(cand2?.sourceReferences[0].sourceUrl).toBe("https://example.com/works/wrk-202");

      // Verify all source references are also accessible on the work
      expect(restoredWork?.sourceReferences).toHaveLength(2);
      expect(restoredWork?.sourceReferences.some((r) => r.providerAssetId === "asset-101")).toBe(true);
      expect(restoredWork?.sourceReferences.some((r) => r.providerAssetId === "asset-202")).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it("does not auto-confirm when query has a catalogId but candidate completely lacks matching identifier", async () => {
    const missingIdAdapter: IdentificationSourceAdapter = {
      provider: "dmm-unrelated",
      search: async () => [
        {
          title: "Unrelated Video Title",
          workIdentifiers: [{ scheme: "dmm_id", value: "dmm-9999" }],
          sourceReferences: [{ provider: "dmm", providerAssetId: "dmm-9999" }],
        },
      ],
    };

    const service = new IngestionService(catalog, [missingIdAdapter]);
    const result = await service.ingest({
      localFile: { path: "D:/Media/SIVR-340.mp4" },
      clues: { catalogId: "SIVR-340" },
    });

    expect(result.status).toBe("pending_review");
    if (result.status === "pending_review") {
      expect(result.reviewReason).toBe("approximate_identifier_mismatch");
      expect(result.work.isLibraryReady).toBe(false);
    }
  });

  it("does not auto-confirm Western work with title alone without performer corroboration", async () => {
    const titleOnlyAdapter: IdentificationSourceAdapter = {
      provider: "western-adapter",
      search: async () => [
        {
          title: "A Common Generic Title",
          performers: [{ name: "Some Actor" }],
        },
      ],
    };

    const service = new IngestionService(catalog, [titleOnlyAdapter]);
    const result = await service.ingest({
      localFile: { path: "D:/Media/A_Common_Generic_Title.mp4" },
      clues: { rawTitle: "A Common Generic Title" },
    });

    expect(result.status).toBe("pending_review");
    if (result.status === "pending_review") {
      expect(result.reviewReason).toBe("unconfirmed_identity");
      expect(result.work.isLibraryReady).toBe(false);
    }
  });

  it("hard-negative: does not auto-confirm when identifier value matches but scheme is wrong", async () => {
    const wrongSchemeAdapter: IdentificationSourceAdapter = {
      provider: "dmm",
      search: async () => [
        {
          title: "Some Title",
          // Candidate has value 12345, but under an unrelated scheme like dmm_id or custom_id instead of catalog_id/scene_id
          workIdentifiers: [{ scheme: "dmm_id", value: "12345" }],
          sourceReferences: [{ provider: "dmm", providerAssetId: "12345" }],
        },
      ],
    };

    const service = new IngestionService(catalog, [wrongSchemeAdapter]);
    const result = await service.ingest({
      localFile: { path: "D:/Media/12345.mp4" },
      clues: { catalogId: "12345" },
    });

    expect(result.status).toBe("pending_review");
    if (result.status === "pending_review") {
      expect(result.reviewReason).toBe("approximate_identifier_mismatch");
      expect(result.work.isLibraryReady).toBe(false);
    }
  });

  it("hard-negative: does not auto-confirm when providerAssetId matches but provider namespace is wrong", async () => {
    const wrongProviderAdapter: IdentificationSourceAdapter = {
      provider: "badoinkvr",
      search: async () => [
        {
          title: "Scene 12345",
          sourceReferences: [{ provider: "badoinkvr", providerAssetId: "12345" }],
        },
      ],
    };

    const service = new IngestionService(catalog, [wrongProviderAdapter]);
    const result = await service.ingest({
      localFile: { path: "D:/Media/video.mp4" },
      clues: {
        provider: "eporner",
        providerAssetId: "12345",
      },
    });

    expect(result.status).toBe("pending_review");
    if (result.status === "pending_review") {
      expect(result.reviewReason).toBe("approximate_identifier_mismatch");
      expect(result.work.isLibraryReady).toBe(false);
    }
  });

  it("hard-negative: does not merge or auto-confirm no-ID works with same performer + studio when titles only partially overlap", async () => {
    // Two scenes by same performer & studio, with words overlapping but clearly distinct titles
    const diffSceneAdapter: IdentificationSourceAdapter = {
      provider: "studio-x",
      search: async () => [
        {
          title: "Alice Beach Vacation 2",
          studio: "Beach Productions",
          performers: [{ name: "Alice" }],
        },
      ],
    };

    const service = new IngestionService(catalog, [diffSceneAdapter]);
    const result = await service.ingest({
      localFile: { path: "D:/Media/Alice Beach Party 1.mp4" },
      clues: {
        rawTitle: "Alice Beach Party 1",
        studio: "Beach Productions",
        performers: ["Alice"],
      },
    });

    expect(result.status).toBe("pending_review");
    if (result.status === "pending_review") {
      expect(result.reviewReason).toBe("unconfirmed_identity");
      expect(result.work.isLibraryReady).toBe(false);
    }
  });
});
