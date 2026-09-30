import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MediaCatalog } from "../../src/core/catalog.js";
import type { ConfirmedMediaInput } from "../../src/core/catalog.js";

describe("MediaCatalog Tracer Bullet (Issue #35)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "catalog-test-"));
    dbPath = join(tempDir, "catalog.sqlite");
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("persists confirmed media to real SQLite and restores identical identities upon reopen", () => {
    const catalog = MediaCatalog.open(dbPath);

    const input: ConfirmedMediaInput = {
      work: {
        title: "Test Work Title",
        identifiers: [
          { scheme: "catalog_id", value: "WAVR-110" },
          { scheme: "dmm_cid", value: "wavr00110" },
        ],
        releaseDate: "2024-05-01",
      },
      performers: [
        {
          name: "Alice Example",
          aliases: ["Alice E.", "アリス"],
        },
      ],
      localFile: {
        path: "D:/Media/WAVR-110.mp4",
        sizeBytes: 104857600,
        format: "mp4",
        codec: "av1",
        resolution: "2160p",
      },
      sourceReferences: [
        {
          provider: "eporner",
          sourceUrl: "https://www.eporner.com/video-12345/alice-test/",
          providerAssetId: "12345",
          rawTitle: "Alice 4K VR AV1",
        },
        {
          provider: "official",
          sourceUrl: "https://example.com/works/wavr-110",
        },
      ],
      evidences: [
        {
          source: "observed-filename",
          evidenceKey: "filename",
          evidenceValue: "WAVR-110.mp4",
        },
        {
          source: "observed-title",
          evidenceKey: "rawTitle",
          evidenceValue: "Alice 4K VR AV1",
        },
      ],
    };

    const recorded = catalog.recordConfirmedMedia(input);

    expect(recorded.id).toBeDefined();
    expect(recorded.title).toBe("Test Work Title");
    expect(recorded.isLibraryReady).toBe(true);
    expect(recorded.performers).toHaveLength(1);
    expect(recorded.performers[0].id).toBeDefined();
    expect(recorded.performers[0].name).toBe("Alice Example");
    expect(recorded.performers[0].aliases).toEqual(["Alice E.", "アリス"]);
    expect(recorded.localFiles).toHaveLength(1);
    expect(recorded.localFiles[0].id).toBeDefined();
    expect(recorded.localFiles[0].path).toBe("D:/Media/WAVR-110.mp4");
    expect(recorded.sourceReferences).toHaveLength(2);
    expect(recorded.evidences).toHaveLength(2);

    const initialWorkId = recorded.id;
    const initialPerformerId = recorded.performers[0].id;
    const initialFileId = recorded.localFiles[0].id;

    // Close the database
    catalog.close();

    // Reopen from disk in a fresh instance
    const reopenedCatalog = MediaCatalog.open(dbPath);

    try {
      // 1. Retrieve work by stable Work ID
      const restoredWork = reopenedCatalog.getWork(initialWorkId);
      expect(restoredWork).not.toBeNull();
      expect(restoredWork?.id).toBe(initialWorkId);
      expect(restoredWork?.title).toBe("Test Work Title");
      expect(restoredWork?.releaseDate).toBe("2024-05-01");
      expect(restoredWork?.isLibraryReady).toBe(true);

      // Verify performers
      expect(restoredWork?.performers).toHaveLength(1);
      expect(restoredWork?.performers[0].id).toBe(initialPerformerId);
      expect(restoredWork?.performers[0].name).toBe("Alice Example");
      expect(restoredWork?.performers[0].aliases).toEqual(["Alice E.", "アリス"]);

      // Verify local file stability
      expect(restoredWork?.localFiles).toHaveLength(1);
      expect(restoredWork?.localFiles[0].id).toBe(initialFileId);
      expect(restoredWork?.localFiles[0].path).toBe("D:/Media/WAVR-110.mp4");
      expect(restoredWork?.localFiles[0].codec).toBe("av1");
      expect(restoredWork?.localFiles[0].resolution).toBe("2160p");

      // Verify local file query by stable ID
      const fileById = reopenedCatalog.getLocalFile(initialFileId);
      expect(fileById).not.toBeNull();
      expect(fileById?.id).toBe(initialFileId);
      expect(fileById?.workId).toBe(initialWorkId);

      // Verify local file query by path
      const fileByPath = reopenedCatalog.findLocalFileByPath("D:/Media/WAVR-110.mp4");
      expect(fileByPath?.id).toBe(initialFileId);

      // Verify performer query by stable ID
      const performerById = reopenedCatalog.getPerformer(initialPerformerId);
      expect(performerById).not.toBeNull();
      expect(performerById?.name).toBe("Alice Example");

      // Verify source references (including missing providerAssetId)
      expect(restoredWork?.sourceReferences).toHaveLength(2);
      const urlOnlyRef = restoredWork?.sourceReferences.find((r) => r.provider === "official");
      expect(urlOnlyRef).toBeDefined();
      expect(urlOnlyRef?.providerAssetId).toBeUndefined();
      expect(urlOnlyRef?.sourceUrl).toBe("https://example.com/works/wavr-110");

      // Verify evidences
      expect(restoredWork?.evidences).toHaveLength(2);
      expect(restoredWork?.evidences.some((e) => e.evidenceValue === "WAVR-110.mp4")).toBe(true);

      // 2. Query work by multiple parallel Work Identifiers
      const foundByCatalogId = reopenedCatalog.findWorkByIdentifier("WAVR-110");
      expect(foundByCatalogId?.id).toBe(initialWorkId);

      const foundBySchemeAndValue = reopenedCatalog.findWorkByIdentifier("dmm_cid", "wavr00110");
      expect(foundBySchemeAndValue?.id).toBe(initialWorkId);
    } finally {
      reopenedCatalog.close();
    }
  });

  it("marks item as Library Ready even when optional enrichments (DOB, Region, Director, Shoot Date) are missing", () => {
    const catalog = MediaCatalog.open(dbPath);

    const input: ConfirmedMediaInput = {
      work: {
        title: "Minimal Enriched Work",
        identifiers: [{ scheme: "catalog_id", value: "MIN-001" }],
        // director, releaseDate, shootDate missing
      },
      performers: [
        {
          name: "Performer Without DOB",
          // dateOfBirth, region missing
        },
      ],
      localFile: {
        path: "D:/Media/MIN-001.mp4",
      },
    };

    const recorded = catalog.recordConfirmedMedia(input);
    expect(recorded.isLibraryReady).toBe(true);
    expect(recorded.director).toBeUndefined();
    expect(recorded.shootDate).toBeUndefined();
    expect(recorded.performers[0].dateOfBirth).toBeUndefined();
    expect(recorded.performers[0].region).toBeUndefined();

    catalog.close();

    const reopened = MediaCatalog.open(dbPath);
    try {
      const restored = reopened.getWork(recorded.id);
      expect(restored?.isLibraryReady).toBe(true);
      expect(restored?.director).toBeUndefined();
      expect(restored?.shootDate).toBeUndefined();
      expect(restored?.performers[0].dateOfBirth).toBeUndefined();
      expect(restored?.performers[0].region).toBeUndefined();
    } finally {
      reopened.close();
    }
  });

  it("does not replace Work identity with Work Identifier or evidence", () => {
    const catalog = MediaCatalog.open(dbPath);

    const input: ConfirmedMediaInput = {
      work: {
        title: "Disassociated Identity Work",
        identifiers: [{ scheme: "catalog_id", value: "ABC-123" }],
      },
      performers: [{ name: "Bob" }],
      localFile: { path: "D:/Media/ABC-123.mp4" },
      evidences: [
        {
          source: "observed-title",
          evidenceValue: "ABC-123 Bob 4K",
        },
      ],
    };

    const recorded = catalog.recordConfirmedMedia(input);
    // Work ID must be internal stable ID generated by catalog, not "ABC-123"
    expect(recorded.id).not.toBe("ABC-123");
    expect(recorded.identifiers[0].value).toBe("ABC-123");
    expect(recorded.evidences[0].evidenceValue).toBe("ABC-123 Bob 4K");

    catalog.close();
  });

  it("reuses existing Performer identity when another Work records the same performer", () => {
    const catalog = MediaCatalog.open(dbPath);

    const work1 = catalog.recordConfirmedMedia({
      work: {
        title: "Work 1",
        identifiers: [{ scheme: "catalog_id", value: "WRK-001" }],
      },
      performers: [{ name: "Shared Performer", aliases: ["Alias 1"] }],
      localFile: { path: "D:/Media/WRK-001.mp4" },
    });

    const work2 = catalog.recordConfirmedMedia({
      work: {
        title: "Work 2",
        identifiers: [{ scheme: "catalog_id", value: "WRK-002" }],
      },
      performers: [{ name: "Shared Performer", aliases: ["Alias 2"], dateOfBirth: "1995-01-01" }],
      localFile: { path: "D:/Media/WRK-002.mp4" },
    });

    expect(work1.performers[0].id).toBe(work2.performers[0].id);
    expect(work1.id).not.toBe(work2.id);

    // Aliases should be merged without losing "Alias 1"
    const sharedPerformer = catalog.getPerformer(work1.performers[0].id);
    expect(sharedPerformer?.aliases).toContain("Alias 1");
    expect(sharedPerformer?.aliases).toContain("Alias 2");
    expect(sharedPerformer?.dateOfBirth).toBe("1995-01-01");

    catalog.close();

    const reopened = MediaCatalog.open(dbPath);
    try {
      const persistedPerformer = reopened.getPerformer(work1.performers[0].id);
      expect(persistedPerformer?.aliases).toContain("Alias 1");
      expect(persistedPerformer?.aliases).toContain("Alias 2");
      expect(persistedPerformer?.dateOfBirth).toBe("1995-01-01");
    } finally {
      reopened.close();
    }
  });
});
