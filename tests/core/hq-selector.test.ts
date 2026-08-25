import { describe, it, expect, vi } from "vitest";
import {
  selectHqRendition,
  getTargetTierCandidates,
  selectHighestPublicHqRendition,
  resolveJobQualityTargetMetadata,
} from "../../src/core/hq-selector.js";
import { CapabilityMismatchError } from "../../src/core/mp4/types.js";
import { validateCodec, validateHeight } from "../../src/cli.js";
import type { MediaRendition } from "../../src/types.js";

describe("HQ Rendition Selector & Explicit Quality Target Overrides", () => {
  const sampleRenditions: MediaRendition[] = [
    { formatId: "2160p-av1", resolution: "2160p", height: 2160, vcodec: "av1", directUrl: "https://example.com/2160-av1" },
    { formatId: "2160p-h264", resolution: "2160p", height: 2160, vcodec: "h264", directUrl: "https://example.com/2160-h264" },
    { formatId: "1440p-av1", resolution: "1440p", height: 1440, vcodec: "av1", directUrl: "https://example.com/1440-av1" },
    { formatId: "1440p-h264", resolution: "1440p", height: 1440, vcodec: "h264", directUrl: "https://example.com/1440-h264" },
    { formatId: "1080p-av1", resolution: "1080p", height: 1080, vcodec: "av1", directUrl: "https://example.com/1080-av1" },
    { formatId: "720p-av1", resolution: "720p", height: 720, vcodec: "av1", directUrl: "https://example.com/720-av1" },
    { formatId: "720p-h264", resolution: "720p", height: 720, vcodec: "h264", directUrl: "https://example.com/720-h264" },
  ];

  // Test A: 2160p AV1 exists, user explicitly requests codec=h264, no 2160p H264 exists -> CapabilityMismatchError, AV1 is NOT selected
  it("Test A: explicit codec=h264 fails with CapabilityMismatchError if no H264 in target tier (does not select AV1)", async () => {
    const onlyAv1Renditions: MediaRendition[] = [
      { formatId: "2160p-av1", resolution: "2160p", height: 2160, vcodec: "av1", directUrl: "https://example.com/2160-av1" },
      { formatId: "720p-h264", resolution: "720p", height: 720, vcodec: "h264", directUrl: "https://example.com/720-h264" },
    ];

    await expect(
      selectHighestPublicHqRendition(onlyAv1Renditions, {
        target: { height: 2160, codec: "h264" },
      })
    ).rejects.toThrow(CapabilityMismatchError);
  });

  // Test B: global max = 2160p, user explicitly requests formatId=720p-av1 -> only 720p-av1 is considered, targetHeight = 720
  it("Test B: explicit formatId=720p-av1 is authoritative (targetHeight=720, does not probe 2160p)", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("720-av1")) {
        return {
          status: 206,
          headers: new Headers({ "content-range": "bytes 0-0/300000000" }),
          body: null,
          arrayBuffer: async () => new Uint8Array([0x01]).buffer,
        };
      }
      throw new Error(`Unexpected probe of non-target rendition: ${url}`);
    });

    const result = await selectHighestPublicHqRendition(sampleRenditions, {
      target: { formatId: "720p-av1" },
      fetchFn: mockFetch as any,
    });

    expect(result.selected.formatId).toBe("720p-av1");
    expect(result.targetHeight).toBe(720);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].formatId).toBe("720p-av1");
  });

  // Test C: formatId=720p-av1 + height=2160 -> explicit conflict fails clearly
  it("Test C: conflicting formatId=720p-av1 + height=2160 throws clear conflict error", () => {
    expect(() =>
      getTargetTierCandidates(sampleRenditions, {
        formatId: "720p-av1",
        height: 2160,
      })
    ).toThrow(/Conflicting quality target options/);
  });

  // Test D & E: metadata resolution for intervention
  it("Test D & E: resolveJobQualityTargetMetadata correctly captures explicit targets on intervention", () => {
    // Test D: resolution=1440p
    const metaD = resolveJobQualityTargetMetadata(sampleRenditions, { resolution: "1440p" });
    expect(metaD.targetHeight).toBe(1440);
    expect(metaD.requestedResolution).toBe("1440p");
    expect(metaD.explicitOverride).toBe(true);

    // Test E: codec=h264
    const metaE = resolveJobQualityTargetMetadata(sampleRenditions, { codec: "h264" });
    expect(metaE.preferredCodec).toBe("h264");
    expect(metaE.requestedCodec).toBe("h264");
    expect(metaE.explicitOverride).toBe(true);
  });

  // Test F: codec-only override at default max tier: max tier=2160, codec=h264 -> only 2160p H264 considered
  it("Test F: codec-only override at default max tier considers only 2160p H264", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("2160-h264")) {
        return {
          status: 206,
          headers: new Headers({ "content-range": "bytes 0-0/3500000000" }),
          body: null,
          arrayBuffer: async () => new Uint8Array([0x01]).buffer,
        };
      }
      throw new Error(`Unexpected probe: ${url}`);
    });

    const result = await selectHighestPublicHqRendition(sampleRenditions, {
      target: { codec: "h264" },
      fetchFn: mockFetch as any,
    });

    expect(result.selected.formatId).toBe("2160p-h264");
    expect(result.targetHeight).toBe(2160);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].formatId).toBe("2160p-h264");
  });

  // Test G: invalid CLI codec / height -> rejected before workflow/network activity
  it("Test G: CLI validation rejects invalid codec and non-positive height values", () => {
    expect(() => validateCodec("mp4")).toThrow(/Invalid codec "mp4"/);
    expect(() => validateCodec("vp9")).toThrow(/Invalid codec "vp9"/);
    expect(validateCodec("av1")).toBe("av1");
    expect(validateCodec("H264")).toBe("h264");

    expect(() => validateHeight("abc")).toThrow(/Invalid height "abc"/);
    expect(() => validateHeight("0")).toThrow(/Invalid height "0"/);
    expect(() => validateHeight("-1080")).toThrow(/Invalid height "-1080"/);
    expect(validateHeight("2160")).toBe(2160);
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
