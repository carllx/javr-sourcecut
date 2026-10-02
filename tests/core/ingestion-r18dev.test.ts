import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MediaCatalog } from "../../src/core/catalog.js";
import { IngestionService, type IngestionInput } from "../../src/core/ingestion.js";
import { R18DevAdapter } from "../../src/adapters/r18dev/adapter.js";

const FIXTURES_DIR = join(process.cwd(), "tests", "fixtures", "r18dev");

function loadFixture(filename: string): string {
  return readFileSync(join(FIXTURES_DIR, filename), "utf-8");
}

describe("R18.dev Integration with Unified Ingestion (Issue #38 Seam 4)", () => {
  let tempDir: string;
  let dbPath: string;
  let catalog: MediaCatalog;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ingestion-r18dev-test-"));
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

  it("extracts JAV clue from filename, queries R18.dev combined=sivr00340, and auto-confirms into Library Ready", async () => {
    const sivrFixture = loadFixture("sivr00340.json");
    const mockFetch: typeof fetch = async (url) => {
      expect(String(url)).toContain("combined=sivr00340/json");
      return new Response(sivrFixture, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const r18Adapter = new R18DevAdapter({ fetchFn: mockFetch });
    const service = new IngestionService(catalog, [r18Adapter]);

    const localFilePath = join(tempDir, "Kawagoe Niko - SIVR340+b-proj.llc");
    writeFileSync(localFilePath, "dummy media content", "utf-8");

    const input: IngestionInput = {
      localFile: {
        path: localFilePath,
        sizeBytes: 1048576,
        format: "llc",
      },
    };

    const result = await service.ingest(input);

    expect(result.status).toBe("library_ready");
    if (result.status === "library_ready") {
      expect(result.work.isLibraryReady).toBe(true);
      expect(result.work.title).toContain("川越にこ");
      expect(result.work.identifiers.some((i) => i.scheme === "catalog_id" && i.value === "SIVR-340")).toBe(true);
      expect(result.work.identifiers.some((i) => i.scheme === "dmm_cid" && i.value === "sivr00340")).toBe(true);
      expect(result.work.performers).toHaveLength(1);
      expect(result.work.performers[0].name).toBe("川越にこ");
      expect(result.work.performers[0].region).toBe("unclassified");

      // Verify source reference captured
      expect(result.work.sourceReferences).toHaveLength(1);
      expect(result.work.sourceReferences[0].provider).toBe("r18dev");
      expect(result.work.sourceReferences[0].providerAssetId).toBe("sivr00340");

      // Verify file remains on disk untouched
      expect(existsSync(localFilePath)).toBe(true);
      expect(readFileSync(localFilePath, "utf-8")).toBe("dummy media content");

      // Verify persistence and restoration upon reopen
      catalog.close();
      const reopened = MediaCatalog.open(dbPath);
      try {
        const foundWork = reopened.findWorkByIdentifier("catalog_id", "SIVR-340");
        expect(foundWork).not.toBeNull();
        expect(foundWork?.isLibraryReady).toBe(true);
        expect(foundWork?.title).toContain("川越にこ");
        expect(foundWork?.performers[0].name).toBe("川越にこ");

        const foundFile = reopened.findLocalFileByPath(localFilePath);
        expect(foundFile?.workId).toBe(foundWork?.id);
      } finally {
        reopened.close();
      }
    }
  });

  it("missing DOB, Region, or Shoot Date does NOT block confirmed Work from becoming Library Ready", async () => {
    // SIVR-340 has release date but no DOB, no shoot date
    const sivrFixture = loadFixture("sivr00340.json");
    const mockFetch: typeof fetch = async () => {
      return new Response(sivrFixture, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const r18Adapter = new R18DevAdapter({ fetchFn: mockFetch });
    const service = new IngestionService(catalog, [r18Adapter]);

    const result = await service.ingest({
      localFile: { path: "D:/Media/SIVR-340.mp4" },
      clues: { catalogId: "SIVR-340" },
    });

    expect(result.status).toBe("library_ready");
    if (result.status === "library_ready") {
      expect(result.work.isLibraryReady).toBe(true);
      expect(result.work.shootDate).toBeFalsy();
      expect(result.work.performers[0].dateOfBirth).toBeFalsy();
      expect(result.work.performers[0].region).toBe("unclassified");
    }
  });

  it("hard negative: SIVR-340 query receiving sivr00034 false positive fails closed as IDENTITY_MISMATCH, not no-result", async () => {
    // Simulating false positive response sivr00034 for SIVR-340 query
    const falsePositiveFixture = loadFixture("sivr00034.json");
    const mockFetch: typeof fetch = async () => {
      return new Response(falsePositiveFixture, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const r18Adapter = new R18DevAdapter({ fetchFn: mockFetch });
    const service = new IngestionService(catalog, [r18Adapter]);

    const result = await service.ingest({
      localFile: { path: "D:/Media/SIVR-340.mp4" },
      clues: { catalogId: "SIVR-340" },
    });

    // Fails closed as non-retryable query failure with code IDENTITY_MISMATCH
    expect(result.status).toBe("query_failed");
    if (result.status === "query_failed") {
      expect(result.retryable).toBe(false);
      expect(result.errorCode).toBe("IDENTITY_MISMATCH");
      expect(result.errorMessage).toContain("sivr00034");

      // Verify work is NOT library ready
      expect(result.work?.isLibraryReady).toBe(false);
      expect(result.work?.reviewStatus).toBe("query_failed");
    }
  });

  it("clean 404 NOT_FOUND routes work to pending_review with no_candidates_found", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response("Not Found", { status: 404 });
    };

    const r18Adapter = new R18DevAdapter({ fetchFn: mockFetch });
    const service = new IngestionService(catalog, [r18Adapter]);

    const result = await service.ingest({
      localFile: { path: "D:/Media/NONEXISTENT-999.mp4" },
      clues: { catalogId: "NONEXISTENT-999" },
    });

    expect(result.status).toBe("pending_review");
    if (result.status === "pending_review") {
      expect(result.reviewReason).toBe("no_candidates_found");
      expect(result.work.isLibraryReady).toBe(false);
    }
  });

  it("429 rate limit maps to retryable query_failed status", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response("Too Many Requests", { status: 429 });
    };

    const r18Adapter = new R18DevAdapter({ fetchFn: mockFetch });
    const service = new IngestionService(catalog, [r18Adapter]);

    const result = await service.ingest({
      localFile: { path: "D:/Media/SIVR-340.mp4" },
      clues: { catalogId: "SIVR-340" },
    });

    expect(result.status).toBe("query_failed");
    if (result.status === "query_failed") {
      expect(result.retryable).toBe(true);
      expect(result.errorCode).toBe("HTTP_429");
    }
  });

  it("Turnstile HTML challenge maps to retryable CHALLENGE_SHELL status", async () => {
    const challengeHtml = loadFixture("turnstile-challenge.html");
    const mockFetch: typeof fetch = async () => {
      return new Response(challengeHtml, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    };

    const r18Adapter = new R18DevAdapter({ fetchFn: mockFetch });
    const service = new IngestionService(catalog, [r18Adapter]);

    const result = await service.ingest({
      localFile: { path: "D:/Media/SIVR-340.mp4" },
      clues: { catalogId: "SIVR-340" },
    });

    expect(result.status).toBe("query_failed");
    if (result.status === "query_failed") {
      expect(result.retryable).toBe(true);
      expect(result.errorCode).toBe("CHALLENGE_SHELL");
    }
  });

  it("malformed JSON maps to retryable MALFORMED_RESPONSE status", async () => {
    const malformedJson = loadFixture("malformed.json");
    const mockFetch: typeof fetch = async () => {
      return new Response(malformedJson, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const r18Adapter = new R18DevAdapter({ fetchFn: mockFetch });
    const service = new IngestionService(catalog, [r18Adapter]);

    const result = await service.ingest({
      localFile: { path: "D:/Media/SIVR-340.mp4" },
      clues: { catalogId: "SIVR-340" },
    });

    expect(result.status).toBe("query_failed");
    if (result.status === "query_failed") {
      expect(result.retryable).toBe(true);
      expect(result.errorCode).toBe("MALFORMED_RESPONSE");
    }
  });
});
