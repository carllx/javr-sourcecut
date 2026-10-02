import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MediaCatalog } from "../../src/core/catalog.js";
import {
  IngestionService,
  SourceQueryFailure,
  type IdentificationSourceAdapter,
  type IngestionInput,
  type IdentificationCandidate,
} from "../../src/core/ingestion.js";
import { EpornerAdapter } from "../../src/adapters/eporner/index.js";
import { AstalaVrAdapter } from "../../src/adapters/astalavr/index.js";
import {
  resolveSourceForIngestion,
  mapSourceDescriptorToIngestionInput,
  ingestSourceWithAdapter,
} from "../../src/core/source-bridge.js";
import type { SourceDescriptor } from "../../src/types.js";

describe("Dual Entry Ingestion: Historical Media & New Material (Issue #37)", () => {
  let tempDir: string;
  let dbPath: string;
  let catalog: MediaCatalog;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dual-entry-test-"));
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

  describe("Vertical Slice 1: Historical Local Media Ingestion", () => {
    it("extracts catalog clue from directory hierarchy for generic filenames without renaming or moving original file", async () => {
      // Setup directory structure: tempDir/SSIS-088/01.mp4
      const movieDir = join(tempDir, "SSIS-088");
      mkdirSync(movieDir, { recursive: true });
      const mediaFilePath = join(movieDir, "01.mp4");
      const dummyFileBytes = "dummy historical video stream content";
      writeFileSync(mediaFilePath, dummyFileBytes, "utf-8");

      expect(existsSync(mediaFilePath)).toBe(true);

      // Metadata adapter that knows about SSIS-088
      const metadataAdapter: IdentificationSourceAdapter = {
        provider: "official-catalog",
        search: async (query) => {
          expect(query.catalogId).toBe("SSIS-088");
          return [
            {
              workIdentifiers: [{ scheme: "catalog_id", value: "SSIS-088" }],
              title: "Special Secret Island Story",
              studio: "S1",
              performers: [{ name: "Yua Mikami" }],
              releaseDate: "2023-01-01",
            },
          ];
        },
      };

      const service = new IngestionService(catalog, [metadataAdapter]);

      const input: IngestionInput = {
        localFile: {
          path: mediaFilePath,
          sizeBytes: 1048576,
          codec: "hevc",
          resolution: "2160p",
          format: "mp4",
        },
      };

      const result = await service.ingest(input);

      // 1. Ingestion succeeds and auto-confirms with corroborated metadata
      expect(result.status).toBe("library_ready");
      if (result.status === "library_ready") {
        expect(result.work.isLibraryReady).toBe(true);
        expect(result.work.title).toBe("Special Secret Island Story");
        expect(result.work.identifiers).toEqual([{ scheme: "catalog_id", value: "SSIS-088" }]);
        expect(result.work.performers[0].name).toBe("Yua Mikami");

        // 2. Crucial Invariant: Original file is untouched on disk, not renamed, not moved, not deleted
        expect(existsSync(mediaFilePath)).toBe(true);
        expect(readFileSync(mediaFilePath, "utf-8")).toBe(dummyFileBytes);

        // 3. Stored local file path in Catalog matches original path exactly
        expect(result.work.localFiles).toHaveLength(1);
        expect(result.work.localFiles[0].path).toBe(mediaFilePath);
        expect(result.work.localFiles[0].codec).toBe("hevc");
        expect(result.work.localFiles[0].resolution).toBe("2160p");

        // 4. Identification Evidences correctly record observed-filename, observed-directory, and media-properties
        const filenameEvidence = result.work.evidences.find((e) => e.source === "observed-filename");
        expect(filenameEvidence).toBeDefined();
        expect(filenameEvidence?.evidenceValue).toBe("01.mp4");

        const directoryEvidence = result.work.evidences.find(
          (e) => e.source === "observed-directory" && e.evidenceKey === "directory"
        );
        expect(directoryEvidence).toBeDefined();
        expect(directoryEvidence?.evidenceValue).toContain("SSIS-088");

        const dirCandidateEvidence = result.work.evidences.find(
          (e) => e.source === "observed-directory" && e.evidenceKey === "directory_catalog_candidate"
        );
        expect(dirCandidateEvidence).toBeDefined();
        expect(dirCandidateEvidence?.evidenceValue).toBe("SSIS-088");

        const codecEvidence = result.work.evidences.find(
          (e) => e.source === "media-properties" && e.evidenceKey === "codec"
        );
        expect(codecEvidence?.evidenceValue).toBe("hevc");

        const resEvidence = result.work.evidences.find(
          (e) => e.source === "media-properties" && e.evidenceKey === "resolution"
        );
        expect(resEvidence?.evidenceValue).toBe("2160p");
      }
    });

    it("routes historical file without matching metadata authority to pending_review (待整理), keeping file untouched", async () => {
      const movieDir = join(tempDir, "UNKNOWN-999");
      mkdirSync(movieDir, { recursive: true });
      const mediaFilePath = join(movieDir, "clip.mp4");
      writeFileSync(mediaFilePath, "unrecognized content", "utf-8");

      const emptyAdapter: IdentificationSourceAdapter = {
        provider: "empty-source",
        search: async () => [],
      };

      const service = new IngestionService(catalog, [emptyAdapter]);
      const result = await service.ingest({
        localFile: { path: mediaFilePath },
      });

      expect(result.status).toBe("pending_review");
      if (result.status === "pending_review") {
        expect(result.work.isLibraryReady).toBe(false);
        expect(result.reviewReason).toBe("no_candidates_found");
        expect(result.work.localFiles[0].path).toBe(mediaFilePath);

        // Provenance contains directory evidence
        expect(result.work.evidences.some((e) => e.source === "observed-directory")).toBe(true);

        // Original file is untouched
        expect(existsSync(mediaFilePath)).toBe(true);
      }
    });

    it("prioritizes immediate leaf directory over ancestor directories when extracting catalog clues", async () => {
      // Setup hierarchy: tempDir/ARCHIVE-001/SSIS-088/01.mp4
      // Leaf directory SSIS-088 should be chosen over ancestor ARCHIVE-001
      const nestedDir = join(tempDir, "ARCHIVE-001", "SSIS-088");
      mkdirSync(nestedDir, { recursive: true });
      const mediaFilePath = join(nestedDir, "01.mp4");
      writeFileSync(mediaFilePath, "video content", "utf-8");

      let queriedCatalogId: string | undefined;
      const metadataAdapter: IdentificationSourceAdapter = {
        provider: "catalog-authority",
        search: async (query) => {
          queriedCatalogId = query.catalogId;
          return [
            {
              workIdentifiers: [{ scheme: "catalog_id", value: "SSIS-088" }],
              title: "Special Secret Island Story",
              performers: [{ name: "Yua Mikami" }],
            },
          ];
        },
      };

      const service = new IngestionService(catalog, [metadataAdapter]);
      const result = await service.ingest({
        localFile: { path: mediaFilePath },
      });

      expect(queriedCatalogId).toBe("SSIS-088");
      expect(result.status).toBe("library_ready");
      if (result.status === "library_ready") {
        expect(result.work.identifiers[0].value).toBe("SSIS-088");
      }
    });
  });

  describe("Vertical Slice 2: New Material via Source Adapter (Eporner / AstalaVR)", () => {
    it("captures Source Reference, providerAssetId, rawTitle, and credit from Eporner page and ingests into Catalog", async () => {
      // Mock Eporner HTML page
      const sampleEpornerHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Alice in VR Wonderland 4K - EPORNER</title>
          <meta property="og:title" content="Alice in VR Wonderland 4K - EPORNER" />
          <meta property="og:duration" content="1800" />
        </head>
        <body>
          <div id="video-info">
            <ul>
              <li class="vit-pornstar"><a href="/pornstar/alice/">Alice</a></li>
              <li class="vit-pornstar"><a href="/pornstar/carol/">Carol</a></li>
            </ul>
          </div>
          <div id="downloaddiv">
            <span class="download-av1"><a href="/dload/12345/2160p-av1.mp4">2160p 60fps AV1 1.2 GB</a></span>
          </div>
        </body>
        </html>
      `;

      const mockFetch: typeof fetch = async (url) => {
        return new Response(sampleEpornerHtml, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      };

      const epornerAdapter = new EpornerAdapter();
      const sourceUrl = "https://www.eporner.com/video-12345/alice-in-vr/";
      const localFilePath = join(tempDir, "downloaded-eporner-12345.mp4");
      writeFileSync(localFilePath, "downloaded video bytes", "utf-8");

      // 1. Resolve source for ingestion using thin bridge
      const ingestionInput = await resolveSourceForIngestion(epornerAdapter, sourceUrl, {
        localFile: {
          path: localFilePath,
          sizeBytes: 1200000000,
          codec: "av1",
          resolution: "2160p",
        },
        fetchFn: mockFetch,
      });

      // Verify the generated IngestionInput captured source reference, raw title, and credit
      expect(ingestionInput.sourceReference).toEqual({
        provider: "eporner",
        sourceUrl: "https://www.eporner.com/video-12345/alice-in-vr/",
        providerAssetId: "12345",
        rawTitle: "Alice in VR Wonderland 4K",
      });
      expect(ingestionInput.clues?.performers).toEqual(["Alice", "Carol"]);
      expect(ingestionInput.clues?.providerAssetId).toBe("12345");

      // 2. Ingest without independent metadata authority candidate
      // Arbiter constraint: providerAssetId is Source Reference evidence, NOT local Work identity.
      // Without metadata authority confirmation, it must land safely in pending_review (待整理).
      const service = new IngestionService(catalog, []);
      const pendingResult = await service.ingest(ingestionInput);

      expect(pendingResult.status).toBe("pending_review");
      if (pendingResult.status === "pending_review") {
        expect(pendingResult.work.isLibraryReady).toBe(false);
        expect(pendingResult.work.title).toBe("Alice in VR Wonderland 4K");

        // Source reference is preserved on the WorkRecord
        expect(pendingResult.work.sourceReferences).toHaveLength(1);
        expect(pendingResult.work.sourceReferences[0].provider).toBe("eporner");
        expect(pendingResult.work.sourceReferences[0].providerAssetId).toBe("12345");
        expect(pendingResult.work.sourceReferences[0].sourceUrl).toBe(sourceUrl);

        // Credit / performers evidence is preserved in recorded evidences
        const creditEvidence = pendingResult.work.evidences.find(
          (e) => e.evidenceKey === "declared_performers" || e.evidenceKey === "credit_performers"
        );
        expect(creditEvidence).toBeDefined();
        expect(creditEvidence?.evidenceValue).toContain("Alice");

        // Provider asset ID is recorded as source evidence, not work identifier scheme
        const hasAssetIdAsScheme = pendingResult.work.identifiers.some(
          (i) => i.value === "12345" && i.scheme === "catalog_id"
        );
        expect(hasAssetIdAsScheme).toBe(false);
      }

      // 3. Ingest with corroborating metadata authority adapter
      const corroboratingMetadataAdapter: IdentificationSourceAdapter = {
        provider: "western-metadata-authority",
        search: async (query) => {
          expect(query.rawTitle).toBe("Alice in VR Wonderland 4K");
          expect(query.performers).toEqual(["Alice", "Carol"]);
          return [
            {
              workIdentifiers: [{ scheme: "scene_id", value: "western-alice-vr" }],
              title: "Alice in VR Wonderland",
              performers: [{ name: "Alice" }, { name: "Carol" }],
              sourceReferences: [
                {
                  provider: "eporner",
                  sourceUrl,
                  providerAssetId: "12345",
                  rawTitle: "Alice in VR Wonderland 4K",
                },
              ],
            },
          ];
        },
      };

      const corroboratedService = new IngestionService(catalog, [corroboratingMetadataAdapter]);
      const readyResult = await corroboratedService.ingest(ingestionInput);

      expect(readyResult.status).toBe("library_ready");
      if (readyResult.status === "library_ready") {
        expect(readyResult.work.isLibraryReady).toBe(true);
        expect(readyResult.work.title).toBe("Alice in VR Wonderland");
        expect(readyResult.work.performers.map((p) => p.name).sort()).toEqual(["Alice", "Carol"]);
        expect(readyResult.work.sourceReferences[0].providerAssetId).toBe("12345");
      }
    });

    it("maps source adapter resolution failure (HTTP 403 / 429) to retryable query_failed status in Catalog", async () => {
      const mock403Fetch: typeof fetch = async () => {
        return new Response("Forbidden: Cloudflare Geo-blocked", {
          status: 403,
          statusText: "Forbidden",
        });
      };

      const epornerAdapter = new EpornerAdapter();
      const sourceUrl = "https://www.eporner.com/video-99999/blocked-scene/";
      const localFilePath = join(tempDir, "local-file.mp4");
      writeFileSync(localFilePath, "dummy", "utf-8");

      const service = new IngestionService(catalog, []);

      // Ingest via helper that handles adapter resolution and feeds unified ingestion
      const result = await ingestSourceWithAdapter({
        service,
        adapter: epornerAdapter,
        sourceUrl,
        localFile: { path: localFilePath },
        fetchFn: mock403Fetch,
      });

      expect(result.status).toBe("query_failed");
      if (result.status === "query_failed") {
        expect(result.retryable).toBe(true);
        expect(result.errorCode).toBe("HTTP_403");
        expect(result.work).toBeDefined();
        expect(result.work?.reviewStatus).toBe("query_failed");
        expect(result.work?.isLibraryReady).toBe(false);

        // Source URL is preserved in the failed work's sourceReferences
        expect(result.work?.sourceReferences[0]?.sourceUrl).toBe(sourceUrl);
      }
    });

    it("supports AstalaVR source adapter and pre-resolved SourceDescriptor mapping", async () => {
      const sampleDescriptor: SourceDescriptor = {
        provider: "astalavr",
        providerAssetId: "astala-42",
        sourceUrl: "https://astalavr.com/videos/astala-42",
        rawTitle: "Mountain Retreat VR",
        declaredPerformers: ["Niko", "Maya"],
        renditions: [
          {
            formatId: "2160p-h264",
            resolution: "2160p",
            height: 2160,
            vcodec: "h264",
            directUrl: "https://cdn.example.com/video.mp4",
          },
        ],
      };

      const localFilePath = join(tempDir, "astala-42.mp4");
      writeFileSync(localFilePath, "video data", "utf-8");

      const ingestionInput = mapSourceDescriptorToIngestionInput(sampleDescriptor, {
        path: localFilePath,
        codec: "h264",
        resolution: "2160p",
      });

      expect(ingestionInput.sourceReference?.provider).toBe("astalavr");
      expect(ingestionInput.sourceReference?.providerAssetId).toBe("astala-42");
      expect(ingestionInput.clues?.performers).toEqual(["Niko", "Maya"]);

      const service = new IngestionService(catalog, []);
      const result = await service.ingest(ingestionInput);

      expect(result.status).toBe("pending_review");
      if (result.status === "pending_review") {
        expect(result.work.sourceReferences[0].provider).toBe("astalavr");
        expect(result.work.sourceReferences[0].providerAssetId).toBe("astala-42");
      }
    });

    it("resolves fixture-driven AstalaVR source URL via AstalaVrAdapter into unified Ingestion", async () => {
      const sampleAstalaHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>AstalaVR: Coastal Sunset VR</title>
          <meta property="og:title" content="Coastal Sunset VR | AstalaVR" />
          <meta property="video:actor" content="Niko" />
          <meta property="video:actor" content="Maya" />
          <meta property="video:duration" content="1200" />
        </head>
        <body>
          <main data-video-id="astala99"></main>
          <dl8-video title="Coastal Sunset VR">
            <source quality="4K" src="https://cdn3.astalavr.com/videos/astala99/2160p.mp4" />
          </dl8-video>
        </body>
        </html>
      `;

      const mockFetch: typeof fetch = async () => {
        return new Response(sampleAstalaHtml, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      };

      const astalaAdapter = new AstalaVrAdapter();
      const sourceUrl = "https://astalavr.com/videos/astala99";
      const localFilePath = join(tempDir, "astala99.mp4");
      writeFileSync(localFilePath, "video data bytes", "utf-8");

      const ingestionInput = await resolveSourceForIngestion(astalaAdapter, sourceUrl, {
        localFile: { path: localFilePath },
        fetchFn: mockFetch,
      });

      expect(ingestionInput.sourceReference?.provider).toBe("astalavr");
      expect(ingestionInput.sourceReference?.providerAssetId).toBe("astala99");
      expect(ingestionInput.sourceReference?.rawTitle).toBe("Coastal Sunset VR");
      expect(ingestionInput.clues?.performers).toEqual(["Niko", "Maya"]);

      const service = new IngestionService(catalog, []);
      const result = await service.ingest(ingestionInput);

      expect(result.status).toBe("pending_review");
      if (result.status === "pending_review") {
        expect(result.work.sourceReferences[0].provider).toBe("astalavr");
        expect(result.work.sourceReferences[0].providerAssetId).toBe("astala99");
        expect(result.work.sourceReferences[0].rawTitle).toBe("Coastal Sunset VR");
        expect(
          result.work.evidences.some(
            (e) => e.evidenceKey === "declared_performers" && e.evidenceValue.includes("Niko")
          )
        ).toBe(true);
      }
    });
  });
});
