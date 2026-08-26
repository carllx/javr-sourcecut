import { describe, it, expect, vi } from "vitest";
import {
  AstalaVrAdapter,
  parseAstalaVrHtml,
  extractVideoIdFromUrl,
} from "../../src/adapters/astalavr/index.js";

describe("AstalaVR URL & HTML Parser", () => {
  const sampleAstalaHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>Kenzie Reeves Fucks Big Dick In Full VR Scene | AstalaVR</title>
      <meta property="og:title" content="Kenzie Reeves Fucks Big Dick In Full VR Scene">
      <meta property="og:url" content="https://astalavr.com/videos/7gYMp/Kenzie-Reeves-Fucks-Big-Dick-In-Full-VR-Scene">
      <meta property="video:actor" content="Kenzie Reeves">
      <meta property="video:duration" content="2603">
      <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "VideoObject",
        "name": "Kenzie Reeves Fucks Big Dick In Full VR Scene",
        "duration": "PT43M22S"
      }
      </script>
    </head>
    <body>
      <main class="w-full mx-auto max-w-5xl px-18" data-video-id="7gYMp">
        <h2 class="mt-16 font-bold leading-tight fz-20">
          Kenzie Reeves Fucks Big Dick In Full VR Scene
        </h2>
        <div class="relative mt-10 js-video-wrapper">
          <dl8-video
            crossorigin display-mode="inline"
            aspect="640:360"
            title="Kenzie Reeves Fucks Big Dick In Full VR Scene"
            format="STEREO_180_LR"
            poster="https://cdn2.astalavr.com/7gYMp/poster_mini.jpg"
            fps="60"
            data-poster-full="https://cdn2.astalavr.com/7gYMp/poster.jpg"
          >
            <source src="https://cdn3.astalavr.com/7gYMp/720P.mp4?cb=3&amp;token=1787731087-OpGuGTYK5PmVkUh10SnIJlaldbVgiT%2Fwe2%2BVqq0eA9g%3D" type="video/mp4" quality="720P" />
            <source src="https://cdn3.astalavr.com/7gYMp/1440P.mp4?cb=3&amp;token=1787731087-xmhKh8VmGlo2osDs4BGOQpInbsOAzPWU7O9Pk0guMxg%3D" type="video/mp4" quality="1440P" />
            <source src="https://cdn3.astalavr.com/7gYMp/2048P.mp4?cb=3&amp;token=1787731087-0QFXVwMnQ9NtEsKjKgQQCNFw3m2UmcfOsJ6HAX3ShVY%3D" type="video/mp4" quality="4K" />
          </dl8-video>
        </div>
        <div class="flex items-center">
          <div class="actress-item bg-cF0 dark:bg-stone-700 p-8 pt-3 flex mb-10 mr-16">
            <a href="/search/Kenzie+Reeves">Kenzie Reeves</a>
          </div>
        </div>
      </main>
    </body>
    </html>
  `;

  const sampleWithoutActor = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>Amateur VR Scene | AstalaVR</title>
      <meta property="og:title" content="Amateur VR Scene">
      <meta property="video:duration" content="1200">
    </head>
    <body>
      <main data-video-id="abc12">
        <dl8-video title="Amateur VR Scene" fps="60">
          <source src="https://cdn3.astalavr.com/abc12/1080P.mp4?token=123" type="video/mp4" quality="1080P" />
        </dl8-video>
      </main>
    </body>
    </html>
  `;

  it("extracts video ID from various AstalaVR URL patterns", () => {
    expect(extractVideoIdFromUrl("https://astalavr.com/videos/7gYMp/Kenzie-Reeves-Fucks-Big-Dick-In-Full-VR-Scene")).toBe("7gYMp");
    expect(extractVideoIdFromUrl("https://astalavr.com/videos/7gYMp")).toBe("7gYMp");
    expect(extractVideoIdFromUrl("https://astalavr.com/ja/videos/7gYMp/some-slug")).toBe("7gYMp");
    expect(extractVideoIdFromUrl("https://www.astalavr.com/videos/paM9E/blake-and-her-friend")).toBe("paM9E");
    expect(extractVideoIdFromUrl("http://127.0.0.1:8080/videos/7gYMp/test")).toBe("7gYMp");
    expect(extractVideoIdFromUrl("https://eporner.com/video-5n1ArXshUMZ")).toBeNull();
    expect(extractVideoIdFromUrl("https://other-site.com/videos/123")).toBeNull();
  });

  it("parses AstalaVR HTML into standard SourceDescriptor", () => {
    const descriptor = parseAstalaVrHtml(
      sampleAstalaHtml,
      "https://astalavr.com/videos/7gYMp/Kenzie-Reeves-Fucks-Big-Dick-In-Full-VR-Scene",
      "7gYMp"
    );

    expect(descriptor.provider).toBe("astalavr");
    expect(descriptor.providerAssetId).toBe("7gYMp");
    expect(descriptor.rawTitle).toBe("Kenzie Reeves Fucks Big Dick In Full VR Scene");
    expect(descriptor.durationSeconds).toBe(2603);
    expect(descriptor.declaredPerformers).toEqual(["Kenzie Reeves"]);
    expect(descriptor.observedFilenames).toEqual(["720P.mp4", "1440P.mp4", "2048P.mp4"]);

    // Renditions assertions
    expect(descriptor.renditions.length).toBe(3);

    const [r720, r1440, r2048] = descriptor.renditions;

    expect(r720.formatId).toBe("720p-h264");
    expect(r720.resolution).toBe("720p");
    expect(r720.height).toBe(720);
    expect(r720.fps).toBe(60);
    expect(r720.vcodec).toBe("h264");
    expect(r720.directUrl).toBe("https://cdn3.astalavr.com/7gYMp/720P.mp4?cb=3&token=1787731087-OpGuGTYK5PmVkUh10SnIJlaldbVgiT%2Fwe2%2BVqq0eA9g%3D");

    expect(r1440.formatId).toBe("1440p-h264");
    expect(r1440.height).toBe(1440);
    expect(r1440.fps).toBe(60);

    expect(r2048.formatId).toBe("2048p-h264");
    expect(r2048.height).toBe(2048);
    expect(r2048.fps).toBe(60);
  });

  it("handles video without performers cleanly", () => {
    const descriptor = parseAstalaVrHtml(
      sampleWithoutActor,
      "https://astalavr.com/videos/abc12",
      "abc12"
    );

    expect(descriptor.provider).toBe("astalavr");
    expect(descriptor.providerAssetId).toBe("abc12");
    expect(descriptor.declaredPerformers).toEqual([]);
    expect(descriptor.renditions.length).toBe(1);
    expect(descriptor.renditions[0].formatId).toBe("1080p-h264");
    expect(descriptor.renditions[0].height).toBe(1080);
  });

  it("throws when no downloadable renditions exist", () => {
    const emptyHtml = `<html><body><main data-video-id="none"><p>No video</p></main></body></html>`;
    expect(() => parseAstalaVrHtml(emptyHtml, "https://astalavr.com/videos/none", "none")).toThrow(
      /No downloadable video renditions discovered/i
    );
  });
});

