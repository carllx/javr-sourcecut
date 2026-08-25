import { describe, it, expect } from "vitest";
import { parseEpornerHtml, extractVideoIdFromUrl, EpornerAdapter } from "../../src/adapters/eporner/index.js";

describe("Eporner HTML Parser", () => {
  const sampleWithAv1 = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Sample AV1 Video Title - EPORNER</title>
      <meta property="og:duration" content="904" />
      <script type="application/ld+json">
      {
        "@type": "VideoObject",
        "name": "Sample AV1 Video Title",
        "duration": "PT0H15M04S",
        "description": "sample tags, vr, test"
      }
      </script>
    </head>
    <body>
      <div id="video-info-tags">
        <ul>
          <li class="vit-category"><a href="/cat/asian/">Asian</a></li>
          <li class="vit-category"><a href="/cat/vr-porn/">VR Porn</a></li>
        </ul>
      </div>
      <div id="downloaddiv">
        <div id="hd-porn-dload">
          <div class="dloaddivcol">
            <u>240p:</u>
            <span class="download-av1"><a href="/dload/5n1ArXshUMZ/240/17854268-240p-av1.mp4">Download MP4 (240p, AV1, 27.43 MB)</a></span>
            <span class="download-h264"> or <a href="/dload/5n1ArXshUMZ/240/17854268-240p.mp4"> MP4 (240p, h264, 33 MB)</a></span><br />
            <u>480p:</u>
            <span class="download-av1"><a href="/dload/5n1ArXshUMZ/480/17854268-480p-av1.mp4">Download MP4 (480p, AV1, 60.8 MB)</a></span>
            <span class="download-h264"> or <a href="/dload/5n1ArXshUMZ/480/17854268-480p.mp4"> MP4 (480p, h264, 119.67 MB)</a></span><br />
            <u>720p@60fps HD:</u>
            <span class="download-av1"><a href="/dload/5n1ArXshUMZ/720/17854268-720p-av1.mp4">Download MP4 (720p, AV1, 173.82 MB)</a></span>
            <span class="download-h264"> or <a href="/dload/5n1ArXshUMZ/720/17854268-720p.mp4"> MP4 (720p, h264, 337.42 MB)</a></span><br />
            <u>1080p@60fps HD:</u>
            <span class="download-av1"><a href="/dload/5n1ArXshUMZ/1080/17854268-1080p-av1.mp4">Download MP4 (1080p, AV1, 260.36 MB)</a></span>
            <span class="download-h264"> or <a href="/dload/5n1ArXshUMZ/1080/17854268-1080p.mp4"> MP4 (1080p, h264, 551.39 MB)</a></span><br />
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  const sampleH264Only = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Test 082126 001 Carib 宇野かな美 - EPORNER</title>
      <meta property="og:duration" content="3337" />
    </head>
    <body>
      <div id="downloaddiv">
        <div id="hd-porn-dload">
          <div class="dloaddivcol">
            <u>240p:</u>
            <span class="download-h264"><a href="/dload/i5MIJLt4gu0/240/18043213-240p.mp4">Download MP4 (240p, h264, 121.06 MB)</a></span><br />
            <u>480p:</u>
            <span class="download-h264"><a href="/dload/i5MIJLt4gu0/480/18043213-480p.mp4">Download MP4 (480p, h264, 437.95 MB)</a></span><br />
            <u>720p@60fps HD:</u>
            <span class="download-h264"><a href="/dload/i5MIJLt4gu0/720/18043213-720p.mp4">Download MP4 (720p, h264, 474.14 MB)</a></span><br />
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  it("extracts video ID from multiple Eporner URL patterns", () => {
    expect(extractVideoIdFromUrl("https://www.eporner.com/video-5n1ArXshUMZ/uploading-for-good-av1/")).toBe("5n1ArXshUMZ");
    expect(extractVideoIdFromUrl("https://www.eporner.com/video/5n1ArXshUMZ/")).toBe("5n1ArXshUMZ");
    expect(extractVideoIdFromUrl("https://www.eporner.com/hd-porn/5n1ArXshUMZ/some-slug/")).toBe("5n1ArXshUMZ");
    expect(extractVideoIdFromUrl("https://www.eporner.com/embed/5n1ArXshUMZ/")).toBe("5n1ArXshUMZ");
    expect(extractVideoIdFromUrl("https://other-site.com/video-123")).toBeNull();
  });

  it("parses page with both AV1 and H264 renditions", () => {
    const descriptor = parseEpornerHtml(
      sampleWithAv1,
      "https://www.eporner.com/video-5n1ArXshUMZ/uploading-for-good-av1/",
      "5n1ArXshUMZ"
    );

    expect(descriptor.provider).toBe("eporner");
    expect(descriptor.providerAssetId).toBe("5n1ArXshUMZ");
    expect(descriptor.rawTitle).toBe("Sample AV1 Video Title");
    expect(descriptor.durationSeconds).toBe(904);
    expect(descriptor.renditions.length).toBe(8);

    const av1_480 = descriptor.renditions.find((r) => r.formatId === "480p-av1");
    expect(av1_480).toBeDefined();
    expect(av1_480?.height).toBe(480);
    expect(av1_480?.vcodec).toBe("av1");
    expect(av1_480?.directUrl).toBe("https://www.eporner.com/dload/5n1ArXshUMZ/480/17854268-480p-av1.mp4");
    expect(av1_480?.formattedSize).toBe("60.8 MB");

    const h264_480 = descriptor.renditions.find((r) => r.formatId === "480p-h264");
    expect(h264_480).toBeDefined();
    expect(h264_480?.height).toBe(480);
    expect(h264_480?.vcodec).toBe("h264");
    expect(h264_480?.directUrl).toBe("https://www.eporner.com/dload/5n1ArXshUMZ/480/17854268-480p.mp4");
  });

  it("parses page with only H264 renditions", () => {
    const descriptor = parseEpornerHtml(
      sampleH264Only,
      "https://www.eporner.com/video-i5MIJLt4gu0/test-082126-001-carib-yu-yekana-mei/",
      "i5MIJLt4gu0"
    );

    expect(descriptor.provider).toBe("eporner");
    expect(descriptor.providerAssetId).toBe("i5MIJLt4gu0");
    expect(descriptor.rawTitle).toBe("Test 082126 001 Carib 宇野かな美");
    expect(descriptor.durationSeconds).toBe(3337);
    expect(descriptor.renditions.length).toBe(3);
    expect(descriptor.renditions.map((r) => r.formatId)).toEqual([
      "240p-h264",
      "480p-h264",
      "720p-h264"
    ]);
  });
});
