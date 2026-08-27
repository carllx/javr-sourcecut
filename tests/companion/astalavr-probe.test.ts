import { describe, it, expect, vi } from "vitest";
import { Window } from "happy-dom";
import {
  detectAstalaVrPage,
  parseAstalaVrDomRenditions,
  testBrowserMedia720p,
  inspectActivePlayer,
  inspectPlaybackResources,
  testActualPlayback720p,
  testActualPlayback720pRange,
  testActualPlaybackGmRange,
  testActualPlaybackPaired1MiB,
  download720pProxyFile,
  checkActiveBridgeJob,
  transfer720pProxyToBridge,
} from "../../companion/src/astalavr.js";
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

    // Normal UI must NOT have historical diagnostic buttons
    expect(window.document.getElementById("astalavr-test-720p-btn")).toBeNull();
    expect(window.document.getElementById("astalavr-inspect-player-btn")).toBeNull();
    expect(window.document.getElementById("astalavr-inspect-resources-btn")).toBeNull();
    expect(window.document.getElementById("astalavr-test-actual-playback-btn")).toBeNull();
    expect(window.document.getElementById("astalavr-test-actual-range-btn")).toBeNull();
    expect(window.document.getElementById("astalavr-test-gm-range-btn")).toBeNull();

    // Transport status section is visible in normal UI
    const transportStatusEl = window.document.getElementById("astalavr-transport-status-section");
    expect(transportStatusEl).not.toBeNull();
    expect(transportStatusEl!.innerHTML).toContain("Browser transport");
    expect(transportStatusEl!.innerHTML).toContain("Actual playback: <strong>WAITING</strong>");

    // Developer diagnostics details element is present and default collapsed
    const devDetails = window.document.getElementById("astalavr-dev-diagnostics") as HTMLDetailsElement;
    expect(devDetails).not.toBeNull();
    expect(devDetails.open).toBe(false);

    // Paired test button exists inside developer diagnostics
    const testPairBtn = window.document.getElementById("astalavr-test-pair-range-btn") as HTMLButtonElement;
    expect(testPairBtn).not.toBeNull();

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

  it("13. inspectActivePlayer function safely reports properties without leaking token", () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const doc = window.document;

    doc.body.innerHTML = `
      <dl8-video title="TMAVR285">
        <source quality="720p" src="https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token1" />
        <video src="https://cdn3.astalavr.com/qDAVn/720P.mp4?token=super_secret_query"></video>
      </dl8-video>
    `;

    const info = inspectActivePlayer(doc as any, [
      {
        formatId: "720p-unknown",
        resolution: "720p",
        height: 720,
        vcodec: "unknown",
        mimeType: "unknown",
        mediaHostname: "cdn3.astalavr.com",
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=cached_token_123",
      },
    ]);

    expect(info.activePlayerFound).toBe(true);
    expect(info.currentSrcHost).toBe("cdn3.astalavr.com");
    expect(info.currentSrcPath).toBe("/qDAVn/720P.mp4");
    expect(info.currentSrcHasToken).toBe(true);
    expect(info.matchedCachedRendition).toBe("720p");
    expect(JSON.stringify(info)).not.toContain("super_secret_query");
  });

  it("14. opening Developer diagnostics details does not execute any network request", async () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const originalWindow = (globalThis as any).window;
    const originalDocument = (globalThis as any).document;
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    (globalThis as any).window = window;
    (globalThis as any).document = window.document;

    window.document.body.innerHTML = `
      <dl8-video title="TMAVR285">
        <source quality="720p" src="https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token1" />
      </dl8-video>
    `;

    const app = new AstalaVrProbeApp();
    app.init();

    const devDetails = window.document.getElementById("astalavr-dev-diagnostics") as HTMLDetailsElement;
    expect(devDetails).not.toBeNull();
    expect(devDetails.open).toBe(false);

    // Open the details accordion
    devDetails.open = true;
    devDetails.dispatchEvent(new window.Event("toggle"));

    await new Promise((r) => setTimeout(r, 50));

    // Must NOT have issued any network request just by expanding
    expect(fetchSpy).toHaveBeenCalledTimes(0);

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

  it("16. inspectPlaybackResources matches cached 720p URL with token, reports path only without query", () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const doc = window.document;
    doc.body.innerHTML = `<dl8-video title="TMAVR285"></dl8-video>`;

    const cachedRenditions = [
      {
        formatId: "720p-unknown",
        resolution: "720p",
        height: 720,
        vcodec: "unknown",
        mimeType: "unknown",
        mediaHostname: "cdn3.astalavr.com",
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=cached_secret_123",
      },
    ];

    const mockPerf: any = {
      getEntriesByType: (type: string) => {
        if (type === "resource") {
          return [
            {
              name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=active_stream_token_456&h=123",
              initiatorType: "xmlhttprequest",
              duration: 45.6,
              transferSize: 1048576,
              encodedBodySize: 1048000,
            },
          ];
        }
        return [];
      },
    };

    const res = inspectPlaybackResources(doc as any, cachedRenditions as any, mockPerf);
    expect(res.dl8VideoFound).toBe(true);
    expect(res.dl8ShadowRoot).toBe("UNAVAILABLE");
    expect(res.resourceMatchCount).toBe(1);
    expect(res.resources[0].initiatorType).toBe("xmlhttprequest");
    expect(res.resources[0].host).toBe("cdn3.astalavr.com");
    expect(res.resources[0].path).toBe("/qDAVn/720P.mp4");
    expect(res.resources[0].hasToken).toBe(true);
    expect(res.resources[0].matchedRendition).toBe("720p");
    expect(res.resources[0].exactCachedUrlMatch).toBe("NO");
    expect(res.resources[0].queryMatch).toBe("NO");
    expect(res.resources[0].tokenMatch).toBe("NO");
    expect(res.resources[0].sameFullUrlAsPreviousMatch).toBe("N/A");
    expect(res.resources[0].durationMs).toBe(46);
    expect(res.resources[0].transferSize).toBe(1048576);
    expect(res.resources[0].encodedBodySize).toBe(1048000);
  });

  it("17. inspectPlaybackResources excludes unrelated CDN/third-party resources", () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const doc = window.document;

    const mockPerf: any = {
      getEntriesByType: (type: string) => {
        if (type === "resource") {
          return [
            {
              name: "https://analytics.google.com/collect?v=2",
              initiatorType: "fetch",
              duration: 10,
            },
            {
              name: "https://static.cloudflareinsights.com/beacon.min.js",
              initiatorType: "script",
              duration: 20,
            },
          ];
        }
        return [];
      },
    };

    const res = inspectPlaybackResources(doc as any, [], mockPerf);
    expect(res.resourceMatchCount).toBe(0);
    expect(res.resources).toHaveLength(0);
  });

  it("18. inspectPlaybackResources excludes other *.astalavr.com subdomains and non-rendition paths (exact cdn3 only)", () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const doc = window.document;

    const mockPerf: any = {
      getEntriesByType: (type: string) => {
        if (type === "resource") {
          return [
            {
              name: "https://astalavr.com/assets/app.js",
              initiatorType: "script",
              duration: 15,
            },
            {
              name: "https://static.astalavr.com/image.jpg",
              initiatorType: "img",
              duration: 25,
            },
            {
              name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=secret",
              initiatorType: "media",
              duration: 100,
            },
          ];
        }
        return [];
      },
    };

    const res = inspectPlaybackResources(doc as any, [], mockPerf);
    expect(res.resourceMatchCount).toBe(1);
    expect(res.resources).toHaveLength(1);
    expect(res.resources[0].host).toBe("cdn3.astalavr.com");
    expect(res.resources[0].path).toBe("/qDAVn/720P.mp4");
    expect(res.resources[0].hasToken).toBe(true);
  });

  it("19. inspectPlaybackResources returns RESOURCE_MATCH_COUNT=0 when no resources match", () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const doc = window.document;

    const mockPerf: any = {
      getEntriesByType: () => [],
    };

    const res = inspectPlaybackResources(doc as any, [], mockPerf);
    expect(res.dl8VideoFound).toBe(false);
    expect(res.dl8ShadowRoot).toBe("UNAVAILABLE");
    expect(res.resourceMatchCount).toBe(0);
    expect(res.resources).toHaveLength(0);
  });

  it("20. inspectPlaybackResources safely parses resource timing entries without leaking token", () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const doc = window.document;

    const mockPerf = {
      getEntriesByType: (type: string) => {
        if (type === "resource") {
          return [
            {
              name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=SUPER_SECRET_PLAYBACK_TOKEN",
              initiatorType: "media",
              duration: 33.2,
              transferSize: 524288,
              encodedBodySize: 524000,
            },
          ];
        }
        return [];
      },
    };

    doc.body.innerHTML = `
      <dl8-video title="TMAVR285">
        <source quality="720p" src="https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token1" />
      </dl8-video>
    `;

    const res = inspectPlaybackResources(
      doc as any,
      [
        {
          formatId: "720p-unknown",
          resolution: "720p",
          height: 720,
          vcodec: "unknown",
          mimeType: "unknown",
          mediaHostname: "cdn3.astalavr.com",
          fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token1",
        },
      ],
      mockPerf as any
    );

    expect(res.dl8VideoFound).toBe(true);
    expect(res.dl8ShadowRoot).toBe("UNAVAILABLE");
    expect(res.resourceMatchCount).toBe(1);
    expect(res.resources[0].initiatorType).toBe("media");
    expect(res.resources[0].host).toBe("cdn3.astalavr.com");
    expect(res.resources[0].path).toBe("/qDAVn/720P.mp4");
    expect(res.resources[0].hasToken).toBe(true);
    expect(JSON.stringify(res)).not.toContain("SUPER_SECRET_PLAYBACK_TOKEN");
  });

  it("21. exact URL, query, and token match -> EXACT_CACHED_URL_MATCH=YES, QUERY_MATCH=YES, TOKEN_MATCH=YES", () => {
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
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=identical_token_123",
      },
    ];

    const mockPerf: any = {
      getEntriesByType: (type: string) => {
        if (type === "resource") {
          return [
            {
              name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=identical_token_123",
              initiatorType: "video",
              duration: 50,
            },
          ];
        }
        return [];
      },
    };

    const res = inspectPlaybackResources(doc as any, cachedRenditions as any, mockPerf);
    expect(res.resourceMatchCount).toBe(1);
    expect(res.resources[0].exactCachedUrlMatch).toBe("YES");
    expect(res.resources[0].queryMatch).toBe("YES");
    expect(res.resources[0].tokenMatch).toBe("YES");
    expect(res.resources[0].sameFullUrlAsPreviousMatch).toBe("N/A");
  });

  it("22. same token but different additional query parameter -> EXACT_CACHED_URL_MATCH=NO, QUERY_MATCH=NO, TOKEN_MATCH=YES", () => {
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
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=shared_token_777",
      },
    ];

    const mockPerf: any = {
      getEntriesByType: (type: string) => {
        if (type === "resource") {
          return [
            {
              name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=shared_token_777&extra=1",
              initiatorType: "video",
              duration: 50,
            },
          ];
        }
        return [];
      },
    };

    const res = inspectPlaybackResources(doc as any, cachedRenditions as any, mockPerf);
    expect(res.resourceMatchCount).toBe(1);
    expect(res.resources[0].exactCachedUrlMatch).toBe("NO");
    expect(res.resources[0].queryMatch).toBe("NO");
    expect(res.resources[0].tokenMatch).toBe("YES");
  });

  it("23. two resource entries for same rendition with different signed URLs -> second SAME_FULL_URL_AS_PREVIOUS_MATCH=NO", () => {
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
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token_A",
      },
    ];

    const mockPerf: any = {
      getEntriesByType: (type: string) => {
        if (type === "resource") {
          return [
            {
              name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token_A",
              initiatorType: "video",
              duration: 50,
            },
            {
              name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token_B",
              initiatorType: "video",
              duration: 60,
            },
          ];
        }
        return [];
      },
    };

    const res = inspectPlaybackResources(doc as any, cachedRenditions as any, mockPerf);
    expect(res.resourceMatchCount).toBe(2);
    expect(res.resources[0].exactCachedUrlMatch).toBe("YES");
    expect(res.resources[0].tokenMatch).toBe("YES");
    expect(res.resources[0].sameFullUrlAsPreviousMatch).toBe("N/A");

    expect(res.resources[1].exactCachedUrlMatch).toBe("NO");
    expect(res.resources[1].tokenMatch).toBe("NO");
    expect(res.resources[1].sameFullUrlAsPreviousMatch).toBe("NO");
  });

  it("24. testActualPlayback720p selects latest matching video entry and detects token difference from DOM", async () => {
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
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=dom_token_initial",
      },
    ];

    let createdVideoSrc = "";
    const mockVideo: any = {
      tagName: "VIDEO",
      preload: "",
      src: "",
      duration: 1234.56,
      addEventListener: () => {},
      removeEventListener: () => {},
      load: () => {
        setTimeout(() => {
          if (mockVideo.onloadedmetadata) mockVideo.onloadedmetadata();
        }, 30);
      },
      removeAttribute: () => {},
      remove: () => {},
    };

    const origCreateElement = doc.createElement.bind(doc);
    const spy = vi.spyOn(doc, "createElement").mockImplementation((tag: string) => {
      if (tag === "video") {
        return new Proxy(mockVideo, {
          set(target, prop, value) {
            if (prop === "src") createdVideoSrc = value;
            target[prop] = value;
            return true;
          },
        });
      }
      return origCreateElement(tag);
    });

    const mockPerf: any = {
      getEntriesByType: (type: string) => {
        if (type === "resource") {
          return [
            {
              name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=old_player_token_1",
              initiatorType: "video",
              duration: 50,
            },
            {
              name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=latest_active_player_token_2",
              initiatorType: "video",
              duration: 60,
            },
          ];
        }
        return [];
      },
    };

    const res = await testActualPlayback720p(cachedRenditions as any, mockPerf, doc as any, 1000);
    expect(res.actualPlaybackUrlFound).toBe(true);
    expect(res.pass).toBe(true);
    expect(res.duration).toBe(1234.56);
    expect(res.pathMatch).toBe(true);
    expect(res.tokenDiffersFromDom).toBe(true);
    expect(createdVideoSrc).toBe("https://cdn3.astalavr.com/qDAVn/720P.mp4?token=latest_active_player_token_2");

    spy.mockRestore();
  });

  it("25. testActualPlayback720p reports FAIL on video error without leaking URL or token", async () => {
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
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=dom_token",
      },
    ];

    const mockVideo: any = {
      tagName: "VIDEO",
      preload: "",
      src: "",
      error: { code: 4 },
      addEventListener: () => {},
      removeEventListener: () => {},
      load: () => {
        setTimeout(() => {
          if (mockVideo.onerror) mockVideo.onerror();
        }, 30);
      },
      removeAttribute: () => {},
      remove: () => {},
    };

    const origCreateElement = doc.createElement.bind(doc);
    const spy = vi.spyOn(doc, "createElement").mockImplementation((tag: string) => {
      if (tag === "video") return mockVideo;
      return origCreateElement(tag);
    });

    const mockPerf: any = {
      getEntriesByType: (type: string) => {
        if (type === "resource") {
          return [
            {
              name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=secret_player_token",
              initiatorType: "video",
              duration: 50,
            },
          ];
        }
        return [];
      },
    };

    const res = await testActualPlayback720p(cachedRenditions as any, mockPerf, doc as any, 1000);
    expect(res.actualPlaybackUrlFound).toBe(true);
    expect(res.pass).toBe(false);
    expect(res.errorCode).toBe(4);
    expect(res.pathMatch).toBe(true);
    expect(res.tokenDiffersFromDom).toBe(true);

    spy.mockRestore();
  });

  it("26. testActualPlayback720p returns ACTUAL_PLAYBACK_URL_FOUND=false when no matching resource exists", async () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const doc = window.document;

    const mockPerf: any = {
      getEntriesByType: () => [],
    };

    const res = await testActualPlayback720p([], mockPerf, doc as any, 1000);
    expect(res.actualPlaybackUrlFound).toBe(false);
  });

  it("27. clicking Test actual playback 720p URL renders safe result UI and freezes polling", async () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const originalWindow = (globalThis as any).window;
    const originalDocument = (globalThis as any).document;
    const originalPerformance = (globalThis as any).performance;
    (globalThis as any).window = window;
    (globalThis as any).document = window.document;

    const origNow = typeof originalPerformance?.now === "function" ? originalPerformance.now.bind(originalPerformance) : () => Date.now();
    (globalThis as any).performance = {
      now: origNow,
      getEntriesByType: (type: string) => {
        if (type === "resource") {
          return [
            {
              name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=SUPER_SECRET_PLAYBACK_TOKEN_123",
              initiatorType: "video",
              duration: 50,
            },
          ];
        }
        return [];
      },
    };

    const mockVideo: any = {
      tagName: "VIDEO",
      preload: "",
      src: "",
      duration: 555.55,
      addEventListener: () => {},
      removeEventListener: () => {},
      load: () => {
        setTimeout(() => {
          if (mockVideo.onloadedmetadata) mockVideo.onloadedmetadata();
        }, 30);
      },
      removeAttribute: () => {},
      remove: () => {},
    };

    const origCreateElement = window.document.createElement.bind(window.document);
    const spy = vi.spyOn(window.document, "createElement").mockImplementation((tag: string) => {
      if (tag === "video") return mockVideo;
      return origCreateElement(tag);
    });

    const res = await testActualPlayback720p(
      [
        {
          formatId: "720p-unknown",
          resolution: "720p",
          height: 720,
          vcodec: "unknown",
          mimeType: "unknown",
          mediaHostname: "cdn3.astalavr.com",
          fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=dom_token_abc",
        },
      ],
      (globalThis as any).performance as any,
      window.document
    );

    expect(res.actualPlaybackUrlFound).toBe(true);
    expect(res.pass).toBe(true);
    expect(res.duration).toBe(555.55);
    expect(res.pathMatch).toBe(true);
    expect(res.tokenDiffersFromDom).toBe(true);
    expect(JSON.stringify(res)).not.toContain("SUPER_SECRET_PLAYBACK_TOKEN_123");

    spy.mockRestore();
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
    (globalThis as any).performance = originalPerformance;
  });

  it("28. testActualPlayback720pRange selects latest actual playback URL and resolves PASS on HTTP 206 with 1 MiB body", async () => {
    const cachedRenditions = [
      {
        formatId: "720p-unknown",
        resolution: "720p",
        height: 720,
        vcodec: "unknown",
        mimeType: "unknown",
        mediaHostname: "cdn3.astalavr.com",
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=dom_token",
      },
    ];

    const mockPerf: any = {
      getEntriesByType: (type: string) => {
        if (type === "resource") {
          return [
            {
              name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=active_playback_token_123",
              initiatorType: "video",
            },
          ];
        }
        return [];
      },
    };

    let requestedUrl = "";
    let requestedHeaders: any = {};
    const oneMiBChunk = new Uint8Array(1048576);
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    let readCallCount = 0;

    const mockFetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      requestedUrl = url;
      requestedHeaders = init?.headers;
      return {
        status: 206,
        headers: new Map([
          ["Content-Range", "bytes 0-1048575/99999999"],
          ["Content-Length", "1048576"],
          ["Content-Type", "video/mp4"],
        ]),
        body: {
          getReader: () => {
            return {
              read: async () => {
                readCallCount++;
                if (readCallCount === 1) {
                  return { done: false, value: oneMiBChunk };
                }
                return { done: true, value: undefined };
              },
              cancel: cancelSpy,
              releaseLock: () => {},
            };
          },
        },
      };
    });

    const res = await testActualPlayback720pRange(cachedRenditions as any, mockPerf, mockFetch as any);
    expect(res.actualPlaybackUrlFound).toBe(true);
    expect(res.pass).toBe(true);
    expect(res.validationMode).toBe("CONTENT_RANGE");
    expect(res.httpStatus).toBe(206);
    expect(res.contentRangePresent).toBe(true);
    expect(res.contentRangeValid).toBe(true);
    expect(res.contentLengthPresent).toBe(true);
    expect(res.bytesRead).toBe(1048576);
    expect(res.maxBytesRead).toBe(1048576);
    expect(res.bodyRead).toBe("YES");
    expect(requestedUrl).toBe("https://cdn3.astalavr.com/qDAVn/720P.mp4?token=active_playback_token_123");
    expect(requestedHeaders?.Range).toBe("bytes=0-1048575");
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(readCallCount).toBe(1);
  });

  it("29. testActualPlayback720pRange fails on HTTP 200 with BODY_READ=NO and cancels stream", async () => {
    const cachedRenditions = [
      {
        formatId: "720p-unknown",
        resolution: "720p",
        height: 720,
        vcodec: "unknown",
        mimeType: "unknown",
        mediaHostname: "cdn3.astalavr.com",
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=dom_token",
      },
    ];

    const mockPerf: any = {
      getEntriesByType: () => [{ name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token1", initiatorType: "video" }],
    };

    let bodyCancelled = false;
    const mockFetch = vi.fn().mockImplementation(async () => ({
      status: 200,
      headers: new Map(),
      body: {
        cancel: async () => {
          bodyCancelled = true;
        },
      },
    }));

    const res = await testActualPlayback720pRange(cachedRenditions as any, mockPerf, mockFetch as any);
    expect(res.actualPlaybackUrlFound).toBe(true);
    expect(res.pass).toBe(false);
    expect(res.httpStatus).toBe(200);
    expect(res.bodyRead).toBe("NO");
    expect(res.bytesRead).toBe(0);
    expect(res.failureKind).toBe("STATUS_NOT_206");
    expect(bodyCancelled).toBe(true);
  });

  it("30. testActualPlayback720pRange fails on HTTP 403 with BODY_READ=NO", async () => {
    const cachedRenditions = [
      {
        formatId: "720p-unknown",
        resolution: "720p",
        height: 720,
        vcodec: "unknown",
        mimeType: "unknown",
        mediaHostname: "cdn3.astalavr.com",
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=dom_token",
      },
    ];

    const mockPerf: any = {
      getEntriesByType: () => [{ name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token1", initiatorType: "video" }],
    };

    const mockFetch = vi.fn().mockImplementation(async () => ({
      status: 403,
      headers: new Map(),
      body: null,
    }));

    const res = await testActualPlayback720pRange(cachedRenditions as any, mockPerf, mockFetch as any);
    expect(res.actualPlaybackUrlFound).toBe(true);
    expect(res.pass).toBe(false);
    expect(res.httpStatus).toBe(403);
    expect(res.bodyRead).toBe("NO");
    expect(res.bytesRead).toBe(0);
    expect(res.failureKind).toBe("STATUS_NOT_206");
  });

  it("31. testActualPlayback720pRange handles fetch rejection safely as FETCH_ERROR without leaking URL/token", async () => {
    const cachedRenditions = [
      {
        formatId: "720p-unknown",
        resolution: "720p",
        height: 720,
        vcodec: "unknown",
        mimeType: "unknown",
        mediaHostname: "cdn3.astalavr.com",
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=dom_token",
      },
    ];

    const mockPerf: any = {
      getEntriesByType: () => [{ name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=secret_token", initiatorType: "video" }],
    };

    const mockFetch = vi.fn().mockImplementation(async () => {
      const err = new TypeError("Failed to fetch https://cdn3.astalavr.com/qDAVn/720P.mp4?token=secret_token");
      err.name = "TypeError";
      throw err;
    });

    const res = await testActualPlayback720pRange(cachedRenditions as any, mockPerf, mockFetch as any);
    expect(res.actualPlaybackUrlFound).toBe(true);
    expect(res.pass).toBe(false);
    expect(res.failureKind).toBe("FETCH_ERROR");
    expect(res.errorName).toBe("TypeError");
  });

  it("32. testActualPlayback720pRange stream read cannot exceed 1 MiB cap", async () => {
    const cachedRenditions = [
      {
        formatId: "720p-unknown",
        resolution: "720p",
        height: 720,
        vcodec: "unknown",
        mimeType: "unknown",
        mediaHostname: "cdn3.astalavr.com",
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=dom_token",
      },
    ];

    const mockPerf: any = {
      getEntriesByType: () => [{ name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token1", initiatorType: "video" }],
    };

    let cancelled = false;
    const oversizedChunk = new Uint8Array(2000000); // 2 MB
    const mockFetch = vi.fn().mockImplementation(async () => ({
      status: 206,
      headers: new Map([
        ["Content-Range", "bytes 0-1048575/99999999"],
      ]),
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: oversizedChunk }),
          cancel: async () => {
            cancelled = true;
          },
          releaseLock: () => {},
        }),
      },
    }));

    const res = await testActualPlayback720pRange(cachedRenditions as any, mockPerf, mockFetch as any);
    expect(res.pass).toBe(true);
    expect(res.bytesRead).toBe(1048576);
    expect(cancelled).toBe(true);
  });

  it("33. clicking Test actual 720p Range renders safe UI without leaking full URL/token", async () => {
    const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
    const originalWindow = (globalThis as any).window;
    const originalDocument = (globalThis as any).document;
    const originalPerformance = (globalThis as any).performance;
    const originalFetch = (globalThis as any).fetch;
    (globalThis as any).window = window;
    (globalThis as any).document = window.document;

    const origNow = typeof originalPerformance?.now === "function" ? originalPerformance.now.bind(originalPerformance) : () => Date.now();
    (globalThis as any).performance = {
      now: origNow,
      getEntriesByType: (type: string) => {
        if (type === "resource") {
          return [
            {
              name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=RANGE_SECRET_TOKEN_999",
              initiatorType: "video",
            },
          ];
        }
        return [];
      },
    };

    (globalThis as any).fetch = vi.fn().mockImplementation(async () => ({
      status: 206,
      headers: {
        get: (h: string) => {
          if (h === "Content-Range") return "bytes 0-1048575/50000000";
          if (h === "Content-Length") return "1048576";
          if (h === "Content-Type") return "video/mp4";
          return null;
        },
      },
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: async () => {
              if (!sent) {
                sent = true;
                return { done: false, value: new Uint8Array(1048576) };
              }
              return { done: true, value: undefined };
            },
            cancel: async () => {},
            releaseLock: () => {},
          };
        },
      },
    }));

    const res = await testActualPlayback720pRange(
      [
        {
          formatId: "720p-unknown",
          resolution: "720p",
          height: 720,
          vcodec: "unknown",
          mimeType: "unknown",
          mediaHostname: "cdn3.astalavr.com",
          fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=dom_token_123",
        },
      ],
      (globalThis as any).performance as any,
      (globalThis as any).fetch
    );

    expect(res.actualPlaybackUrlFound).toBe(true);
    expect(res.pass).toBe(true);
    expect(res.httpStatus).toBe(206);
    expect(res.contentRangePresent).toBe(true);
    expect(res.contentLength).toBe("1048576");
    expect(res.contentType).toBe("video/mp4");
    expect(res.bytesRead).toBe(1048576);
    expect(res.maxBytesRead).toBe(1048576);
    expect(JSON.stringify(res)).not.toContain("RANGE_SECRET_TOKEN_999");

    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
    (globalThis as any).performance = originalPerformance;
    (globalThis as any).fetch = originalFetch;
  });

  it("34. testActualPlayback720pRange fails closed with STREAM_UNAVAILABLE without calling arrayBuffer when response.body is null", async () => {
    const cachedRenditions = [
      {
        formatId: "720p-unknown",
        resolution: "720p",
        height: 720,
        vcodec: "unknown",
        mimeType: "unknown",
        mediaHostname: "cdn3.astalavr.com",
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=dom_token",
      },
    ];

    const mockPerf: any = {
      getEntriesByType: () => [{ name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token1", initiatorType: "video" }],
    };

    const arrayBufferSpy = vi.fn().mockResolvedValue(new ArrayBuffer(1048576));
    const mockFetch = vi.fn().mockImplementation(async () => ({
      status: 206,
      headers: new Map([
        ["Content-Range", "bytes 0-1048575/99999999"],
      ]),
      body: null,
      arrayBuffer: arrayBufferSpy,
    }));

    const res = await testActualPlayback720pRange(cachedRenditions as any, mockPerf, mockFetch as any);
    expect(res.actualPlaybackUrlFound).toBe(true);
    expect(res.pass).toBe(false);
    expect(res.httpStatus).toBe(206);
    expect(res.failureKind).toBe("STREAM_UNAVAILABLE");
    expect(res.bodyRead).toBe("NO");
    expect(res.bytesRead).toBe(0);
    expect(arrayBufferSpy).toHaveBeenCalledTimes(0);
  });

  it("35. testActualPlayback720pRange resolves PASS with CONTENT_LENGTH_FALLBACK when Content-Range is hidden by CORS", async () => {
    const cachedRenditions = [
      {
        formatId: "720p-unknown",
        resolution: "720p",
        height: 720,
        vcodec: "unknown",
        mimeType: "unknown",
        mediaHostname: "cdn3.astalavr.com",
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=dom_token",
      },
    ];

    const mockPerf: any = {
      getEntriesByType: () => [{ name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token1", initiatorType: "video" }],
    };

    const oneMiBChunk = new Uint8Array(1048576);
    const mockFetch = vi.fn().mockImplementation(async () => ({
      status: 206,
      headers: new Map([
        // Content-Range is hidden by CORS
        ["Content-Length", "1048576"],
        ["Content-Type", "video/mp4"],
      ]),
      body: {
        getReader: () => {
          let delivered = false;
          return {
            read: async () => {
              if (!delivered) {
                delivered = true;
                return { done: false, value: oneMiBChunk };
              }
              return { done: true, value: undefined };
            },
            cancel: async () => {},
            releaseLock: () => {},
          };
        },
      },
    }));

    const res = await testActualPlayback720pRange(cachedRenditions as any, mockPerf, mockFetch as any);
    expect(res.actualPlaybackUrlFound).toBe(true);
    expect(res.pass).toBe(true);
    expect(res.validationMode).toBe("CONTENT_LENGTH_FALLBACK");
    expect(res.contentRangePresent).toBe(false);
    expect(res.contentLengthPresent).toBe(true);
    expect(res.contentLength).toBe("1048576");
    expect(res.bytesRead).toBe(1048576);
  });

  it("36. testActualPlayback720pRange fails when Content-Range is hidden and Content-Length is missing", async () => {
    const cachedRenditions = [
      {
        formatId: "720p-unknown",
        resolution: "720p",
        height: 720,
        vcodec: "unknown",
        mimeType: "unknown",
        mediaHostname: "cdn3.astalavr.com",
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=dom_token",
      },
    ];

    const mockPerf: any = {
      getEntriesByType: () => [{ name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token1", initiatorType: "video" }],
    };

    const oneMiBChunk = new Uint8Array(1048576);
    const mockFetch = vi.fn().mockImplementation(async () => ({
      status: 206,
      headers: new Map([
        // Both Content-Range and Content-Length are missing/hidden
        ["Content-Type", "video/mp4"],
      ]),
      body: {
        getReader: () => {
          let delivered = false;
          return {
            read: async () => {
              if (!delivered) {
                delivered = true;
                return { done: false, value: oneMiBChunk };
              }
              return { done: true, value: undefined };
            },
            cancel: async () => {},
            releaseLock: () => {},
          };
        },
      },
    }));

    const res = await testActualPlayback720pRange(cachedRenditions as any, mockPerf, mockFetch as any);
    expect(res.actualPlaybackUrlFound).toBe(true);
    expect(res.pass).toBe(false);
    expect(res.failureKind).toBe("CONTENT_LENGTH_MISSING_OR_INVALID");
    expect(res.contentRangePresent).toBe(false);
    expect(res.contentLengthPresent).toBe(false);
  });

  it("37. testActualPlayback720pRange fails when Content-Range is hidden and Content-Length != 1048576", async () => {
    const cachedRenditions = [
      {
        formatId: "720p-unknown",
        resolution: "720p",
        height: 720,
        vcodec: "unknown",
        mimeType: "unknown",
        mediaHostname: "cdn3.astalavr.com",
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=dom_token",
      },
    ];

    const mockPerf: any = {
      getEntriesByType: () => [{ name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token1", initiatorType: "video" }],
    };

    const oneMiBChunk = new Uint8Array(1048576);
    const mockFetch = vi.fn().mockImplementation(async () => ({
      status: 206,
      headers: new Map([
        ["Content-Length", "50000000"], // Wrong Content-Length (full file size instead of 1 MiB)
        ["Content-Type", "video/mp4"],
      ]),
      body: {
        getReader: () => {
          let delivered = false;
          return {
            read: async () => {
              if (!delivered) {
                delivered = true;
                return { done: false, value: oneMiBChunk };
              }
              return { done: true, value: undefined };
            },
            cancel: async () => {},
            releaseLock: () => {},
          };
        },
      },
    }));

    const res = await testActualPlayback720pRange(cachedRenditions as any, mockPerf, mockFetch as any);
    expect(res.actualPlaybackUrlFound).toBe(true);
    expect(res.pass).toBe(false);
    expect(res.failureKind).toBe("CONTENT_LENGTH_MISSING_OR_INVALID");
    expect(res.contentRangePresent).toBe(false);
    expect(res.contentLengthPresent).toBe(true);
  });

  it("38. testActualPlayback720pRange fails closed when Content-Range is visible but invalid (must NOT use Content-Length fallback)", async () => {
    const cachedRenditions = [
      {
        formatId: "720p-unknown",
        resolution: "720p",
        height: 720,
        vcodec: "unknown",
        mimeType: "unknown",
        mediaHostname: "cdn3.astalavr.com",
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=dom_token",
      },
    ];

    const mockPerf: any = {
      getEntriesByType: () => [{ name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token1", initiatorType: "video" }],
    };

    const oneMiBChunk = new Uint8Array(1048576);
    const mockFetch = vi.fn().mockImplementation(async () => ({
      status: 206,
      headers: new Map([
        ["Content-Range", "bytes 500-1000/99999999"], // Invalid requested range
        ["Content-Length", "1048576"], // Content-Length matches but must NOT be used because Content-Range is visible and invalid
        ["Content-Type", "video/mp4"],
      ]),
      body: {
        getReader: () => {
          let delivered = false;
          return {
            read: async () => {
              if (!delivered) {
                delivered = true;
                return { done: false, value: oneMiBChunk };
              }
              return { done: true, value: undefined };
            },
            cancel: async () => {},
            releaseLock: () => {},
          };
        },
      },
    }));

    const res = await testActualPlayback720pRange(cachedRenditions as any, mockPerf, mockFetch as any);
    expect(res.actualPlaybackUrlFound).toBe(true);
    expect(res.pass).toBe(false);
    expect(res.failureKind).toBe("INVALID_CONTENT_RANGE");
    expect(res.contentRangePresent).toBe(true);
    expect(res.contentRangeValid).toBe(false);
  });

  describe("GM_xmlhttpRequest Privileged 0-0 Range Probe", () => {
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
    ];

    const mockPerf = {
      getEntriesByType: (type: string) => {
        if (type === "resource") {
          return [
            {
              name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=actual_token_456",
              initiatorType: "video",
              duration: 25,
            },
          ];
        }
        return [];
      },
    };

    it("A. 206 + valid Content-Range bytes 0-0/<total> => PASS immediately at readyState 2, abort called exactly once, onload not required", async () => {
      let requestedHeaders: Record<string, string> | undefined;
      const abortFn = vi.fn();

      const mockGm = vi.fn((details: any) => {
        requestedHeaders = details.headers;
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: "Content-Type: video/mp4\r\nContent-Range: bytes 0-0/104857600\r\nContent-Length: 1",
            });
          }
        }, 10);
        return { abort: abortFn };
      });

      const res = await testActualPlaybackGmRange(cachedRenditions as any, mockPerf as any, mockGm as any);
      expect(mockGm).toHaveBeenCalledTimes(1);
      expect(requestedHeaders).toEqual({ Range: "bytes=0-0" });
      expect(abortFn).toHaveBeenCalledTimes(1);
      expect(res.actualPlaybackUrlFound).toBe(true);
      expect(res.pass).toBe(true);
      expect(res.httpStatus).toBe(206);
      expect(res.contentRangePresent).toBe(true);
      expect(res.contentRangeValid).toBe(true);
      expect(res.totalFileSizeParsed).toBe(true);
      expect(res.requestAborted).toBe(true);
    });

    it("B. even if a mock later attempts to call onload with a huge body, result stays PASS from header validation and body is never inspected", async () => {
      const abortFn = vi.fn();
      let onloadRan = false;

      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: "Content-Type: video/mp4\r\nContent-Range: bytes 0-0/104857600\r\nContent-Length: 1",
            });
          }
          if (details.onload) {
            onloadRan = true;
            details.onload({
              status: 206,
              responseHeaders: "Content-Type: video/mp4\r\nContent-Range: bytes 0-0/104857600",
              response: new ArrayBuffer(5242880), // 5 MiB unexpected body
            });
          }
        }, 10);
        return { abort: abortFn };
      });

      const res = await testActualPlaybackGmRange(cachedRenditions as any, mockPerf as any, mockGm as any);
      expect(abortFn).toHaveBeenCalledTimes(1);
      expect(res.pass).toBe(true);
      expect(res.httpStatus).toBe(206);
      expect(res.contentRangeValid).toBe(true);
      expect(res.totalFileSizeParsed).toBe(true);
      expect(res.requestAborted).toBe(true);
    });

    it("C. HTTP 200 observed at header state => abort exactly once, STATUS_NOT_206", async () => {
      const abortFn = vi.fn();

      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 200,
              responseHeaders: "Content-Type: video/mp4\r\nContent-Length: 104857600",
            });
          }
        }, 10);
        return { abort: abortFn };
      });

      const res = await testActualPlaybackGmRange(cachedRenditions as any, mockPerf as any, mockGm as any);
      expect(mockGm).toHaveBeenCalledTimes(1);
      expect(abortFn).toHaveBeenCalledTimes(1);
      expect(res.actualPlaybackUrlFound).toBe(true);
      expect(res.pass).toBe(false);
      expect(res.httpStatus).toBe(200);
      expect(res.requestAborted).toBe(true);
      expect(res.failureKind).toBe("STATUS_NOT_206");
    });

    it("D. HTTP 403 => abort exactly once, STATUS_NOT_206", async () => {
      const abortFn = vi.fn();

      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 403,
              responseHeaders: "Content-Type: text/html",
            });
          }
        }, 10);
        return { abort: abortFn };
      });

      const res = await testActualPlaybackGmRange(cachedRenditions as any, mockPerf as any, mockGm as any);
      expect(abortFn).toHaveBeenCalledTimes(1);
      expect(res.actualPlaybackUrlFound).toBe(true);
      expect(res.pass).toBe(false);
      expect(res.httpStatus).toBe(403);
      expect(res.requestAborted).toBe(true);
      expect(res.failureKind).toBe("STATUS_NOT_206");
    });

    it("E. 206 but Content-Range missing => abort immediately, CONTENT_RANGE_MISSING", async () => {
      const abortFn = vi.fn();

      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: "Content-Type: video/mp4\r\nContent-Length: 1",
            });
          }
        }, 10);
        return { abort: abortFn };
      });

      const res = await testActualPlaybackGmRange(cachedRenditions as any, mockPerf as any, mockGm as any);
      expect(abortFn).toHaveBeenCalledTimes(1);
      expect(res.actualPlaybackUrlFound).toBe(true);
      expect(res.pass).toBe(false);
      expect(res.httpStatus).toBe(206);
      expect(res.contentRangePresent).toBe(false);
      expect(res.requestAborted).toBe(true);
      expect(res.failureKind).toBe("CONTENT_RANGE_MISSING");
    });

    it("F. 206 but malformed/wrong range (e.g. bytes 1-1/1000) => abort immediately, CONTENT_RANGE_INVALID", async () => {
      const abortFn = vi.fn();

      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: "Content-Type: video/mp4\r\nContent-Range: bytes 1-1/104857600",
            });
          }
        }, 10);
        return { abort: abortFn };
      });

      const res = await testActualPlaybackGmRange(cachedRenditions as any, mockPerf as any, mockGm as any);
      expect(abortFn).toHaveBeenCalledTimes(1);
      expect(res.actualPlaybackUrlFound).toBe(true);
      expect(res.pass).toBe(false);
      expect(res.httpStatus).toBe(206);
      expect(res.contentRangePresent).toBe(true);
      expect(res.contentRangeValid).toBe(false);
      expect(res.totalFileSizeParsed).toBe(false);
      expect(res.requestAborted).toBe(true);
      expect(res.failureKind).toBe("CONTENT_RANGE_INVALID");
    });

    it("G. timeout/error => safe failure enum, abort called exactly once, without leaking URL or token", async () => {
      const abortErrorFn = vi.fn();
      const mockGmError = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onerror) {
            details.onerror(new Error("Network Error: https://cdn3.astalavr.com/secret_url?token=leaked"));
          }
        }, 10);
        return { abort: abortErrorFn };
      });

      const resError = await testActualPlaybackGmRange(cachedRenditions as any, mockPerf as any, mockGmError as any);
      expect(abortErrorFn).toHaveBeenCalledTimes(1);
      expect(resError.actualPlaybackUrlFound).toBe(true);
      expect(resError.pass).toBe(false);
      expect(resError.failureKind).toBe("GM_REQUEST_ERROR");
      expect(resError.requestAborted).toBe(true);
      expect(JSON.stringify(resError)).not.toContain("secret_url");
      expect(JSON.stringify(resError)).not.toContain("token=");

      const abortTimeoutFn = vi.fn();
      const mockGmTimeout = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.ontimeout) {
            details.ontimeout();
          }
        }, 10);
        return { abort: abortTimeoutFn };
      });

      const resTimeout = await testActualPlaybackGmRange(cachedRenditions as any, mockPerf as any, mockGmTimeout as any);
      expect(abortTimeoutFn).toHaveBeenCalledTimes(1);
      expect(resTimeout.actualPlaybackUrlFound).toBe(true);
      expect(resTimeout.pass).toBe(false);
      expect(resTimeout.failureKind).toBe("GM_REQUEST_TIMEOUT");
      expect(resTimeout.requestAborted).toBe(true);
    });

    it("H. testActualPlaybackGmRange parses total file size and returns safe output without leaking URL/token", async () => {
      const mockPerf = {
        getEntriesByType: (type: string) => {
          if (type === "resource") {
            return [
              {
                name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=ULTRA_SECRET_TOKEN_GM",
                initiatorType: "video",
                duration: 50,
              },
            ];
          }
          return [];
        },
      };

      const mockGm = (details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: "Content-Type: video/mp4\r\nContent-Range: bytes 0-0/524288000\r\nContent-Length: 1",
            });
          }
        }, 20);
        return { abort: () => {} };
      };

      const res = await testActualPlaybackGmRange(
        [
          {
            formatId: "720p-unknown",
            resolution: "720p",
            height: 720,
            vcodec: "unknown",
            mimeType: "unknown",
            mediaHostname: "cdn3.astalavr.com",
            fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=token1",
          },
        ],
        mockPerf as any,
        mockGm as any
      );

      expect(res.actualPlaybackUrlFound).toBe(true);
      expect(res.pass).toBe(true);
      expect(res.httpStatus).toBe(206);
      expect(res.contentRangePresent).toBe(true);
      expect(res.contentRangeValid).toBe(true);
      expect(res.totalFileSizeParsed).toBe(true);
      expect(res.requestAborted).toBe(true);

      // Verify strict confidentiality
      expect(JSON.stringify(res)).not.toContain("ULTRA_SECRET_TOKEN_GM");
    });

    it("I. userscript build header metadata has @grant GM_xmlhttpRequest and exact @connect cdn3.astalavr.com only", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const buildScriptContent = fs.readFileSync(path.resolve("companion/build.mjs"), "utf-8");

      expect(buildScriptContent).toContain("@grant        GM_xmlhttpRequest");
      expect(buildScriptContent).toContain("@connect      cdn3.astalavr.com");
      expect(buildScriptContent).not.toContain("@connect      *");
    });
  });

  describe("Paired 1MiB Range Test (GM Metadata Plane + Page Data Plane)", () => {
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
    ];

    const actualPlaybackUrl = "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=actual_token_456";

    const mockPerf = {
      getEntriesByType: (type: string) => {
        if (type === "resource") {
          return [
            {
              name: actualPlaybackUrl,
              initiatorType: "video",
              duration: 25,
            },
          ];
        }
        return [];
      },
    };

    const oneMiBChunk = new Uint8Array(1048576);

    it("1. GM metadata PASS then page 1MiB PASS => PAIR PASS", async () => {
      let gmUrl = "";
      let gmHeaders: any;
      let pageUrl = "";
      let pageHeaders: any;

      const mockGm = vi.fn((details: any) => {
        gmUrl = details.url;
        gmHeaders = details.headers;
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: "Content-Type: video/mp4\r\nContent-Range: bytes 0-1048575/52428800\r\nContent-Length: 1048576",
            });
          }
        }, 10);
        return { abort: vi.fn() };
      });

      const mockPageFetch = vi.fn(async (url: string, opts: any) => {
        pageUrl = url;
        pageHeaders = opts.headers;
        return {
          status: 206,
          headers: new Map([
            ["Content-Length", "1048576"],
            ["Content-Type", "video/mp4"],
          ]),
          body: {
            getReader: () => {
              let delivered = false;
              return {
                read: async () => {
                  if (!delivered) {
                    delivered = true;
                    return { done: false, value: oneMiBChunk };
                  }
                  return { done: true, value: undefined };
                },
                cancel: async () => {},
                releaseLock: () => {},
              };
            },
          },
        };
      });

      const res = await testActualPlaybackPaired1MiB(
        cachedRenditions as any,
        mockPerf as any,
        mockGm as any,
        mockPageFetch as any
      );

      expect(res.actualPlaybackUrlFound).toBe(true);
      expect(res.pass).toBe(true);
      expect(res.gmMetadataStatus).toBe(206);
      expect(res.gmContentRangePresent).toBe(true);
      expect(res.gmContentRangeMatch).toBe(true);
      expect(res.gmTotalFileSizeParsed).toBe(true);
      expect(res.gmAbortedAtHeaders).toBe(true);
      expect(res.pageDataStatus).toBe(206);
      expect(res.pageContentLengthPresent).toBe(true);
      expect(res.pageContentLengthMatch).toBe(true);
      expect(res.pageBytesRead).toBe(1048576);
      expect(res.pageMaxBytesRead).toBe(1048576);

      // Invariant: exact same URL and range
      expect(gmUrl).toBe(actualPlaybackUrl);
      expect(pageUrl).toBe(actualPlaybackUrl);
      expect(gmHeaders).toEqual({ Range: "bytes=0-1048575" });
      expect(pageHeaders).toEqual({ Range: "bytes=0-1048575" });
    });

    it("2. GM status 200 => GM abort, page fetch call count 0", async () => {
      const mockPageFetch = vi.fn();
      const abortFn = vi.fn();

      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 200,
              responseHeaders: "Content-Type: video/mp4\r\nContent-Length: 52428800",
            });
          }
        }, 10);
        return { abort: abortFn };
      });

      const res = await testActualPlaybackPaired1MiB(
        cachedRenditions as any,
        mockPerf as any,
        mockGm as any,
        mockPageFetch as any
      );

      expect(res.pass).toBe(false);
      expect(res.pairFailureKind).toBe("GM_METADATA_FAILED");
      expect(res.gmMetadataStatus).toBe(200);
      expect(res.gmAbortedAtHeaders).toBe(true);
      expect(abortFn).toHaveBeenCalledTimes(1);
      expect(mockPageFetch).toHaveBeenCalledTimes(0);
    });

    it("2b. paired GM error => abort called exactly once, pairFailureKind=GM_METADATA_FAILED, page fetch call count 0", async () => {
      const mockPageFetch = vi.fn();
      const abortFn = vi.fn();

      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onerror) {
            details.onerror(new Error("Network Error"));
          }
        }, 10);
        return { abort: abortFn };
      });

      const res = await testActualPlaybackPaired1MiB(
        cachedRenditions as any,
        mockPerf as any,
        mockGm as any,
        mockPageFetch as any
      );

      expect(res.pass).toBe(false);
      expect(res.pairFailureKind).toBe("GM_METADATA_FAILED");
      expect(res.gmAbortedAtHeaders).toBe(true);
      expect(abortFn).toHaveBeenCalledTimes(1);
      expect(mockPageFetch).toHaveBeenCalledTimes(0);
    });

    it("2c. paired GM timeout => abort called exactly once, pairFailureKind=GM_METADATA_FAILED, page fetch call count 0", async () => {
      const mockPageFetch = vi.fn();
      const abortFn = vi.fn();

      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.ontimeout) {
            details.ontimeout();
          }
        }, 10);
        return { abort: abortFn };
      });

      const res = await testActualPlaybackPaired1MiB(
        cachedRenditions as any,
        mockPerf as any,
        mockGm as any,
        mockPageFetch as any
      );

      expect(res.pass).toBe(false);
      expect(res.pairFailureKind).toBe("GM_METADATA_FAILED");
      expect(res.gmAbortedAtHeaders).toBe(true);
      expect(abortFn).toHaveBeenCalledTimes(1);
      expect(mockPageFetch).toHaveBeenCalledTimes(0);
    });

    it("3. GM Content-Range mismatch => abort, page fetch call count 0", async () => {
      const mockPageFetch = vi.fn();
      const abortFn = vi.fn();

      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: "Content-Type: video/mp4\r\nContent-Range: bytes 0-500/52428800", // Wrong range
            });
          }
        }, 10);
        return { abort: abortFn };
      });

      const res = await testActualPlaybackPaired1MiB(
        cachedRenditions as any,
        mockPerf as any,
        mockGm as any,
        mockPageFetch as any
      );

      expect(res.pass).toBe(false);
      expect(res.pairFailureKind).toBe("GM_METADATA_FAILED");
      expect(res.gmContentRangeMatch).toBe(false);
      expect(abortFn).toHaveBeenCalledTimes(1);
      expect(mockPageFetch).toHaveBeenCalledTimes(0);
    });

    it("4. page status 200 => fail closed and cancel body", async () => {
      const cancelFn = vi.fn();
      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: "Content-Type: video/mp4\r\nContent-Range: bytes 0-1048575/52428800",
            });
          }
        }, 10);
        return { abort: vi.fn() };
      });

      const mockPageFetch = vi.fn(async () => ({
        status: 200,
        headers: new Map([["Content-Length", "52428800"]]),
        body: {
          cancel: cancelFn,
        },
      }));

      const res = await testActualPlaybackPaired1MiB(
        cachedRenditions as any,
        mockPerf as any,
        mockGm as any,
        mockPageFetch as any
      );

      expect(res.pass).toBe(false);
      expect(res.pairFailureKind).toBe("PAGE_STATUS_NOT_206");
      expect(res.pageDataStatus).toBe(200);
      expect(cancelFn).toHaveBeenCalledTimes(1);
    });

    it("5. page Content-Length missing/wrong => fail", async () => {
      const cancelFn = vi.fn();
      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: "Content-Type: video/mp4\r\nContent-Range: bytes 0-1048575/52428800",
            });
          }
        }, 10);
        return { abort: vi.fn() };
      });

      const mockPageFetch = vi.fn(async () => ({
        status: 206,
        headers: new Map([["Content-Length", "500000"]]), // Wrong length
        body: {
          cancel: cancelFn,
        },
      }));

      const res = await testActualPlaybackPaired1MiB(
        cachedRenditions as any,
        mockPerf as any,
        mockGm as any,
        mockPageFetch as any
      );

      expect(res.pass).toBe(false);
      expect(res.pairFailureKind).toBe("PAGE_CONTENT_LENGTH_MISMATCH");
      expect(res.pageContentLengthMatch).toBe(false);
      expect(cancelFn).toHaveBeenCalledTimes(1);
    });

    it("6. page exact 1MiB body => cancel exactly at boundary", async () => {
      const cancelFn = vi.fn();
      const twoMiBChunk = new Uint8Array(2097152); // larger chunk to test hard cancel

      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: "Content-Type: video/mp4\r\nContent-Range: bytes 0-1048575/52428800",
            });
          }
        }, 10);
        return { abort: vi.fn() };
      });

      const mockPageFetch = vi.fn(async () => ({
        status: 206,
        headers: new Map([["Content-Length", "1048576"]]),
        body: {
          getReader: () => {
            let delivered = false;
            return {
              read: async () => {
                if (!delivered) {
                  delivered = true;
                  return { done: false, value: twoMiBChunk };
                }
                return { done: true, value: undefined };
              },
              cancel: cancelFn,
              releaseLock: () => {},
            };
          },
        },
      }));

      const res = await testActualPlaybackPaired1MiB(
        cachedRenditions as any,
        mockPerf as any,
        mockGm as any,
        mockPageFetch as any
      );

      expect(res.pass).toBe(true);
      expect(res.pageBytesRead).toBe(1048576);
      expect(cancelFn).toHaveBeenCalledTimes(1);
    });

    it("7. URL passed to GM and page fetch is internally the exact same string, but result/UI never exposes it", async () => {
      const sensitiveToken = "SUPER_SECRET_TOKEN_PAIRED_12345";
      const sensitiveUrl = `https://cdn3.astalavr.com/qDAVn/720P.mp4?token=${sensitiveToken}`;

      const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
      const originalWindow = (globalThis as any).window;
      const originalDocument = (globalThis as any).document;
      const originalPerformance = (globalThis as any).performance;
      const originalGm = (globalThis as any).GM_xmlhttpRequest;
      const originalFetch = (globalThis as any).fetch;

      (globalThis as any).window = window;
      (globalThis as any).document = window.document;

      (globalThis as any).performance = {
        now: () => Date.now(),
        getEntriesByType: (type: string) => {
          if (type === "resource") {
            return [
              {
                name: sensitiveUrl,
                initiatorType: "video",
                duration: 50,
              },
            ];
          }
          return [];
        },
      };

      let observedGmUrl = "";
      let observedPageUrl = "";

      (globalThis as any).GM_xmlhttpRequest = (details: any) => {
        observedGmUrl = details.url;
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: "Content-Type: video/mp4\r\nContent-Range: bytes 0-1048575/52428800\r\nContent-Length: 1048576",
            });
          }
        }, 10);
        return { abort: () => {} };
      };

      (globalThis as any).fetch = async (url: string) => {
        observedPageUrl = url;
        return {
          status: 206,
          headers: new Map([["Content-Length", "1048576"]]),
          body: {
            getReader: () => {
              let delivered = false;
              return {
                read: async () => {
                  if (!delivered) {
                    delivered = true;
                    return { done: false, value: oneMiBChunk };
                  }
                  return { done: true, value: undefined };
                },
                cancel: async () => {},
                releaseLock: () => {},
              };
            },
          },
        };
      };

      window.document.body.innerHTML = `
        <dl8-video title="TMAVR285">
          <source quality="720p" src="https://cdn3.astalavr.com/qDAVn/720P.mp4?token=dom_token" />
        </dl8-video>
      `;

      const app = new AstalaVrProbeApp();
      app.init();

      const testPairBtn = window.document.getElementById("astalavr-test-pair-range-btn") as HTMLButtonElement;
      expect(testPairBtn).not.toBeNull();

      testPairBtn.click();

      await new Promise((r) => setTimeout(r, 60));

      const resultEl = window.document.getElementById("astalavr-test-pair-range-result")!;
      expect(resultEl.style.display).toBe("block");
      expect(resultEl.innerHTML).toContain("PAIR_ACTUAL_PLAYBACK_URL_FOUND=</strong>YES");
      expect(resultEl.innerHTML).toContain("PAIR_RANGE_TEST=</strong>PASS");

      // Verify internally same URL used
      expect(observedGmUrl).toBe(sensitiveUrl);
      expect(observedPageUrl).toBe(sensitiveUrl);

      // Verify strict confidentiality in output
      expect(resultEl.innerHTML).not.toContain(sensitiveToken);
      expect(resultEl.innerHTML).not.toContain("token=");
      expect(resultEl.innerHTML).not.toContain("52428800"); // Total file size not printed

      app.destroy();
      (globalThis as any).window = originalWindow;
      (globalThis as any).document = originalDocument;
      (globalThis as any).performance = originalPerformance;
      (globalThis as any).GM_xmlhttpRequest = originalGm;
      (globalThis as any).fetch = originalFetch;
    });

    it("8. both requests use exactly Range: bytes=0-1048575", async () => {
      let gmRange = "";
      let pageRange = "";

      const mockGm = vi.fn((details: any) => {
        gmRange = details.headers?.Range;
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: "Content-Type: video/mp4\r\nContent-Range: bytes 0-1048575/52428800",
            });
          }
        }, 10);
        return { abort: vi.fn() };
      });

      const mockPageFetch = vi.fn(async (_url: string, opts: any) => {
        pageRange = opts.headers?.Range;
        return {
          status: 206,
          headers: new Map([["Content-Length", "1048576"]]),
          body: {
            getReader: () => {
              let delivered = false;
              return {
                read: async () => {
                  if (!delivered) {
                    delivered = true;
                    return { done: false, value: oneMiBChunk };
                  }
                  return { done: true, value: undefined };
                },
                cancel: async () => {},
                releaseLock: () => {},
              };
            },
          },
        };
      });

      await testActualPlaybackPaired1MiB(
        cachedRenditions as any,
        mockPerf as any,
        mockGm as any,
        mockPageFetch as any
      );

      expect(gmRange).toBe("bytes=0-1048575");
      expect(pageRange).toBe("bytes=0-1048575");
    });

    it("9. actual playback detected initially renders UNTESTED for control metadata & range data, paired PASS updates to VERIFIED", async () => {
      const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
      const originalWindow = (globalThis as any).window;
      const originalDocument = (globalThis as any).document;
      const originalPerformance = (globalThis as any).performance;
      const originalGm = (globalThis as any).GM_xmlhttpRequest;
      const originalFetch = (globalThis as any).fetch;

      (globalThis as any).window = window;
      (globalThis as any).document = window.document;

      (globalThis as any).performance = {
        now: () => Date.now(),
        getEntriesByType: (type: string) => {
          if (type === "resource") {
            return [
              {
                name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=active_token_123",
                initiatorType: "video",
                duration: 50,
              },
            ];
          }
          return [];
        },
      };

      (globalThis as any).GM_xmlhttpRequest = (details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: "Content-Type: video/mp4\r\nContent-Range: bytes 0-1048575/52428800\r\nContent-Length: 1048576",
            });
          }
        }, 10);
        return { abort: () => {} };
      };

      (globalThis as any).fetch = vi.fn().mockImplementation(async () => ({
        status: 206,
        headers: new Map([["Content-Length", "1048576"]]),
        body: {
          getReader: () => {
            let sent = false;
            return {
              read: async () => {
                if (!sent) {
                  sent = true;
                  return { done: false, value: oneMiBChunk };
                }
                return { done: true, value: undefined };
              },
              cancel: async () => {},
              releaseLock: () => {},
            };
          },
        },
      }));

      window.document.body.innerHTML = `
        <dl8-video title="TMAVR285">
          <source quality="720p" src="https://cdn3.astalavr.com/qDAVn/720P.mp4?token=dom_token" />
        </dl8-video>
      `;

      const app = new AstalaVrProbeApp();
      app.init();

      // 1. Initially actual playback is DETECTED, but metadata and range are UNTESTED
      const actualStatusEl = window.document.getElementById("astalavr-transport-actual-status")!;
      const ctrlStatusEl = window.document.getElementById("astalavr-transport-control-status")!;
      const rangeStatusEl = window.document.getElementById("astalavr-transport-range-status")!;

      expect(actualStatusEl.innerHTML).toContain("Actual playback: <strong>DETECTED</strong>");
      expect(ctrlStatusEl.innerHTML).toContain("Control metadata: <strong>UNTESTED</strong>");
      expect(rangeStatusEl.innerHTML).toContain("Range data: <strong>UNTESTED</strong>");

      // 2. Open Developer diagnostics - must not make network calls and must keep UNTESTED
      const devDetails = window.document.getElementById("astalavr-dev-diagnostics") as HTMLDetailsElement;
      devDetails.open = true;
      devDetails.dispatchEvent(new window.Event("toggle"));

      expect(ctrlStatusEl.innerHTML).toContain("Control metadata: <strong>UNTESTED</strong>");
      expect(rangeStatusEl.innerHTML).toContain("Range data: <strong>UNTESTED</strong>");

      // 3. Click Test paired 1MiB Range
      const testPairBtn = window.document.getElementById("astalavr-test-pair-range-btn") as HTMLButtonElement;
      testPairBtn.click();

      await new Promise((r) => setTimeout(r, 60));

      // 4. On PASS, status updates to VERIFIED
      expect(ctrlStatusEl.innerHTML).toContain("Control metadata: <strong>VERIFIED</strong>");
      expect(rangeStatusEl.innerHTML).toContain("Range data: <strong>VERIFIED</strong>");

      app.destroy();

      // 5. New instance (simulating navigation/refresh) resets state to UNTESTED
      const newApp = new AstalaVrProbeApp();
      newApp.init();

      const newCtrlStatusEl = window.document.getElementById("astalavr-transport-control-status")!;
      const newRangeStatusEl = window.document.getElementById("astalavr-transport-range-status")!;
      expect(newCtrlStatusEl.innerHTML).toContain("Control metadata: <strong>UNTESTED</strong>");
      expect(newRangeStatusEl.innerHTML).toContain("Range data: <strong>UNTESTED</strong>");

      newApp.destroy();
      (globalThis as any).window = originalWindow;
      (globalThis as any).document = originalDocument;
      (globalThis as any).performance = originalPerformance;
      (globalThis as any).GM_xmlhttpRequest = originalGm;
      (globalThis as any).fetch = originalFetch;
    });

    it("10. paired FAIL updates transport status to FAILED", async () => {
      const window = new Window({ url: "https://astalavr.com/videos/qDAVn/tmavr285-jun-suehiro-oguri-misao" });
      const originalWindow = (globalThis as any).window;
      const originalDocument = (globalThis as any).document;
      const originalPerformance = (globalThis as any).performance;
      const originalGm = (globalThis as any).GM_xmlhttpRequest;
      const originalFetch = (globalThis as any).fetch;

      (globalThis as any).window = window;
      (globalThis as any).document = window.document;

      (globalThis as any).performance = {
        now: () => Date.now(),
        getEntriesByType: (type: string) => {
          if (type === "resource") {
            return [
              {
                name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=active_token_123",
                initiatorType: "video",
                duration: 50,
              },
            ];
          }
          return [];
        },
      };

      // GM returns status 403 (FAIL)
      (globalThis as any).GM_xmlhttpRequest = (details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 403,
              responseHeaders: "Content-Type: text/html",
            });
          }
        }, 10);
        return { abort: () => {} };
      };

      (globalThis as any).fetch = vi.fn();

      window.document.body.innerHTML = `
        <dl8-video title="TMAVR285">
          <source quality="720p" src="https://cdn3.astalavr.com/qDAVn/720P.mp4?token=dom_token" />
        </dl8-video>
      `;

      const app = new AstalaVrProbeApp();
      app.init();

      const ctrlStatusEl = window.document.getElementById("astalavr-transport-control-status")!;
      const rangeStatusEl = window.document.getElementById("astalavr-transport-range-status")!;

      expect(ctrlStatusEl.innerHTML).toContain("Control metadata: <strong>UNTESTED</strong>");
      expect(rangeStatusEl.innerHTML).toContain("Range data: <strong>UNTESTED</strong>");

      const testPairBtn = window.document.getElementById("astalavr-test-pair-range-btn") as HTMLButtonElement;
      testPairBtn.click();

      await new Promise((r) => setTimeout(r, 60));

      expect(ctrlStatusEl.innerHTML).toContain("Control metadata: <strong>FAILED</strong>");
      expect(rangeStatusEl.innerHTML).toContain("Range data: <strong>FAILED</strong>");

      app.destroy();
      (globalThis as any).window = originalWindow;
      (globalThis as any).document = originalDocument;
      (globalThis as any).performance = originalPerformance;
      (globalThis as any).GM_xmlhttpRequest = originalGm;
      (globalThis as any).fetch = originalFetch;
    });
  });

  describe("Download 720p Proxy (Browser Native File System Streaming)", () => {
    const cachedRenditions = [
      {
        formatId: "720p-unknown",
        resolution: "720p",
        height: 720,
        vcodec: "unknown",
        mimeType: "unknown",
        mediaHostname: "cdn3.astalavr.com",
        fullDirectUrl: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=dom_token",
      },
    ];

    const mockPerf = {
      getEntriesByType: (type: string) => {
        if (type === "resource") {
          return [
            {
              name: "https://cdn3.astalavr.com/qDAVn/720P.mp4?token=active_playback_token_777",
              initiatorType: "video",
              duration: 50,
            },
          ];
        }
        return [];
      },
    };

    it("1. two+ sequential ranges produce exact concatenated file bytes and close writable", async () => {
      const TOTAL = 2500000; // 2.5 MiB -> ranges: 0-1048575 (1 MiB), 1048576-2097151 (1 MiB), 2097152-2499999 (402848 B)
      const writtenChunks: Uint8Array[] = [];
      let writableClosed = false;
      let writableAborted = false;

      const mockWritable = {
        write: vi.fn(async (chunk: Uint8Array) => {
          writtenChunks.push(chunk);
        }),
        close: vi.fn(async () => {
          writableClosed = true;
        }),
        abort: vi.fn(async () => {
          writableAborted = true;
        }),
      };

      const mockFileHandle = {
        createWritable: vi.fn(async () => mockWritable),
      };

      // GM metadata returns 206 bytes 0-0/2500000
      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: `Content-Type: video/mp4\r\nContent-Range: bytes 0-0/${TOTAL}\r\n`,
            });
          }
        }, 10);
        return { abort: vi.fn() };
      });

      const requestedRanges: string[] = [];

      const mockPageFetch = vi.fn(async (_url: string, opts: any) => {
        const range = opts.headers?.Range;
        requestedRanges.push(range);
        const m = range.match(/bytes=(\d+)-(\d+)/);
        const start = parseInt(m[1], 10);
        const end = parseInt(m[2], 10);
        const len = end - start + 1;
        const chunkData = new Uint8Array(len);
        chunkData.fill(start % 255);

        return {
          status: 206,
          headers: new Map([["Content-Length", String(len)]]),
          body: {
            getReader: () => {
              let delivered = false;
              return {
                read: async () => {
                  if (!delivered) {
                    delivered = true;
                    return { done: false, value: chunkData };
                  }
                  return { done: true, value: undefined };
                },
                cancel: async () => {},
                releaseLock: () => {},
              };
            },
          },
        };
      });

      const progressEvents: any[] = [];
      const res = await download720pProxyFile(
        cachedRenditions as any,
        mockPerf as any,
        mockFileHandle,
        (p) => progressEvents.push(p),
        mockGm as any,
        mockPageFetch as any
      );

      expect(res.pass).toBe(true);
      expect(res.bytesWritten).toBe(TOTAL);
      expect(res.totalBytes).toBe(TOTAL);
      expect(writableClosed).toBe(true);
      expect(writableAborted).toBe(false);

      // Verify exact ranges requested
      expect(requestedRanges).toEqual([
        "bytes=0-1048575",
        "bytes=1048576-2097151",
        "bytes=2097152-2499999",
      ]);

      // Verify total written bytes
      const totalWritten = writtenChunks.reduce((acc, c) => acc + c.byteLength, 0);
      expect(totalWritten).toBe(TOTAL);
      expect(progressEvents.length).toBe(3);
      expect(progressEvents[progressEvents.length - 1].percent).toBe(100);
    });

    it("2. handles short final range correctly with exact byte boundary slice", async () => {
      const TOTAL = 1048577; // 1 MiB + 1 byte
      const writtenChunks: Uint8Array[] = [];

      const mockWritable = {
        write: vi.fn(async (chunk: Uint8Array) => {
          writtenChunks.push(chunk);
        }),
        close: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
      };

      const mockFileHandle = {
        createWritable: vi.fn(async () => mockWritable),
      };

      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: `Content-Range: bytes 0-0/${TOTAL}\r\n`,
            });
          }
        }, 10);
        return { abort: vi.fn() };
      });

      const mockPageFetch = vi.fn(async (_url: string, opts: any) => {
        const range = opts.headers?.Range;
        const m = range.match(/bytes=(\d+)-(\d+)/);
        const start = parseInt(m[1], 10);
        const end = parseInt(m[2], 10);
        const len = end - start + 1;

        // Simulate delivery of 10 bytes more than requested in second chunk
        const overDelivered = new Uint8Array(len + 10);

        return {
          status: 206,
          headers: new Map([["Content-Length", String(len)]]),
          body: {
            getReader: () => {
              let delivered = false;
              return {
                read: async () => {
                  if (!delivered) {
                    delivered = true;
                    return { done: false, value: overDelivered };
                  }
                  return { done: true, value: undefined };
                },
                cancel: async () => {},
                releaseLock: () => {},
              };
            },
          },
        };
      });

      const res = await download720pProxyFile(
        cachedRenditions as any,
        mockPerf as any,
        mockFileHandle,
        undefined,
        mockGm as any,
        mockPageFetch as any
      );

      expect(res.pass).toBe(true);
      expect(res.bytesWritten).toBe(TOTAL);
      const totalWritten = writtenChunks.reduce((acc, c) => acc + c.byteLength, 0);
      expect(totalWritten).toBe(TOTAL);
    });

    it("2b. exact-boundary 1 MiB chunk cancels reader immediately and stops reading this Range", async () => {
      const TOTAL = 1048576; // Exact 1 MiB
      let readCallCount = 0;
      let cancelCallCount = 0;

      const mockWritable = {
        write: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
      };

      const mockFileHandle = {
        createWritable: vi.fn(async () => mockWritable),
      };

      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: `Content-Range: bytes 0-0/${TOTAL}\r\n`,
            });
          }
        }, 10);
        return { abort: vi.fn() };
      });

      const exact1MiBChunk = new Uint8Array(1048576);

      const mockPageFetch = vi.fn(async () => {
        return {
          status: 206,
          headers: new Map([["Content-Length", "1048576"]]),
          body: {
            getReader: () => {
              return {
                read: async () => {
                  readCallCount++;
                  if (readCallCount === 1) {
                    return { done: false, value: exact1MiBChunk };
                  }
                  return { done: true, value: undefined };
                },
                cancel: vi.fn(async () => {
                  cancelCallCount++;
                }),
                releaseLock: () => {},
              };
            },
          },
        };
      });

      const res = await download720pProxyFile(
        cachedRenditions as any,
        mockPerf as any,
        mockFileHandle,
        undefined,
        mockGm as any,
        mockPageFetch as any
      );

      expect(res.pass).toBe(true);
      expect(res.bytesWritten).toBe(1048576);
      expect(readCallCount).toBe(1);
      expect(cancelCallCount).toBe(1);
    });

    it("3. HTTP 200 response fails closed, cancels response body, aborts writable, and stops future ranges", async () => {
      const TOTAL = 2000000;
      let abortCalled = false;
      let bodyCancelCalled = false;

      const mockWritable = {
        write: vi.fn(),
        close: vi.fn(),
        abort: vi.fn(async () => {
          abortCalled = true;
        }),
      };

      const mockFileHandle = {
        createWritable: vi.fn(async () => mockWritable),
      };

      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: `Content-Range: bytes 0-0/${TOTAL}\r\n`,
            });
          }
        }, 10);
        return { abort: vi.fn() };
      });

      let pageFetchCount = 0;
      const mockPageFetch = vi.fn(async () => {
        pageFetchCount++;
        return {
          status: 200, // Invalid: must be 206
          headers: new Map([["Content-Length", "2000000"]]),
          body: {
            cancel: vi.fn(async () => {
              bodyCancelCalled = true;
            }),
          },
        };
      });

      const res = await download720pProxyFile(
        cachedRenditions as any,
        mockPerf as any,
        mockFileHandle,
        undefined,
        mockGm as any,
        mockPageFetch as any
      );

      expect(res.pass).toBe(false);
      expect(res.failureKind).toBe("PAGE_STATUS_NOT_206");
      expect(res.bytesWritten).toBe(0);
      expect(abortCalled).toBe(true);
      expect(bodyCancelCalled).toBe(true);
      expect(pageFetchCount).toBe(1);
    });

    it("4. incorrect Content-Length stops transfer, cancels response body, and aborts writable", async () => {
      const TOTAL = 2000000;
      let abortCalled = false;
      let bodyCancelCalled = false;

      const mockWritable = {
        write: vi.fn(),
        close: vi.fn(),
        abort: vi.fn(async () => {
          abortCalled = true;
        }),
      };

      const mockFileHandle = {
        createWritable: vi.fn(async () => mockWritable),
      };

      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: `Content-Range: bytes 0-0/${TOTAL}\r\n`,
            });
          }
        }, 10);
        return { abort: vi.fn() };
      });

      const mockPageFetch = vi.fn(async () => {
        return {
          status: 206,
          headers: new Map([["Content-Length", "500"]]), // Mismatches 1048576
          body: {
            cancel: vi.fn(async () => {
              bodyCancelCalled = true;
            }),
          },
        };
      });

      const res = await download720pProxyFile(
        cachedRenditions as any,
        mockPerf as any,
        mockFileHandle,
        undefined,
        mockGm as any,
        mockPageFetch as any
      );

      expect(res.pass).toBe(false);
      expect(res.failureKind).toBe("PAGE_CONTENT_LENGTH_MISMATCH");
      expect(abortCalled).toBe(true);
      expect(bodyCancelCalled).toBe(true);
    });

    it("4b. missing Content-Length stops transfer, cancels response body, and aborts writable", async () => {
      const TOTAL = 2000000;
      let abortCalled = false;
      let bodyCancelCalled = false;

      const mockWritable = {
        write: vi.fn(),
        close: vi.fn(),
        abort: vi.fn(async () => {
          abortCalled = true;
        }),
      };

      const mockFileHandle = {
        createWritable: vi.fn(async () => mockWritable),
      };

      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: `Content-Range: bytes 0-0/${TOTAL}\r\n`,
            });
          }
        }, 10);
        return { abort: vi.fn() };
      });

      const mockPageFetch = vi.fn(async () => {
        return {
          status: 206,
          headers: new Map(), // No Content-Length
          body: {
            cancel: vi.fn(async () => {
              bodyCancelCalled = true;
            }),
          },
        };
      });

      const res = await download720pProxyFile(
        cachedRenditions as any,
        mockPerf as any,
        mockFileHandle,
        undefined,
        mockGm as any,
        mockPageFetch as any
      );

      expect(res.pass).toBe(false);
      expect(res.failureKind).toBe("PAGE_CONTENT_LENGTH_MISSING");
      expect(abortCalled).toBe(true);
      expect(bodyCancelCalled).toBe(true);
    });

    it("5. short stream body stops transfer with PAGE_BODY_LENGTH_MISMATCH", async () => {
      const TOTAL = 1048576;
      let abortCalled = false;

      const mockWritable = {
        write: vi.fn(),
        close: vi.fn(),
        abort: vi.fn(async () => {
          abortCalled = true;
        }),
      };

      const mockFileHandle = {
        createWritable: vi.fn(async () => mockWritable),
      };

      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: `Content-Range: bytes 0-0/${TOTAL}\r\n`,
            });
          }
        }, 10);
        return { abort: vi.fn() };
      });

      const mockPageFetch = vi.fn(async () => {
        return {
          status: 206,
          headers: new Map([["Content-Length", "1048576"]]),
          body: {
            getReader: () => {
              let delivered = false;
              return {
                read: async () => {
                  if (!delivered) {
                    delivered = true;
                    // Deliver only 500 bytes instead of 1048576
                    return { done: false, value: new Uint8Array(500) };
                  }
                  return { done: true, value: undefined };
                },
                cancel: async () => {},
                releaseLock: () => {},
              };
            },
          },
        };
      });

      const res = await download720pProxyFile(
        cachedRenditions as any,
        mockPerf as any,
        mockFileHandle,
        undefined,
        mockGm as any,
        mockPageFetch as any
      );

      expect(res.pass).toBe(false);
      expect(res.failureKind).toBe("PAGE_BODY_LENGTH_MISMATCH");
      expect(abortCalled).toBe(true);
    });

    it("6. write failure aborts writable and cancels active reader", async () => {
      const TOTAL = 1048576;
      let abortCalled = false;
      let readerCancelCalled = false;

      const mockWritable = {
        write: vi.fn(async () => {
          throw new Error("Disk full");
        }),
        close: vi.fn(),
        abort: vi.fn(async () => {
          abortCalled = true;
        }),
      };

      const mockFileHandle = {
        createWritable: vi.fn(async () => mockWritable),
      };

      const mockGm = vi.fn((details: any) => {
        setTimeout(() => {
          if (details.onreadystatechange) {
            details.onreadystatechange({
              readyState: 2,
              status: 206,
              responseHeaders: `Content-Range: bytes 0-0/${TOTAL}\r\n`,
            });
          }
        }, 10);
        return { abort: vi.fn() };
      });

      const mockPageFetch = vi.fn(async () => {
        return {
          status: 206,
          headers: new Map([["Content-Length", "1048576"]]),
          body: {
            getReader: () => {
              return {
                read: async () => ({ done: false, value: new Uint8Array(1000) }),
                cancel: async () => {
                  readerCancelCalled = true;
                },
                releaseLock: () => {},
              };
            },
          },
        };
      });

      const res = await download720pProxyFile(
        cachedRenditions as any,
        mockPerf as any,
        mockFileHandle,
        undefined,
        mockGm as any,
        mockPageFetch as any
      );

      expect(res.pass).toBe(false);
      expect(res.failureKind).toBe("FILE_WRITE_ERROR");
      expect(abortCalled).toBe(true);
      expect(readerCancelCalled).toBe(true);
    });

    it("7. normal Companion UI has NO browser-download save button", async () => {
      const window = new Window({ url: "https://astalavr.com/videos/78yre/sample" });
      const originalWindow = (globalThis as any).window;
      const originalDocument = (globalThis as any).document;

      (globalThis as any).window = window;
      (globalThis as any).document = window.document;

      window.document.body.innerHTML = `
        <dl8-video title="Sample">
          <source quality="720p" src="https://cdn3.astalavr.com/78yre/720P.mp4?token=dom_token" />
        </dl8-video>
      `;

      const app = new AstalaVrProbeApp();
      app.init();

      const downloadBtn = window.document.getElementById("astalavr-download-720p-btn");
      expect(downloadBtn).toBeNull();

      const bridgeStatus = window.document.getElementById("astalavr-agent-bridge-status");
      expect(bridgeStatus).not.toBeNull();
      expect(bridgeStatus?.innerHTML).toContain("WAITING_FOR_AGENT_JOB");

      app.destroy();
      (globalThis as any).window = originalWindow;
      (globalThis as any).document = originalDocument;
    });

    it("8. browser bridge sends Uint8Array/ArrayBuffer chunks to local bridge server", async () => {
      const postedChunks: { url: string; headers: any; data: any }[] = [];

      const mockGm = vi.fn((details: any) => {
        if (details.method === "GET" && details.headers?.Range === "bytes=0-0") {
          setTimeout(() => {
            if (details.onreadystatechange) {
              details.onreadystatechange({
                readyState: 2,
                status: 206,
                responseHeaders: "Content-Range: bytes 0-0/1048576\r\n",
              });
            }
          }, 5);
        } else if (details.method === "POST") {
          postedChunks.push({
            url: details.url,
            headers: details.headers,
            data: details.data,
          });
          setTimeout(() => {
            if (details.onload) {
              details.onload({ status: 200, responseText: JSON.stringify({ status: "OK" }) });
            }
          }, 5);
        }
        return { abort: () => {} };
      });

      const mockPageFetch = vi.fn(async () => {
        return {
          status: 206,
          headers: new Map([["Content-Length", "1048576"]]),
          body: {
            getReader: () => {
              let delivered = false;
              return {
                read: async () => {
                  if (!delivered) {
                    delivered = true;
                    return { done: false, value: new Uint8Array(1048576) };
                  }
                  return { done: true, value: undefined };
                },
                cancel: async () => {},
                releaseLock: () => {},
              };
            },
          },
        };
      });

      const res = await transfer720pProxyToBridge({
        assetId: "78yre",
        cachedRenditions: cachedRenditions as any,
        performanceObj: mockPerf as any,
        customGmFn: mockGm as any,
        customFetchFn: mockPageFetch as any,
      });

      expect(res.pass).toBe(true);
      expect(res.bytesWritten).toBe(1048576);

      // Verify chunk POST and complete POST
      expect(postedChunks.length).toBe(2);
      expect(postedChunks[0].url).toBe("http://127.0.0.1:38815/astalavr/chunk");
      expect(postedChunks[0].headers["X-Asset-Id"]).toBe("78yre");
      expect(postedChunks[0].headers["X-Offset"]).toBe("0");
      expect(postedChunks[0].data instanceof ArrayBuffer).toBe(true);
      expect(postedChunks[1].url).toBe("http://127.0.0.1:38815/astalavr/complete");

      // Verify signed URL never sent across IPC
      for (const p of postedChunks) {
        expect(JSON.stringify(p.headers)).not.toContain("active_playback_token_777");
        expect(p.url).not.toContain("active_playback_token_777");
      }
    });

    it("9. local bridge unreachable returns LOCAL_BRIDGE_UNREACHABLE without falling back to browser-file", async () => {
      const mockGm = vi.fn((details: any) => {
        if (details.method === "GET" && details.headers?.Range === "bytes=0-0") {
          setTimeout(() => {
            if (details.onreadystatechange) {
              details.onreadystatechange({
                readyState: 2,
                status: 206,
                responseHeaders: "Content-Range: bytes 0-0/1048576\r\n",
              });
            }
          }, 5);
        } else if (details.method === "POST") {
          // Connection refused / unreachable
          setTimeout(() => {
            if (details.onerror) {
              details.onerror(new Error("Connection refused"));
            }
          }, 5);
        }
        return { abort: () => {} };
      });

      const mockPageFetch = vi.fn(async () => {
        return {
          status: 206,
          headers: new Map([["Content-Length", "1048576"]]),
          body: {
            getReader: () => {
              return {
                read: async () => ({ done: false, value: new Uint8Array(1048576) }),
                cancel: async () => {},
                releaseLock: () => {},
              };
            },
          },
        };
      });

      const res = await transfer720pProxyToBridge({
        assetId: "78yre",
        cachedRenditions: cachedRenditions as any,
        performanceObj: mockPerf as any,
        customGmFn: mockGm as any,
        customFetchFn: mockPageFetch as any,
      });

      expect(res.pass).toBe(false);
      expect(res.failureKind).toBe("FILE_WRITE_ERROR");
    });
  });
});


