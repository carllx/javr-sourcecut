import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { R18DevAdapter } from "../../src/adapters/r18dev/adapter.js";
import { IdentityMismatchError } from "../../src/adapters/r18dev/identifier.js";
import { SourceQueryFailure } from "../../src/core/ingestion.js";

const FIXTURES_DIR = join(process.cwd(), "tests", "fixtures", "r18dev");

function loadFixture(filename: string): string {
  return readFileSync(join(FIXTURES_DIR, filename), "utf-8");
}

describe("R18DevAdapter (Issue #38 Seam 3)", () => {
  it("resolves SIVR-340 via combined=sivr00340 and maps to complete Identification Candidate", async () => {
    const fixtureData = loadFixture("sivr00340.json");
    const mockFetch: typeof fetch = async (url) => {
      expect(String(url)).toContain("combined=sivr00340/json");
      return new Response(fixtureData, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const adapter = new R18DevAdapter({ fetchFn: mockFetch });
    const candidates = await adapter.search({ catalogId: "SIVR-340" });

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0];

    // 1. Work Identifiers
    expect(candidate.workIdentifiers.some((i) => i.scheme === "catalog_id" && i.value === "SIVR-340")).toBe(true);
    expect(candidate.workIdentifiers.some((i) => i.scheme === "dmm_cid" && i.value === "sivr00340")).toBe(true);
    expect(candidate.workIdentifiers.some((i) => i.scheme === "r18dev_content_id" && i.value === "sivr00340")).toBe(true);

    // 2. Titles (Japanese title preserved, English in evidences)
    expect(candidate.title).toBe(
      "【VR】VR NO.1 STYLE 川越にこ 解禁 ―大きく輝く黒目、心掴む澄んだ眼差し― ゼッタイ惚れちゃう天性のモテSEXを完全独占！"
    );

    // 3. Release Date
    expect(candidate.releaseDate).toBe("2024-04-03");

    // 4. Maker / Studio
    expect(candidate.studio).toBe("エスワン ナンバーワンスタイル");

    // 5. Performers: preserves name, region: asian, NO alias merge
    expect(candidate.performers).toHaveLength(1);
    const performer = candidate.performers![0];
    expect(performer.name).toBe("川越にこ");
    expect(performer.region).toBe("asian");
    expect(performer.aliases).toBeUndefined(); // Crucial: R18.dev has no alias array, no speculative merge!

    // 6. Source References
    expect(candidate.sourceReferences).toHaveLength(1);
    expect(candidate.sourceReferences![0].provider).toBe("r18dev");
    expect(candidate.sourceReferences![0].providerAssetId).toBe("sivr00340");
    expect(candidate.sourceReferences![0].sourceUrl).toContain("combined=sivr00340");

    // 7. Evidences: captures provenance for title_ja, title_en, release_date, maker/label/series, performer ID + kanji/romaji/kana
    expect(candidate.evidences).toBeDefined();
    const evidences = candidate.evidences!;
    expect(evidences.some((e) => e.evidenceKey === "title_ja")).toBe(true);
    expect(evidences.some((e) => e.evidenceKey === "title_en")).toBe(true);
    expect(evidences.some((e) => e.evidenceKey === "release_date" && e.evidenceValue === "2024-04-03")).toBe(true);
    expect(evidences.some((e) => e.evidenceKey === "maker_ja" && e.evidenceValue === "エスワン ナンバーワンスタイル")).toBe(true);
    expect(evidences.some((e) => e.evidenceKey === "maker_en" && e.evidenceValue === "S1 NO.1 STYLE")).toBe(true);
    expect(evidences.some((e) => e.evidenceKey === "label_ja" && e.evidenceValue === "S1 VR")).toBe(true);
    expect(evidences.some((e) => e.evidenceKey === "series_ja" && e.evidenceValue === "S1 VR")).toBe(true);

    // Performer provenance evidences
    expect(evidences.some((e) => e.evidenceKey === "performer:source_id" && e.evidenceValue === "1084346")).toBe(true);
    expect(evidences.some((e) => e.evidenceKey === "performer:1084346:kanji" && e.evidenceValue === "川越にこ")).toBe(true);
    expect(evidences.some((e) => e.evidenceKey === "performer:1084346:romaji" && e.evidenceValue === "Niko Kawagoe")).toBe(true);
    expect(evidences.some((e) => e.evidenceKey === "performer:1084346:kana" && e.evidenceValue === "かわごえにこ")).toBe(true);
  });

  it("resolves MDVR-28 via combined=mdvr00028 and respects official returned dvd_id MDVR-028", async () => {
    const fixtureData = loadFixture("mdvr00028.json");
    const mockFetch: typeof fetch = async (url) => {
      expect(String(url)).toContain("combined=mdvr00028/json");
      return new Response(fixtureData, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const adapter = new R18DevAdapter({ fetchFn: mockFetch });
    const candidates = await adapter.search({ catalogId: "MDVR-28" });

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0];

    // Both MDVR-028 and MDVR-28 are retained for flexible corroboration
    expect(candidate.workIdentifiers.some((i) => i.scheme === "catalog_id" && i.value === "MDVR-028")).toBe(true);
    expect(candidate.workIdentifiers.some((i) => i.scheme === "catalog_id" && i.value === "MDVR-28")).toBe(true);
    expect(candidate.performers![0].name).toBe("山岸逢花");
    expect(candidate.performers![0].region).toBe("asian");
  });

  it("extracts JAV identifier from complex filename and resolves IPVR-276", async () => {
    const fixtureData = loadFixture("ipvr00276.json");
    const mockFetch: typeof fetch = async (url) => {
      expect(String(url)).toContain("combined=ipvr00276/json");
      return new Response(fixtureData, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const adapter = new R18DevAdapter({ fetchFn: mockFetch });
    const candidates = await adapter.search({
      filename: "Nagahama Mitsuri - IPVR276-p1-proj.llc",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].performers![0].name).toBe("長浜みつり");
    expect(candidates[0].studio).toBe("アイデアポケット");
  });

  it("hard negative: strictly blocks false positive SIVR-340 -> sivr00034 with IdentityMismatchError", async () => {
    // Upstream simulation returns sivr00034 (SIVR-034) when queried for SIVR-340
    const fixtureData = loadFixture("sivr00034.json");
    const mockFetch: typeof fetch = async () => {
      return new Response(fixtureData, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const adapter = new R18DevAdapter({ fetchFn: mockFetch });

    // Must throw IdentityMismatchError, NOT return [] (not clean zero results / no-result)
    await expect(adapter.search({ catalogId: "SIVR-340" })).rejects.toThrowError(
      IdentityMismatchError
    );

    try {
      await adapter.search({ catalogId: "SIVR-340" });
    } catch (err) {
      const ime = err as IdentityMismatchError;
      expect(ime.code).toBe("IDENTITY_MISMATCH");
      expect(ime.retryable).toBe(false);
      expect(ime.expected.numericCore).toBe(340);
      expect(ime.actual.numericCore).toBe(34);
    }
  });

  it("returns [] for clean 404 NOT_FOUND without throwing", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response("Not Found", { status: 404 });
    };

    const adapter = new R18DevAdapter({ fetchFn: mockFetch });
    const candidates = await adapter.search({ catalogId: "NONEXISTENT-999" });
    expect(candidates).toEqual([]);
  });

  it("propagates retryable HTTP_429 on rate limit", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response("Rate Limited", { status: 429 });
    };

    const adapter = new R18DevAdapter({ fetchFn: mockFetch });
    await expect(adapter.search({ catalogId: "SIVR-340" })).rejects.toThrowError(
      SourceQueryFailure
    );
  });

  it("propagates CHALLENGE_SHELL on HTML Turnstile challenge", async () => {
    const challengeHtml = loadFixture("turnstile-challenge.html");
    const mockFetch: typeof fetch = async () => {
      return new Response(challengeHtml, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    };

    const adapter = new R18DevAdapter({ fetchFn: mockFetch });
    try {
      await adapter.search({ catalogId: "SIVR-340" });
    } catch (err) {
      const sqf = err as SourceQueryFailure;
      expect(sqf.code).toBe("CHALLENGE_SHELL");
      expect(sqf.retryable).toBe(true);
    }
  });

  it("propagates MALFORMED_RESPONSE on malformed JSON", async () => {
    const malformedJson = loadFixture("malformed.json");
    const mockFetch: typeof fetch = async () => {
      return new Response(malformedJson, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const adapter = new R18DevAdapter({ fetchFn: mockFetch });
    try {
      await adapter.search({ catalogId: "SIVR-340" });
    } catch (err) {
      const sqf = err as SourceQueryFailure;
      expect(sqf.code).toBe("MALFORMED_RESPONSE");
      expect(sqf.retryable).toBe(true);
    }
  });

  it("returns false for canHandle on non-JAV Western clues", () => {
    const adapter = new R18DevAdapter();
    expect(
      adapter.canHandle({
        provider: "badoinkvr",
        rawTitle: "Kush Queen",
        studio: "BaDoinkVR",
      })
    ).toBe(false);

    expect(
      adapter.canHandle({
        catalogId: "SIVR-340",
      })
    ).toBe(true);

    expect(
      adapter.canHandle({
        filename: "Kawagoe Niko - SIVR340+b-proj.llc",
      })
    ).toBe(true);
  });
});
