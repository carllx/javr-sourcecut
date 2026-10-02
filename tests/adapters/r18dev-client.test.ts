import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { R18DevClient } from "../../src/adapters/r18dev/client.js";
import { SourceQueryFailure } from "../../src/core/ingestion.js";

const FIXTURES_DIR = join(process.cwd(), "tests", "fixtures", "r18dev");

function loadFixture(filename: string): string {
  return readFileSync(join(FIXTURES_DIR, filename), "utf-8");
}

describe("R18DevClient (Issue #38 Seam 2)", () => {
  it("fetches and parses valid JSON for probe fixture sivr00340", async () => {
    const fixtureData = loadFixture("sivr00340.json");
    const mockFetch: typeof fetch = async (url) => {
      expect(String(url)).toBe(
        "https://r18.dev/videos/vod/movies/detail/-/combined=sivr00340/json"
      );
      return new Response(fixtureData, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const client = new R18DevClient({ fetchFn: mockFetch });
    const detail = await client.fetchDetail("sivr00340");

    expect(detail).not.toBeNull();
    expect(detail?.content_id).toBe("sivr00340");
    expect(detail?.actresses).toHaveLength(1);
    expect(detail?.actresses?.[0].name_kanji).toBe("川越にこ");
    expect(detail?.maker_name_en).toBe("S1 NO.1 STYLE");
  });

  it("returns null for HTTP 404 NOT_FOUND (clean zero-result candidate)", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response("Not Found", { status: 404 });
    };

    const client = new R18DevClient({ fetchFn: mockFetch });
    const detail = await client.fetchDetail("nonexistent99999");
    expect(detail).toBeNull();
  });

  it("throws retryable HTTP_429 for HTTP 429 Too Many Requests", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response("Too Many Requests", { status: 429 });
    };

    const client = new R18DevClient({ fetchFn: mockFetch });
    await expect(client.fetchDetail("sivr00340")).rejects.toThrowError(
      SourceQueryFailure
    );

    try {
      await client.fetchDetail("sivr00340");
    } catch (err) {
      const sqf = err as SourceQueryFailure;
      expect(sqf.code).toBe("HTTP_429");
      expect(sqf.retryable).toBe(true);
    }
  });

  it("throws retryable HTTP_503 for HTTP 503 Service Unavailable", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response("Service Unavailable", { status: 503 });
    };

    const client = new R18DevClient({ fetchFn: mockFetch });
    try {
      await client.fetchDetail("sivr00340");
    } catch (err) {
      const sqf = err as SourceQueryFailure;
      expect(sqf.code).toBe("HTTP_503");
      expect(sqf.retryable).toBe(true);
    }
  });

  it("throws HTTP_403 for HTTP 403 Forbidden", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response("Forbidden", { status: 403 });
    };

    const client = new R18DevClient({ fetchFn: mockFetch });
    try {
      await client.fetchDetail("sivr00340");
    } catch (err) {
      const sqf = err as SourceQueryFailure;
      expect(sqf.code).toBe("HTTP_403");
      expect(sqf.retryable).toBe(true);
    }
  });

  it("detects HTML shell / Cloudflare Turnstile challenge and throws CHALLENGE_SHELL", async () => {
    const challengeHtml = loadFixture("turnstile-challenge.html");
    const mockFetch: typeof fetch = async () => {
      return new Response(challengeHtml, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    };

    const client = new R18DevClient({ fetchFn: mockFetch });
    try {
      await client.fetchDetail("sivr00340");
    } catch (err) {
      const sqf = err as SourceQueryFailure;
      expect(sqf.code).toBe("CHALLENGE_SHELL");
      expect(sqf.retryable).toBe(true);
    }
  });

  it("throws MALFORMED_RESPONSE for syntax-invalid JSON", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response("{ broken json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const client = new R18DevClient({ fetchFn: mockFetch });
    try {
      await client.fetchDetail("sivr00340");
    } catch (err) {
      const sqf = err as SourceQueryFailure;
      expect(sqf.code).toBe("MALFORMED_RESPONSE");
      expect(sqf.retryable).toBe(true);
    }
  });

  it("throws MALFORMED_RESPONSE for response missing content_id", async () => {
    const malformedData = loadFixture("malformed.json");
    const mockFetch: typeof fetch = async () => {
      return new Response(malformedData, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const client = new R18DevClient({ fetchFn: mockFetch });
    try {
      await client.fetchDetail("sivr00340");
    } catch (err) {
      const sqf = err as SourceQueryFailure;
      expect(sqf.code).toBe("MALFORMED_RESPONSE");
      expect(sqf.retryable).toBe(true);
    }
  });

  it("throws NETWORK_ERROR on transport failure", async () => {
    const mockFetch: typeof fetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND r18.dev");
    };

    const client = new R18DevClient({ fetchFn: mockFetch });
    try {
      await client.fetchDetail("sivr00340");
    } catch (err) {
      const sqf = err as SourceQueryFailure;
      expect(sqf.code).toBe("NETWORK_ERROR");
      expect(sqf.retryable).toBe(true);
    }
  });
});
