import { describe, it, expect } from "vitest";
import { buildMediaIdentity, sanitizeFilename } from "../../src/core/identity.js";
import type { SourceDescriptor } from "../../src/types.js";

describe("Progressive Media Identity & Deterministic Naming", () => {
  it("extracts canonical catalog ID and performer group when reliable metadata is found", () => {
    const descriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "abc12345",
      sourceUrl: "https://www.eporner.com/video-abc12345/wavr-110-yua-mikami/",
      rawTitle: "WAVR-110 Yua Mikami",
      declaredPerformers: ["Yua Mikami"],
      renditions: [],
    };

    const identity = buildMediaIdentity(descriptor);
    expect(identity.canonicalCatalogId).toBe("WAVR110");
    expect(identity.confidence).toBe("high");
    expect(identity.searchAliases).toContain("WAVR110");
    expect(identity.searchAliases).toContain("WAVR-110");
    expect(identity.performers.map((p) => p.preferredName)).toEqual(["Yua Mikami"]);
    expect(identity.baseName).toBe("Yua Mikami - WAVR110");
  });

  it("handles multiple performers joined with underscore", () => {
    const descriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "xyz987",
      sourceUrl: "https://www.eporner.com/video-xyz987/ssni-888-yua-mikami-and-tsukasa-aoi/",
      rawTitle: "SSNI-888 Yua Mikami, Tsukasa Aoi",
      declaredPerformers: ["Yua Mikami", "Tsukasa Aoi"],
      renditions: [],
    };

    const identity = buildMediaIdentity(descriptor);
    expect(identity.canonicalCatalogId).toBe("SSNI888");
    expect(identity.baseName).toBe("Yua Mikami_Tsukasa Aoi - SSNI888");
  });

  it("falls back to deterministic safe name when catalog ID is absent or unreliable", () => {
    const descriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "i5MIJLt4gu0",
      sourceUrl: "https://www.eporner.com/video-i5MIJLt4gu0/test-082126-001-carib-yu-yekana-mei/",
      rawTitle: "Test 082126 001 Carib 宇野かな美",
      declaredPerformers: ["Asian", "Japanese"],
      renditions: [],
    };

    const identity = buildMediaIdentity(descriptor);
    expect(identity.confidence).toBe("fallback");
    expect(identity.canonicalCatalogId).toBeUndefined();
    expect(identity.baseName).toBe("eporner-i5MIJLt4gu0 - Test 082126 001 Carib 宇野かな美");
  });

  it("formats structured performer aliases in parentheses and joins multiple performers with underscore", () => {
    const descriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "alias123",
      sourceUrl: "https://www.eporner.com/video-alias123/ipx-534-kaede-karen/",
      rawTitle: "IPX-534 Kaede Karen",
      declaredPerformers: [
        { preferredName: "Kaede Karen", aliases: ["Karen Kaede"] },
        { preferredName: "Yua Mikami", aliases: ["Mikami Yua", "Momona Kito"] },
      ],
      renditions: [],
    };

    const identity = buildMediaIdentity(descriptor);
    expect(identity.canonicalCatalogId).toBe("IPX534");
    expect(identity.baseName).toBe("Kaede Karen (Karen Kaede)_Yua Mikami (Mikami Yua, Momona Kito) - IPX534");
    expect(identity.searchAliases).toContain("IPX534");
    expect(identity.searchAliases).toContain("IPX-534");
    expect(identity.searchAliases).toContain("Kaede Karen");
    expect(identity.searchAliases).toContain("Karen Kaede");
    expect(identity.searchAliases).toContain("Yua Mikami");
    expect(identity.searchAliases).toContain("Mikami Yua");
  });

  it("strictly preserves leading zeros in catalog IDs without stripping or padding", () => {
    const testCases = [
      { raw: "ABC-001 Title", expectedCanonical: "ABC001", expectedHyphenated: "ABC-001" },
      { raw: "ABC-01 Title", expectedCanonical: "ABC01", expectedHyphenated: "ABC-01" },
      { raw: "ABC-1 Title", expectedCanonical: "ABC1", expectedHyphenated: "ABC-1" },
      { raw: "JFB-446 Title", expectedCanonical: "JFB446", expectedHyphenated: "JFB-446" },
      { raw: "WAVR-110 Title", expectedCanonical: "WAVR110", expectedHyphenated: "WAVR-110" },
    ];

    for (const tc of testCases) {
      const descriptor: SourceDescriptor = {
        provider: "eporner",
        providerAssetId: "test_asset",
        sourceUrl: "http://example.com",
        rawTitle: tc.raw,
        declaredPerformers: ["Performer One"],
        renditions: [],
      };
      const identity = buildMediaIdentity(descriptor);
      expect(identity.canonicalCatalogId).toBe(tc.expectedCanonical);
      expect(identity.searchAliases).toContain(tc.expectedCanonical);
      expect(identity.searchAliases).toContain(tc.expectedHyphenated);
      expect(identity.baseName).toBe(`Performer One - ${tc.expectedCanonical}`);
    }
  });

  it("progressively tracks catalog candidates, observed filenames, and search aliases", () => {
    const descriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "vid999",
      sourceUrl: "https://www.eporner.com/video-vid999/abw-099-sample/",
      rawTitle: "ABW-099 Sample Title with candidate SSNI-100",
      declaredPerformers: ["Actress A"],
      observedFilenames: ["eporner_abw099_hd.mp4"],
      renditions: [],
    };

    const identity = buildMediaIdentity(descriptor);
    expect(identity.canonicalCatalogId).toBe("ABW099");
    expect(identity.observedFilenames).toEqual(["eporner_abw099_hd.mp4"]);
    expect(identity.catalogCandidates).toBeDefined();
    expect(identity.catalogCandidates!.length).toBeGreaterThanOrEqual(1);
    expect(identity.catalogCandidates![0].canonical).toBe("ABW099");
    expect(identity.catalogCandidates![0].provenance).toBe("observed-title");
    expect(identity.catalogCandidates![0].confidence).toBe("medium");
    expect(identity.workSearchAliases).toContain("ABW099");
    expect(identity.workSearchAliases).toContain("ABW-099");
    expect(identity.workSearchAliases).toContain("vid999");
    expect(identity.performerSearchAliases).toContain("Actress A");
    expect(identity.searchAliases).toContain("ABW099");
    expect(identity.searchAliases).toContain("Actress A");
  });

  it("distinguishes candidate provenance across title, URL, and observed filenames without falsely elevated confidence", () => {
    const descriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "vid888",
      sourceUrl: "https://www.eporner.com/video-vid888/midv-123-sample/",
      rawTitle: "Title mentioning JUFE-456",
      declaredPerformers: [],
      observedFilenames: ["extra_ipx789_1080p.mp4"],
      renditions: [],
    };

    const identity = buildMediaIdentity(descriptor);
    expect(identity.catalogCandidates).toBeDefined();

    const titleCand = identity.catalogCandidates!.find((c) => c.canonical === "JUFE456");
    expect(titleCand?.provenance).toBe("observed-title");
    expect(titleCand?.confidence).toBe("medium");

    const urlCand = identity.catalogCandidates!.find((c) => c.canonical === "MIDV123");
    expect(urlCand?.provenance).toBe("source-url");
    expect(urlCand?.confidence).toBe("medium");

    const fileCand = identity.catalogCandidates!.find((c) => c.canonical === "IPX789");
    expect(fileCand?.provenance).toBe("observed-filename");
    expect(fileCand?.confidence).toBe("low");
  });

  it("sanitizes forbidden characters from filenames", () => {
    expect(sanitizeFilename('Foo: Bar / Baz * "Quux" <1> | ?')).toBe("Foo - Bar Baz Quux 1");
  });
});
