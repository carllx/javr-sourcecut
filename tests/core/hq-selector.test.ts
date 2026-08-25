import { describe, it, expect, vi } from "vitest";
import {
  selectHqRendition,
  groupAndRankHqRenditions,
  selectHighestPublicHqRendition,
} from "../../src/core/hq-selector.js";
import { CapabilityMismatchError } from "../../src/core/mp4/types.js";
import type { MediaRendition } from "../../src/types.js";

describe("HQ Rendition Selector", () => {
  it("prioritizes AV1 over H264 within the same highest resolution (2160p)", () => {
    const renditions: MediaRendition[] = [
      {
        formatId: "2160p-h264",
        resolution: "2160p",
        height: 2160,
        vcodec: "h264",
        directUrl: "https://example.com/2160p.mp4",
      },
      {
        formatId: "2160p-av1",
        resolution: "2160p",
        height: 2160,
        vcodec: "av1",
        directUrl: "https://example.com/2160p-av1.mp4",
      },
      {
        formatId: "1080p-av1",
        resolution: "1080p",
        height: 1080,
        vcodec: "av1",
        directUrl: "https://example.com/1080p-av1.mp4",
      },
    ];

    const selected = selectHqRendition(renditions);
    expect(selected.formatId).toBe("2160p-av1");
    expect(selected.resolution).toBe("2160p");
    expect(selected.vcodec).toBe("av1");
  });

  it("chooses higher resolution H264 over lower resolution AV1 (never downgrades resolution for AV1)", () => {
    const renditions: MediaRendition[] = [
      {
        formatId: "1440p-av1",
        resolution: "1440p",
        height: 1440,
        vcodec: "av1",
        directUrl: "https://example.com/1440p-av1.mp4",
      },
      {
        formatId: "2160p-h264",
        resolution: "2160p",
        height: 2160,
        vcodec: "h264",
        directUrl: "https://example.com/2160p.mp4",
      },
      {
        formatId: "1080p-h264",
        resolution: "1080p",
        height: 1080,
        vcodec: "h264",
        directUrl: "https://example.com/1080p.mp4",
      },
    ];

    const selected = selectHqRendition(renditions);
    expect(selected.formatId).toBe("2160p-h264");
    expect(selected.height).toBe(2160);
    expect(selected.vcodec).toBe("h264");
  });

  it("throws when renditions array is empty or lacks valid directUrls", () => {
    expect(() => selectHqRendition([])).toThrow("No renditions available");
    expect(() =>
      selectHqRendition([
        {
          formatId: "2160p-av1",
          resolution: "2160p",
          height: 2160,
          vcodec: "av1",
          directUrl: "",
        },
      ])
    ).toThrow("No renditions with valid directUrl");
  });

  // Test A: 2160p AV1 returns HTTP 200 with response stream -> candidate rejected, body cancelled, selector continues, lower valid candidate wins
  it("Test A: rejects HTTP 200 responses, cancels the response body, and continues to a valid candidate", async () => {
    const cancelSpy = vi.fn();
    const mockBody = {
      cancel: cancelSpy,
    };

    const renditions: MediaRendition[] = [
      {
        formatId: "2160p-av1",
        resolution: "2160p",
        height: 2160,
        vcodec: "av1",
        directUrl: "https://example.com/2160p-av1.mp4",
      },
      {
        formatId: "1080p-av1",
        resolution: "1080p",
        height: 1080,
        vcodec: "av1",
        directUrl: "https://example.com/1080p-av1.mp4",
      },
    ];

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("2160p-av1")) {
        return {
          status: 200,
          headers: new Headers(),
          body: mockBody,
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
        };
      }
      if (url.includes("1080p-av1")) {
        return {
          status: 206,
          headers: new Headers({
            "content-range": "bytes 0-0/5000000",
            "content-length": "1",
          }),
          body: null,
          arrayBuffer: async () => new Uint8Array([0xaa]).buffer,
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await selectHighestPublicHqRendition(renditions, { fetchFn: mockFetch as any });

    expect(cancelSpy).toHaveBeenCalledOnce();
    expect(result.selected.formatId).toBe("1080p-av1");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].formatId).toBe("2160p-av1");
    expect(result.attempts[0].accepted).toBe(false);
    expect(result.attempts[0].httpStatus).toBe(200);
    expect(result.attempts[1].formatId).toBe("1080p-av1");
    expect(result.attempts[1].accepted).toBe(true);
    expect(result.attempts[1].bodyBytesConsumed).toBe(1);
    expect(result.capabilitySelectionBytesTransferred).toBe(1);
  });

  // Test B: 2160p AV1 returns invalid/missing Content-Range -> reject + cancel, no acceptance
  it("Test B: rejects HTTP 206 with malformed/missing Content-Range header, cancels stream", async () => {
    const cancelSpy = vi.fn();
    const mockBody = { cancel: cancelSpy };

    const renditions: MediaRendition[] = [
      {
        formatId: "2160p-av1",
        resolution: "2160p",
        height: 2160,
        vcodec: "av1",
        directUrl: "https://example.com/2160p-av1.mp4",
      },
    ];

    const mockFetch = vi.fn().mockResolvedValue({
      status: 206,
      headers: new Headers({ "content-range": "invalid-header" }),
      body: mockBody,
    });

    await expect(
      selectHighestPublicHqRendition(renditions, { fetchFn: mockFetch as any })
    ).rejects.toThrow(CapabilityMismatchError);

    expect(cancelSpy).toHaveBeenCalledOnce();
  });

  // Test C: 2160p/1440p/1080p unavailable; 720p AV1 returns strict 206; prove ordering resolution first, codec second
  it("Test C: verifies rank order: skips unavailable tiers, selects 720p AV1 over 720p H264", async () => {
    const renditions: MediaRendition[] = [
      { formatId: "2160p-av1", resolution: "2160p", height: 2160, vcodec: "av1", directUrl: "https://example.com/2160-av1" },
      { formatId: "2160p-h264", resolution: "2160p", height: 2160, vcodec: "h264", directUrl: "https://example.com/2160-h264" },
      { formatId: "1440p-av1", resolution: "1440p", height: 1440, vcodec: "av1", directUrl: "https://example.com/1440-av1" },
      { formatId: "720p-h264", resolution: "720p", height: 720, vcodec: "h264", directUrl: "https://example.com/720-h264" },
      { formatId: "720p-av1", resolution: "720p", height: 720, vcodec: "av1", directUrl: "https://example.com/720-av1" },
      { formatId: "480p-av1", resolution: "480p", height: 480, vcodec: "av1", directUrl: "https://example.com/480-av1" },
    ];

    const probeOrder: string[] = [];

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      probeOrder.push(url);
      if (url.includes("2160") || url.includes("1440")) {
        return {
          status: 200,
          headers: new Headers(),
          body: { cancel: vi.fn() },
        };
      }
      if (url.includes("720-av1")) {
        return {
          status: 206,
          headers: new Headers({ "content-range": "bytes 0-0/300000000" }),
          body: null,
          arrayBuffer: async () => new Uint8Array([0x01]).buffer,
        };
      }
      if (url.includes("720-h264")) {
        return {
          status: 206,
          headers: new Headers({ "content-range": "bytes 0-0/500000000" }),
          body: null,
          arrayBuffer: async () => new Uint8Array([0x01]).buffer,
        };
      }
      return { status: 404, headers: new Headers(), body: null };
    });

    const result = await selectHighestPublicHqRendition(renditions, { fetchFn: mockFetch as any });

    expect(result.selected.formatId).toBe("720p-av1");
    // Verify probe order: 2160-av1 -> 2160-h264 -> 1440-av1 -> 720-av1 (720-h264 and 480 not even probed once 720-av1 succeeds)
    expect(probeOrder).toEqual([
      "https://example.com/2160-av1",
      "https://example.com/2160-h264",
      "https://example.com/1440-av1",
      "https://example.com/720-av1",
    ]);
  });

  // Test D: all candidates unavailable -> throws CapabilityMismatchError
  it("Test D: throws CapabilityMismatchError when all candidates fail Range capability", async () => {
    const renditions: MediaRendition[] = [
      { formatId: "2160p-av1", resolution: "2160p", height: 2160, vcodec: "av1", directUrl: "https://example.com/2160-av1" },
      { formatId: "1080p-av1", resolution: "1080p", height: 1080, vcodec: "av1", directUrl: "https://example.com/1080-av1" },
    ];

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: { cancel: vi.fn() },
    });

    await expect(
      selectHighestPublicHqRendition(renditions, { fetchFn: mockFetch as any })
    ).rejects.toThrow(CapabilityMismatchError);
  });
});
