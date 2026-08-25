import { describe, it, expect } from "vitest";
import { selectHqRendition } from "../../src/core/hq-selector.js";
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
});
