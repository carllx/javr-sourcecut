import { describe, it, expect } from "vitest";
import { parseEpornerHtml, extractVideoIdFromUrl } from "../../src/adapters/eporner/index.js";

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
          <li class="vit-tag"><a href="/tag/big-tits/">Big Tits</a></li>
          <li class="vit-pornstar"><a href="/pornstar/yua-mikami/">Yua Mikami</a></li>
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

  const sampleWithoutPornstar = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>My Spinster Boss - EPORNER</title>
      <meta property="og:duration" content="1503" />
    </head>
    <body>
      <div id="video-info-tags">
        <ul>
          <li class="vit-category"><a href="/cat/asian/">Asian</a></li>
          <li class="vit-tag"><a href="/tag/big-tits/">Big Tits</a></li>
          <li class="vit-tag"><a href="/tag/pov/">POV</a></li>
        </ul>
      </div>
      <div id="downloaddiv">
        <div id="hd-porn-dload">
          <div class="dloaddivcol">
            <u>480p:</u>
            <span class="download-av1"><a href="/dload/y1qUfge13j0/480/14500253-480p-av1.mp4">Download MP4 (480p, AV1, 97 MB)</a></span>
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

  it("extracts only explicit pornstars and ignores generic categories/tags", () => {
    const descriptor = parseEpornerHtml(
      sampleWithAv1,
      "https://www.eporner.com/video-5n1ArXshUMZ/uploading-for-good-av1/",
      "5n1ArXshUMZ"
    );

    expect(descriptor.declaredPerformers).toEqual(["Yua Mikami"]);
    expect(descriptor.renditions.length).toBe(8);

    // supportsRange should be undefined before actual range probe
    expect(descriptor.renditions[0].supportsRange).toBeUndefined();
  });

  it("leaves declaredPerformers empty when only categories/tags are present", () => {
    const descriptor = parseEpornerHtml(
      sampleWithoutPornstar,
      "https://www.eporner.com/video-y1qUfge13j0/my-spinster-boss/",
      "y1qUfge13j0"
    );

    expect(descriptor.declaredPerformers).toEqual([]);
    expect(descriptor.renditions.length).toBe(1);
    expect(descriptor.renditions[0].supportsRange).toBeUndefined();
  });
});