describe("AstalaVrAdapter Integration", () => {
  const adapter = new AstalaVrAdapter();

  it("canHandle only AstalaVR URLs", () => {
    expect(adapter.canHandle("https://astalavr.com/videos/7gYMp/Kenzie-Reeves")).toBe(true);
    expect(adapter.canHandle("https://eporner.com/video-12345")).toBe(false);
  });

  it("resolves via fetchFn and parses descriptor", async () => {
    const mockHtml = `
      <html>
      <head><title>Test VR Video</title></head>
      <body>
        <dl8-video title="Test VR Video" fps="60">
          <source src="https://cdn3.astalavr.com/test1/1080P.mp4?token=abc" type="video/mp4" quality="1080P" />
        </dl8-video>
      </body>
      </html>
    `;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => mockHtml,
    });

    const descriptor = await adapter.resolve("https://astalavr.com/videos/test1", mockFetch as any);
    expect(descriptor.provider).toBe("astalavr");
    expect(descriptor.providerAssetId).toBe("test1");
    expect(descriptor.renditions.length).toBe(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://astalavr.com/videos/test1",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Referer": "https://astalavr.com/",
        }),
      })
    );
  });

  it("throws fail-closed error if page fetch fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    });

    await expect(
      adapter.resolve("https://astalavr.com/videos/blocked1", mockFetch as any)
    ).rejects.toThrow(/Failed to fetch AstalaVR page \(403 Forbidden\)/i);
  });
});
