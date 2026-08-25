import { describe, it, expect, vi } from "vitest";
import {
  selectHqRendition,
  getTargetTierCandidates,
  selectHighestPublicHqRendition,
} from "../../src/core/hq-selector.js";
import { CapabilityMismatchError } from "../../src/core/mp4/types.js";
import type { MediaRendition } from "../../src/types.js";

describe("HQ Rendition Selector & Target Quality Policy", () => {
  const sampleRenditions: MediaRendition[] = [
    { formatId: "2160p-av1", resolution: "2160p", height: 2160, vcodec: "av1", directUrl: "https://example.com/2160-av1" },
    { formatId: "2160p-h264", resolution: "2160p", height: 2160, vcodec: "h264", directUrl: "https://example.com/2160-h264" },
    { formatId: "1440p-av1", resolution: "1440p", height: 1440, vcodec: "av1", directUrl: "https://example.com/1440-av1" },
    { formatId: "1440p-h264", resolution: "1440p", height: 1440, vcodec: "h264", directUrl: "https://example.com/1440-h264" },
    { formatId: "1080p-av1", resolution: "1080p", height: 1080, vcodec: "av1", directUrl: "https://example.com/1080-av1" },
    { formatId: "720p-av1", resolution: "720p", height: 720, vcodec: "av1", directUrl: "https://example.com/720-av1" },
    { formatId: "720p-h264", resolution: "720p", height: 720, vcodec: "h264", directUrl: "https://example.com/720-h264" },
  ];

  // 1. 2160p AV1 fails, 2160p H264 succeeds -> select 2160p H264
  it("Rule 1: selects same-tier alternative (2160p H264) if preferred 2160p AV1 fails Range capability", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("2160-av1")) {
        return { status: 200, headers: new Headers(), body: { cancel: vi.fn() } };
      }
      if (url.includes("2160-h264")) {
        return {
          status: 206,
          headers: new Headers({ "content-range": "bytes 0-0/3000000000" }),
          body: null,
          arrayBuffer: async () => new Uint8Array([0x01]).buffer,
        };
      }
      throw new Error(`Unexpected probe: ${url}`);
    });

    const result = await selectHighestPublicHqRendition(sampleRenditions, { fetchFn: mockFetch as any });

    expect(result.selected.formatId).toBe("2160p-h264");
    expect(result.targetHeight).toBe(2160);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].formatId).toBe("2160p-av1");
    expect(result.attempts[0].accepted).toBe(false);
    expect(result.attempts[1].formatId).toBe("2160p-h264");
    expect(result.attempts[1].accepted).toBe(true);
  });

  // 2. 2160p AV1 fails, 2160p H264 fails, 1440p AV1 would succeed -> MUST NOT probe/select 1440p by default -> CapabilityMismatchError
  it("Rule 2: refuses to silently downgrade resolution when default max target 2160p is inaccessible", async () => {
    const probedUrls: string[] = [];

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      probedUrls.push(url);
      if (url.includes("2160")) {
        return { status: 200, headers: new Headers(), body: { cancel: vi.fn() } };
      }
      // 1440p would succeed if probed
      return {
        status: 206,
        headers: new Headers({ "content-range": "bytes 0-0/1000000000" }),
        body: null,
        arrayBuffer: async () => new Uint8Array([0x01]).buffer,
      };
    });

    await expect(
      selectHighestPublicHqRendition(sampleRenditions, { fetchFn: mockFetch as any })
    ).rejects.toThrow(CapabilityMismatchError);

    // Verify 1440p or 720p was NEVER probed
    expect(probedUrls).toEqual([
      "https://example.com/2160-av1",
      "https://example.com/2160-h264",
    ]);
  });

  // 3. User explicitly specifies 1440 -> only 1440 candidates are considered, AV1 preferred
  it("Rule 3: user override --height 1440 considers only 1440 candidates, prioritizing AV1", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("1440-av1")) {
        return {
          status: 206,
          headers: new Headers({ "content-range": "bytes 0-0/800000000" }),
          body: null,
          arrayBuffer: async () => new Uint8Array([0x01]).buffer,
        };
      }
      throw new Error(`Unexpected probe: ${url}`);
    });

    const result = await selectHighestPublicHqRendition(sampleRenditions, {
      target: { height: 1440 },
      fetchFn: mockFetch as any,
    });

    expect(result.selected.formatId).toBe("1440p-av1");
    expect(result.targetHeight).toBe(1440);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].formatId).toBe("1440p-av1");
  });

  // 4. User explicitly specifies 720 -> 720 is allowed
  it("Rule 4: user override --height 720 is allowed and selects 720p AV1", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("720-av1")) {
        return {
          status: 206,
          headers: new Headers({ "content-range": "bytes 0-0/300000000" }),
          body: null,
          arrayBuffer: async () => new Uint8Array([0x01]).buffer,
        };
      }
      throw new Error(`Unexpected probe: ${url}`);
    });

    const result = await selectHighestPublicHqRendition(sampleRenditions, {
      target: { height: 720 },
      fetchFn: mockFetch as any,
    });

    expect(result.selected.formatId).toBe("720p-av1");
    expect(result.targetHeight).toBe(720);
    expect(result.attempts[0].formatId).toBe("720p-av1");
  });

  // 5. Default max target discovers 2160/1440/1080/720 -> target height = 2160
  it("Rule 5: default max target determines target height = 2160 from discovered pool", () => {
    const { targetHeight, candidates } = getTargetTierCandidates(sampleRenditions);
    expect(targetHeight).toBe(2160);
    expect(candidates.map((c) => c.formatId)).toEqual(["2160p-av1", "2160p-h264"]);
  });

  it("fails closed on HTTP 200 and cancels response body", async () => {
    const cancelSpy = vi.fn();
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: { cancel: cancelSpy },
    });

    await expect(
      selectHighestPublicHqRendition(sampleRenditions, { fetchFn: mockFetch as any })
    ).rejects.toThrow(CapabilityMismatchError);

    expect(cancelSpy).toHaveBeenCalledTimes(2); // for 2160-av1 and 2160-h264
  });
});
