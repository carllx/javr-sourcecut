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

  it("sanitizes forbidden characters from filenames", () => {
    expect(sanitizeFilename('Foo: Bar / Baz * "Quux" <1> | ?')).toBe("Foo - Bar Baz Quux 1");
  });
});
