import { describe, it, expect } from "vitest";
import { selectProxyRendition } from "../../src/core/proxy-selector.js";
import type { MediaRendition } from "../../src/types.js";

describe("Proxy Selector", () => {
  it("selects 480p AV1 when both AV1 and H264 480p are present", () => {
    const renditions: MediaRendition[] = [
      { formatId: "240p-av1", resolution: "240p", height: 240, vcodec: "av1", directUrl: "http://example.com/240-av1.mp4" },
      { formatId: "240p-h264", resolution: "240p", height: 240, vcodec: "h264", directUrl: "http://example.com/240-h264.mp4" },
      { formatId: "480p-av1", resolution: "480p", height: 480, vcodec: "av1", directUrl: "http://example.com/480-av1.mp4" },
      { formatId: "480p-h264", resolution: "480p", height: 480, vcodec: "h264", directUrl: "http://example.com/480-h264.mp4" },
      { formatId: "720p-av1", resolution: "720p", height: 720, vcodec: "av1", directUrl: "http://example.com/720-av1.mp4" },
      { formatId: "1080p-av1", resolution: "1080p", height: 1080, vcodec: "av1", directUrl: "http://example.com/1080-av1.mp4" },
    ];

    const selected = selectProxyRendition(renditions);
    expect(selected.formatId).toBe("480p-av1");
    expect(selected.vcodec).toBe("av1");
    expect(selected.height).toBe(480);
  });

  it("falls back to 480p H264 when 480p AV1 is absent", () => {
    const renditions: MediaRendition[] = [
      { formatId: "240p-h264", resolution: "240p", height: 240, vcodec: "h264", directUrl: "http://example.com/240-h264.mp4" },
      { formatId: "480p-h264", resolution: "480p", height: 480, vcodec: "h264", directUrl: "http://example.com/480-h264.mp4" },
      { formatId: "720p-h264", resolution: "720p", height: 720, vcodec: "h264", directUrl: "http://example.com/720-h264.mp4" },
    ];

    const selected = selectProxyRendition(renditions);
    expect(selected.formatId).toBe("480p-h264");
    expect(selected.vcodec).toBe("h264");
    expect(selected.height).toBe(480);
  });

  it("falls back to nearest low-res (< 720p) when 480p is entirely absent", () => {
    const renditions: MediaRendition[] = [
      { formatId: "240p-h264", resolution: "240p", height: 240, vcodec: "h264", directUrl: "http://example.com/240-h264.mp4" },
      { formatId: "360p-h264", resolution: "360p", height: 360, vcodec: "h264", directUrl: "http://example.com/360-h264.mp4" },
      { formatId: "720p-h264", resolution: "720p", height: 720, vcodec: "h264", directUrl: "http://example.com/720-h264.mp4" },
    ];

    const selected = selectProxyRendition(renditions);
    expect(selected.formatId).toBe("360p-h264");
    expect(selected.height).toBe(360);
  });

  it("falls back to lowest available rendition if only >= 720p exists", () => {
    const renditions: MediaRendition[] = [
      { formatId: "720p-h264", resolution: "720p", height: 720, vcodec: "h264", directUrl: "http://example.com/720-h264.mp4" },
      { formatId: "1080p-h264", resolution: "1080p", height: 1080, vcodec: "h264", directUrl: "http://example.com/1080-h264.mp4" },
    ];

    const selected = selectProxyRendition(renditions);
    expect(selected.formatId).toBe("720p-h264");
    expect(selected.height).toBe(720);
  });

  it("throws error if rendition list is empty", () => {
    expect(() => selectProxyRendition([])).toThrow("No renditions available");
  });
});
