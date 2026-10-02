import { describe, it, expect } from "vitest";
import {
  parseJavIdentifier,
  generateContentIdCandidates,
  verifyPostFetchIdentity,
  IdentityMismatchError,
} from "../../src/adapters/r18dev/identifier.js";

describe("R18.dev JAV Identifier Normalization & Verification (Issue #38 Seam 1)", () => {
  describe("parseJavIdentifier", () => {
    it("extracts series and numeric core from standard hyphenated identifiers", () => {
      const parsed = parseJavIdentifier("SIVR-340");
      expect(parsed).not.toBeNull();
      expect(parsed?.series).toBe("sivr");
      expect(parsed?.numericCore).toBe(340);
      expect(parsed?.canonical).toBe("SIVR-340");
    });

    it("extracts series and numeric core from unhyphenated and lowercase identifiers", () => {
      const parsed1 = parseJavIdentifier("sivr00340");
      expect(parsed1).not.toBeNull();
      expect(parsed1?.series).toBe("sivr");
      expect(parsed1?.numericCore).toBe(340);

      const parsed2 = parseJavIdentifier("IPVR276");
      expect(parsed2).not.toBeNull();
      expect(parsed2?.series).toBe("ipvr");
      expect(parsed2?.numericCore).toBe(276);
    });

    it("parses real complex filename clues with segment/part tags and performers", () => {
      const samples = [
        {
          input: "Kawagoe Niko - SIVR340+b-proj.llc",
          series: "sivr",
          numericCore: 340,
          canonical: "SIVR-340",
        },
        {
          input: "Nagahama Mitsuri - IPVR276-p1-proj.llc",
          series: "ipvr",
          numericCore: 276,
          canonical: "IPVR-276",
        },
        {
          input: "Kodama Nanami (Ogura Nanami) - SIVR354+c-proj.llc",
          series: "sivr",
          numericCore: 354,
          canonical: "SIVR-354",
        },
        {
          input: "URVRSP-339",
          series: "urvrsp",
          numericCore: 339,
          canonical: "URVRSP-339",
        },
        {
          input: "MDVR-28",
          series: "mdvr",
          numericCore: 28,
          canonical: "MDVR-028",
        },
      ];

      for (const sample of samples) {
        const parsed = parseJavIdentifier(sample.input);
        expect(parsed).not.toBeNull();
        expect(parsed?.series).toBe(sample.series);
        expect(parsed?.numericCore).toBe(sample.numericCore);
        expect(parsed?.canonical).toBe(sample.canonical);
      }
    });

    it("returns null for non-JAV western filenames or generic ignored prefixes", () => {
      expect(parseJavIdentifier("Jade Kush - Kush Queen - BaDoinkVR.mp4")).toBeNull();
      expect(parseJavIdentifier("VIDEO-12345.mp4")).toBeNull();
      expect(parseJavIdentifier("TEST-001.mp4")).toBeNull();
      expect(parseJavIdentifier("")).toBeNull();
    });
  });

  describe("generateContentIdCandidates", () => {
    it("generates deterministic 5-digit padded candidates covering all probe samples", () => {
      expect(generateContentIdCandidates(parseJavIdentifier("SIVR-340")!)).toContain("sivr00340");
      expect(generateContentIdCandidates(parseJavIdentifier("IPVR-276")!)).toContain("ipvr00276");
      expect(generateContentIdCandidates(parseJavIdentifier("MDVR-354")!)).toContain("mdvr00354");
      expect(generateContentIdCandidates(parseJavIdentifier("URVRSP-339")!)).toContain("urvrsp00339");
      expect(generateContentIdCandidates(parseJavIdentifier("MDVR-28")!)).toContain("mdvr00028");
    });

    it("puts standard 5-digit zero-padded candidate first in deterministic priority order", () => {
      const candidates = generateContentIdCandidates(parseJavIdentifier("SIVR-340")!);
      expect(candidates[0]).toBe("sivr00340");
    });

    it("hard-negative: never generates silent false positive candidates (e.g. sivr00034 for SIVR-340)", () => {
      const candidates = generateContentIdCandidates(parseJavIdentifier("SIVR-340")!);
      expect(candidates).not.toContain("sivr00034");
      expect(candidates).not.toContain("sivr034");

      const mdvrCandidates = generateContentIdCandidates(parseJavIdentifier("MDVR-28")!);
      expect(mdvrCandidates).not.toContain("mdvr00288");
      expect(mdvrCandidates).not.toContain("mdvr288");
    });
  });

  describe("verifyPostFetchIdentity", () => {
    it("accepts valid response where series and numeric core match", () => {
      const parsed = parseJavIdentifier("SIVR-340")!;
      expect(() => {
        verifyPostFetchIdentity(parsed, {
          content_id: "sivr00340",
          dvd_id: null,
          title_ja: "VR NO.1 STYLE 川越にこ 解禁",
        });
      }).not.toThrow();

      const parsed2 = parseJavIdentifier("MDVR-28")!;
      expect(() => {
        verifyPostFetchIdentity(parsed2, {
          content_id: "mdvr00028",
          dvd_id: "MDVR-028",
          title_ja: "山岸逢花 MOODYZ VR",
        });
      }).not.toThrow();
    });

    it("strictly rejects false positive SIVR-340 -> sivr00034 / SIVR-034 with IdentityMismatchError", () => {
      const parsed = parseJavIdentifier("SIVR-340")!;
      expect(() => {
        verifyPostFetchIdentity(parsed, {
          content_id: "sivr00034",
          dvd_id: "SIVR-034",
          title_ja: "VR NO.1 STYLE 宇都宮しおん 解禁",
        });
      }).toThrowError(IdentityMismatchError);

      try {
        verifyPostFetchIdentity(parsed, {
          content_id: "sivr00034",
          dvd_id: "SIVR-034",
        });
      } catch (err) {
        expect(err).toBeInstanceOf(IdentityMismatchError);
        const ime = err as IdentityMismatchError;
        expect(ime.code).toBe("IDENTITY_MISMATCH");
        expect(ime.retryable).toBe(false);
        expect(ime.expected.numericCore).toBe(340);
        expect(ime.actual.numericCore).toBe(34);
      }
    });

    it("strictly rejects series mismatch", () => {
      const parsed = parseJavIdentifier("MDVR-354")!;
      expect(() => {
        verifyPostFetchIdentity(parsed, {
          content_id: "sivr00354",
        });
      }).toThrowError(IdentityMismatchError);
    });

    it("rejects response when content_id is missing or malformed", () => {
      const parsed = parseJavIdentifier("SIVR-340")!;
      expect(() => {
        verifyPostFetchIdentity(parsed, {
          title_ja: "Some Video Without Content ID",
        });
      }).toThrowError();
    });
  });
});
