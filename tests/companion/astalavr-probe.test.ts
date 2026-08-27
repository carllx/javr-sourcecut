import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import { detectAstalaVrPage, parseAstalaVrDomRenditions } from "../../companion/src/astalavr.js";

describe("AstalaVR Companion Probe", () => {
  it("1. Cloudflare challenge page -> status is WAITING_FOR_REAL_PAGE and not real", () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const document = window.document;
    document.title = "Just a moment...";
    document.body.innerHTML = `<div id="challenge-running"><p>Checking your browser before accessing...</p></div>`;

    const detection = detectAstalaVrPage(document as any, "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao");
    expect(detection.status).toBe("WAITING_FOR_REAL_PAGE");
    expect(detection.isChallenge).toBe(true);
    expect(detection.isRealPage).toBe(false);
    expect(detection.videoId).toBe("qDAVn");
  });

  it("2. AstalaVR URL but no dl8-video -> status is WAITING_FOR_VIDEO_DOM and not real", () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const document = window.document;
    document.title = "AstalaVR: TMAVR285 Jun Suehiro";
    document.body.innerHTML = `<main data-video-id="qDAVn"><h2>Title</h2><p>Loading player...</p></main>`;

    const detection = detectAstalaVrPage(document as any, "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao");
    expect(detection.status).toBe("WAITING_FOR_VIDEO_DOM");
    expect(detection.isChallenge).toBe(false);
    expect(detection.isRealPage).toBe(false);
    expect(detection.videoId).toBe("qDAVn");
  });

  it("3. dl8-video + source -> status is REAL_PAGE_ACTIVE and renditions parsed correctly without assuming codec", () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const document = window.document;
    document.title = "AstalaVR: TMAVR285";
    document.body.innerHTML = `
      <main data-video-id="qDAVn">
        <dl8-video title="TMAVR285" fps="60">
          <source quality="720p" src="https://cdn3.astalavr.com/qDAVn/720P.mp4?token=secret123" />
          <source quality="1440p" type='video/mp4; codecs="avc1.640028"' src="https://cdn3.astalavr.com/qDAVn/1440P.mp4?token=secret456" />
          <source quality="2048p" type="video/mp4" src="https://cdn3.astalavr.com/qDAVn/2048P.mp4?token=secret789" />
        </dl8-video>
      </main>
    `;

    const detection = detectAstalaVrPage(document as any, "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao");
    expect(detection.status).toBe("REAL_PAGE_ACTIVE");
    expect(detection.isRealPage).toBe(true);

    const renditions = parseAstalaVrDomRenditions(document as any, "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao");
    expect(renditions).toHaveLength(3);

    // 720p (no type attribute -> unknown codec & unknown mimeType)
    expect(renditions[0].resolution).toBe("720p");
    expect(renditions[0].height).toBe(720);
    expect(renditions[0].vcodec).toBe("unknown");
    expect(renditions[0].mimeType).toBe("unknown");
    expect(renditions[0].mediaHostname).toBe("cdn3.astalavr.com");

    // 1440p (codecs="avc1.640028" -> avc1.640028)
    expect(renditions[1].resolution).toBe("1440p");
    expect(renditions[1].height).toBe(1440);
    expect(renditions[1].vcodec).toBe("avc1.640028");
    expect(renditions[1].mimeType).toBe('video/mp4; codecs="avc1.640028"');
    expect(renditions[1].mediaHostname).toBe("cdn3.astalavr.com");

    // 2048p (type="video/mp4" without codec -> unknown)
    expect(renditions[2].resolution).toBe("2048p");
    expect(renditions[2].height).toBe(2048);
    expect(renditions[2].vcodec).toBe("unknown");
    expect(renditions[2].mimeType).toBe("video/mp4");
    expect(renditions[2].mediaHostname).toBe("cdn3.astalavr.com");
  });

  it("4. UI output does not leak raw signed URL into general display format string", () => {
    const rawUrl = "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=SUPER_SECRET_TOKEN_XYZ";
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const document = window.document;
    document.body.innerHTML = `<dl8-video><source quality="720p" src="${rawUrl}" /></dl8-video>`;

    const renditions = parseAstalaVrDomRenditions(document as any, "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao");
    expect(renditions).toHaveLength(1);

    // Formatted label verification
    const r = renditions[0];
    const displayLabel = `[${r.resolution}] ${r.vcodec} (${r.mimeType}) Host: ${r.mediaHostname}`;
    expect(displayLabel).not.toContain("SUPER_SECRET_TOKEN_XYZ");
    expect(displayLabel).not.toContain("token=");
    expect(displayLabel).toBe("[720p] unknown (unknown) Host: cdn3.astalavr.com");
  });

  it("5. Strictly restricts source selector to dl8-video, ignoring external video tags", () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const document = window.document;
    document.body.innerHTML = `
      <dl8-video>
        <source quality="1440p" src="https://cdn3.astalavr.com/qDAVn/1440P.mp4?token=target" />
      </dl8-video>
      <video id="unrelated-preview">
        <source quality="480p" src="https://ads.astalavr.com/preview.mp4" />
      </video>
    `;

    const renditions = parseAstalaVrDomRenditions(document as any, "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao");
    expect(renditions).toHaveLength(1);
    expect(renditions[0].resolution).toBe("1440p");
    expect(renditions[0].mediaHostname).toBe("cdn3.astalavr.com");
  });
});
