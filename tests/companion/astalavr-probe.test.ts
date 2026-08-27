import { describe, it, expect, vi } from "vitest";
import { Window } from "happy-dom";
import { detectAstalaVrPage, parseAstalaVrDomRenditions, testBrowserMedia720p, inspectActivePlayer } from "../../companion/src/astalavr.js";
import { AstalaVrProbeApp } from "../../companion/src/astalavr-index.js";

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

  it("6. testBrowserMedia720p resolves PASS on loadedmetadata and cleans up element", async () => {
    const window = new Window();
    const doc = window.document;
    let cleanedUp = false;

    // Mock HTMLVideoElement behavior in test environment
    const mockVideo: any = {
      preload: "",
      src: "",
      duration: 123.45,
      load: () => {
        setTimeout(() => {
          if (mockVideo.onloadedmetadata) {
            mockVideo.onloadedmetadata();
          }
        }, 10);
      },
      removeAttribute: (attr: string) => {
        if (attr === "src") {
          mockVideo.src = "";
          cleanedUp = true;
        }
      },
      remove: () => {},
    };

    const spy = vi.spyOn(doc, "createElement").mockImplementation((tag: string) => {
      if (tag === "video") return mockVideo as any;
      return (Window.prototype as any).document.createElement(tag);
    });

    const result = await testBrowserMedia720p("https://cdn3.astalavr.com/qDAVn/720P.mp4?token=fake", 1000, doc as any);
    expect(result.pass).toBe(true);
    expect(result.duration).toBe(123.45);
    expect(cleanedUp).toBe(true);
    expect(mockVideo.src).toBe("");

    spy.mockRestore();
  });

  it("7. testBrowserMedia720p resolves FAIL on error and cleans up element without leaking token", async () => {
    const window = new Window();
    const doc = window.document;
    let cleanedUp = false;

    const mockVideo: any = {
      preload: "",
      src: "",
      error: { code: 4 }, // MEDIA_ERR_SRC_NOT_SUPPORTED
      load: () => {
        setTimeout(() => {
          if (mockVideo.onerror) {
            mockVideo.onerror();
          }
        }, 10);
      },
      removeAttribute: (attr: string) => {
        if (attr === "src") {
          mockVideo.src = "";
          cleanedUp = true;
        }
      },
      remove: () => {},
    };

    const spy = vi.spyOn(doc, "createElement").mockImplementation((tag: string) => {
      if (tag === "video") return mockVideo as any;
      return (Window.prototype as any).document.createElement(tag);
    });

    const result = await testBrowserMedia720p("https://cdn3.astalavr.com/qDAVn/720P.mp4?token=sensitive", 1000, doc as any);
    expect(result.pass).toBe(false);
    expect(result.errorCode).toBe(4);
    expect(cleanedUp).toBe(true);
    expect(mockVideo.src).toBe("");

    spy.mockRestore();
  });

  it("8. live renditions initially = 3, subsequent DOM parse = 0 uses MEMORY_CACHE (effective 3)", () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const originalWindow = (globalThis as any).window;
    const originalDocument = (globalThis as any).document;
    (globalThis as any).window = window;
    (globalThis as any).document = window.document;

    window.document.body.innerHTML = `
      <dl8-video title="TMAVR285">
        <source quality="720p" src="https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token1" />
        <source quality="1440p" src="https://cdn3.astalavr.com/qDAVn/1440P.mp4?token=token2" />
        <source quality="2048p" src="https://cdn3.astalavr.com/qDAVn/2048P.mp4?token=token3" />
      </dl8-video>
    `;

    const app = new AstalaVrProbeApp();
    app.init();

    const contentEl = window.document.getElementById("astalavr-probe-content")!;
    expect(contentEl.innerHTML).toContain("ASSET_ID:</strong> qDAVn");
    expect(contentEl.innerHTML).toContain("RENDITION_COUNT:</strong> 3");
    expect(contentEl.innerHTML).toContain("RENDITION_SOURCE:</strong> LIVE_DOM");

    // Simulate AstalaVR player consuming/removing <source> elements after user presses play
    window.document.querySelector("dl8-video")!.innerHTML = "";
    expect(window.document.querySelectorAll("dl8-video source").length).toBe(0);

    // Run checkAndRender cycle
    app.checkAndRender();

    // Verify MEMORY_CACHE preserves rendition count and switches source label
    expect(contentEl.innerHTML).toContain("ASSET_ID:</strong> qDAVn");
    expect(contentEl.innerHTML).toContain("RENDITION_COUNT:</strong> 3");
    expect(contentEl.innerHTML).toContain("RENDITION_SOURCE:</strong> MEMORY_CACHE");
    expect(contentEl.innerHTML).toContain("[720p]");
    expect(contentEl.innerHTML).toContain("[1440p]");
    expect(contentEl.innerHTML).toContain("[2048p]");

    app.destroy();
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
  });

  it("9. assetId changes -> old memory cache is immediately invalidated and not reused", () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const originalWindow = (globalThis as any).window;
    const originalDocument = (globalThis as any).document;
    (globalThis as any).window = window;
    (globalThis as any).document = window.document;

    window.document.body.innerHTML = `
      <dl8-video title="TMAVR285">
        <source quality="720p" src="https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token1" />
      </dl8-video>
    `;

    const app = new AstalaVrProbeApp();
    app.init();

    const contentEl = window.document.getElementById("astalavr-probe-content")!;
    expect(contentEl.innerHTML).toContain("ASSET_ID:</strong> qDAVn");
    expect(contentEl.innerHTML).toContain("RENDITION_COUNT:</strong> 1");

    // Change location to a new video asset without any rendered sources
    (window as any).location.href = "https://astalavr.com/videos/OTHER123/new-title";
    window.document.body.innerHTML = `<dl8-video title="Other Video"></dl8-video>`;

    app.checkAndRender();

    expect(contentEl.innerHTML).toContain("ASSET_ID:</strong> OTHER123");
    expect(contentEl.innerHTML).toContain("RENDITION_COUNT:</strong> 0");
    expect(contentEl.innerHTML).toContain("no &lt;source&gt; tags rendered yet");

    app.destroy();
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
  });

  it("10. clicking Test 720p in browser stops scheduled polling so result UI is preserved", async () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const originalWindow = (globalThis as any).window;
    const originalDocument = (globalThis as any).document;
    (globalThis as any).window = window;
    (globalThis as any).document = window.document;

    window.document.body.innerHTML = `
      <dl8-video title="TMAVR285">
        <source quality="720p" src="https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token1" />
      </dl8-video>
    `;

    const mockVideo: any = {
      preload: "",
      src: "",
      duration: 543.21,
      load: () => {
        setTimeout(() => {
          if (mockVideo.onloadedmetadata) {
            mockVideo.onloadedmetadata();
          }
        }, 50);
      },
      removeAttribute: () => {},
      remove: () => {},
    };

    const origCreateElement = window.document.createElement.bind(window.document);
    const spy = vi.spyOn(window.document, "createElement").mockImplementation((tag: string) => {
      if (tag === "video") return mockVideo as any;
      return origCreateElement(tag);
    });

    const app = new AstalaVrProbeApp();
    app.init();

    const testBtn = window.document.getElementById("astalavr-test-720p-btn") as HTMLButtonElement;
    expect(testBtn).not.toBeNull();

    // Click test button
    testBtn.click();

    // Wait for async test completion
    await new Promise((r) => setTimeout(r, 100));

    const resultEl = window.document.getElementById("astalavr-test-720p-result")!;
    expect(resultEl.style.display).toBe("block");
    expect(resultEl.innerHTML).toContain("720P_BROWSER_MEDIA_TEST=PASS");
    expect(resultEl.innerHTML).toContain("DURATION=543.21s");

    // In a regular cycle, mutating DOM shouldn't re-render and overwrite test result because polling stopped
    window.document.querySelector("dl8-video")!.innerHTML = "";
    // Wait an extra interval
    await new Promise((r) => setTimeout(r, 150));

    expect(window.document.getElementById("astalavr-test-720p-result")!.innerHTML).toContain("720P_BROWSER_MEDIA_TEST=PASS");

    app.destroy();
    spy.mockRestore();
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
  });

  it("11. inspectActivePlayer returns matching cached rendition (720p) without leaking token", () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const doc = window.document;

    const cachedRenditions = [
      {
        formatId: "720p-unknown",
        resolution: "720p",
        height: 720,
        vcodec: "unknown",
        mimeType: "unknown",
        mediaHostname: "cdn3.astalavr.com",
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=cached_token_123",
      },
      {
        formatId: "1440p-unknown",
        resolution: "1440p",
        height: 1440,
        vcodec: "unknown",
        mimeType: "unknown",
        mediaHostname: "cdn3.astalavr.com",
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/1440P.mp4?token=cached_token_456",
      },
    ];

    doc.body.innerHTML = `
      <dl8-video title="TMAVR285">
        <video src="https://cdn3.astalavr.com/qDAVn/720P.mp4?token=active_player_secret_789"></video>
      </dl8-video>
    `;

    const videoEl = doc.querySelector("video") as any;
    Object.defineProperty(videoEl, "readyState", { value: 4, configurable: true });
    Object.defineProperty(videoEl, "networkState", { value: 2, configurable: true });
    Object.defineProperty(videoEl, "paused", { value: false, configurable: true });
    Object.defineProperty(videoEl, "duration", { value: 1800.5, configurable: true });
    Object.defineProperty(videoEl, "videoWidth", { value: 1280, configurable: true });
    Object.defineProperty(videoEl, "videoHeight", { value: 720, configurable: true });

    const info = inspectActivePlayer(doc as any, cachedRenditions as any);
    expect(info.activePlayerFound).toBe(true);
    expect(info.tagName).toBe("VIDEO");
    expect(info.readyState).toBe(4);
    expect(info.networkState).toBe(2);
    expect(info.paused).toBe(false);
    expect(info.duration).toBe(1800.5);
    expect(info.videoWidth).toBe(1280);
    expect(info.videoHeight).toBe(720);
    expect(info.currentSrcKind).toBe("DIRECT_CDN");
    expect(info.currentSrcHost).toBe("cdn3.astalavr.com");
    expect(info.currentSrcPath).toBe("/qDAVn/720P.mp4");
    expect(info.currentSrcHasToken).toBe(true);
    expect(info.matchedCachedRendition).toBe("720p");
  });

  it("12. inspectActivePlayer identifies blob: currentSrcKind with MATCHED_CACHED_RENDITION=NONE", () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const doc = window.document;

    doc.body.innerHTML = `
      <dl8-video title="TMAVR285">
        <video src="blob:https://astalavr.com/550e8400-e29b-41d4-a716-446655440000"></video>
      </dl8-video>
    `;

    const info = inspectActivePlayer(doc as any, []);
    expect(info.activePlayerFound).toBe(true);
    expect(info.currentSrcKind).toBe("BLOB");
    expect(info.matchedCachedRendition).toBe("NONE");
  });

  it("13. clicking Inspect active player renders sanitized inspection report in UI", () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const originalWindow = (globalThis as any).window;
    const originalDocument = (globalThis as any).document;
    (globalThis as any).window = window;
    (globalThis as any).document = window.document;

    window.document.body.innerHTML = `
      <dl8-video title="TMAVR285">
        <source quality="720p" src="https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token1" />
        <video src="https://cdn3.astalavr.com/qDAVn/720P.mp4?token=super_secret_query"></video>
      </dl8-video>
    `;

    const app = new AstalaVrProbeApp();
    app.init();

    const inspectBtn = window.document.getElementById("astalavr-inspect-player-btn") as HTMLButtonElement;
    expect(inspectBtn).not.toBeNull();

    inspectBtn.click();

    const inspectResultEl = window.document.getElementById("astalavr-inspect-player-result")!;
    expect(inspectResultEl.style.display).toBe("block");
    expect(inspectResultEl.innerHTML).toContain("ACTIVE_PLAYER_FOUND=</strong>YES");
    expect(inspectResultEl.innerHTML).toContain("CURRENT_SRC_HOST=</strong>cdn3.astalavr.com");
    expect(inspectResultEl.innerHTML).toContain("CURRENT_SRC_PATH=</strong>/qDAVn/720P.mp4");
    expect(inspectResultEl.innerHTML).toContain("CURRENT_SRC_HAS_TOKEN=</strong>YES");
    expect(inspectResultEl.innerHTML).toContain("MATCHED_CACHED_RENDITION=</strong>720p");
    expect(inspectResultEl.innerHTML).not.toContain("super_secret_query");
    expect(inspectResultEl.innerHTML).not.toContain("token=");

    app.destroy();
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
  });

  it("14. clicking Inspect active player stops polling so result is preserved on subsequent DOM changes", async () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const originalWindow = (globalThis as any).window;
    const originalDocument = (globalThis as any).document;
    (globalThis as any).window = window;
    (globalThis as any).document = window.document;

    window.document.body.innerHTML = `
      <dl8-video title="TMAVR285">
        <source quality="720p" src="https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token1" />
        <video src="https://cdn3.astalavr.com/qDAVn/720P.mp4?token=super_secret_query"></video>
      </dl8-video>
    `;

    const app = new AstalaVrProbeApp();
    app.init();

    const inspectBtn = window.document.getElementById("astalavr-inspect-player-btn") as HTMLButtonElement;
    expect(inspectBtn).not.toBeNull();

    // Click inspect button
    inspectBtn.click();

    const inspectResultEl = window.document.getElementById("astalavr-inspect-player-result")!;
    expect(inspectResultEl.style.display).toBe("block");
    expect(inspectResultEl.innerHTML).toContain("ACTIVE_PLAYER_FOUND=</strong>YES");

    // Clear sources or mutate DOM
    window.document.querySelector("dl8-video")!.innerHTML = "";
    // Wait interval
    await new Promise((r) => setTimeout(r, 100));

    // Result must remain visible and intact
    expect(window.document.getElementById("astalavr-inspect-player-result")!.innerHTML).toContain("ACTIVE_PLAYER_FOUND=</strong>YES");

    app.destroy();
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
  });

  it("15. unrelated external video outside dl8-video is rejected -> ACTIVE_PLAYER_FOUND=NO", () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const doc = window.document;

    doc.body.innerHTML = `
      <dl8-video title="TMAVR285"></dl8-video>
      <video id="unrelated-ad-video" src="https://ads.example.com/ad.mp4"></video>
    `;

    const info = inspectActivePlayer(doc as any, []);
    expect(info.activePlayerFound).toBe(false);
    expect(info.currentSrcKind).toBe("EMPTY");
    expect(info.matchedCachedRendition).toBe("NONE");
  });
});
