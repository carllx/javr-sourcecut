// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EpornerCompanionApp } from "../../companion/src/index.js";

describe("Eporner Companion Integration & Lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => `
          <div id="hd-porn-dload">
            <a href="/dload/1/2160p.mp4"><b>2160p 4K</b> <span>MP4 (AV1)</span></a>
          </div>
        `,
      })
    );

    document.body.innerHTML = `
      <div id="vidresults">
        <div class="mb" id="v1"><a href="/video-v1/video-one"><span class="mv4k">4K 2160p</span></a></div>
        <div class="mb" id="v2"><a href="/video-v2/video-two"><span class="mvhd">1080p</span></a></div>
        <div class="mb" id="v3"><a href="/video-v3/video-three"><span class="mvvr">VR 4K</span></a></div>
      </div>
    `;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initializes companion app, injects styles, and mounts floating toolbar", async () => {
    const app = new EpornerCompanionApp();
    await app.init();

    expect(document.getElementById("javr-companion-styles")).not.toBeNull();
    expect(document.getElementById("javr-floating-toolbar")).not.toBeNull();

    // 4K cards should have badges mounted
    const badgeV1 = document.querySelector("#v1 .javr-card-badge");
    expect(badgeV1).not.toBeNull();

    // 1080p card should NOT have 4K format badge
    const badgeV2 = document.querySelector("#v2 .javr-card-badge");
    expect(badgeV2).toBeNull();

    app.destroy();
  });

  it("STRICT LIFECYCLE: does not issue AV1 probing requests prior to Hard Filter activation", async () => {
    const app = new EpornerCompanionApp();
    await app.init();

    // 4K cards show initial unprobed badge ("4K"), never probing ("4K · ⏳") or detected AV1
    const badgeV1 = document.querySelector("#v1 .javr-card-badge");
    expect(badgeV1?.textContent).toBe("4K");

    // Sub-4K card is still in DOM before activation
    expect(document.querySelector("#v2")).not.toBeNull();

    app.destroy();
  });

  it("handles Hard Filter: one-way activation deletes <4K cards and stays active for dynamic content", async () => {
    const app = new EpornerCompanionApp();
    await app.init();

    const [hardBtn] = document.querySelectorAll(".javr-btn") as any;
    expect(hardBtn.textContent).toBe("筛选 4K+");
    expect(hardBtn.disabled).toBe(false);

    // Activate 4K+ filter
    hardBtn.click();

    // Sub-4K card #v2 must be removed from DOM
    expect(document.querySelector("#v2")).toBeNull();
    expect(document.querySelector("#v1")).not.toBeNull();
    expect(document.querySelector("#v3")).not.toBeNull();

    // Hard filter button must enter permanent disabled/active state
    expect(hardBtn.disabled).toBe(true);
    expect(hardBtn.textContent).toBe("已筛选 4K+");

    // Dynamic loading test: dynamically added sub-4K card must be removed immediately
    const dynamicContainer = document.querySelector("#vidresults") as HTMLDivElement;
    const dynamicSub4k = document.createElement("div");
    dynamicSub4k.className = "mb";
    dynamicSub4k.id = "v-dyn-1080";
    dynamicSub4k.innerHTML = `<a href="/video-dyn1/test"><span class="mvhd">1080p</span></a>`;
    dynamicContainer.appendChild(dynamicSub4k);

    // Process new content
    app.scanAndProcess(dynamicContainer);

    expect(document.querySelector("#v-dyn-1080")).toBeNull();

    app.destroy();
  });

  describe("Native Filter Awareness (quality=2160)", () => {
    it("auto-activates filtering & probing lifecycle and updates toolbar UI on quality=2160", async () => {
      const app = new EpornerCompanionApp({
        searchQuery: "?quality=2160",
      });
      await app.init();

      const [hardBtn] = document.querySelectorAll(".javr-btn") as any;
      expect(hardBtn.textContent).toBe("✓ Eporner 4K+");
      expect(hardBtn.disabled).toBe(true);
      expect(hardBtn.classList.contains("active-gold")).toBe(true);

      // Sub-4K leakage #v2 must be automatically removed from DOM
      expect(document.querySelector("#v2")).toBeNull();
      expect(document.querySelector("#v1")).not.toBeNull();
      expect(document.querySelector("#v3")).not.toBeNull();

      // Probing lifecycle should be automatically enqueued
      // Dynamic loading sub-4K cards should also be deleted immediately
      const dynamicContainer = document.querySelector("#vidresults") as HTMLDivElement;
      const leakedCard = document.createElement("div");
      leakedCard.className = "mb";
      leakedCard.id = "leaked-720";
      leakedCard.innerHTML = `<a href="/video-leak/test"><span class="mvhd">720p</span></a>`;
      dynamicContainer.appendChild(leakedCard);

      app.scanAndProcess(dynamicContainer);
      expect(document.querySelector("#leaked-720")).toBeNull();

      app.destroy();
    });

    it("does NOT auto-activate when quality is 1080 or not 2160", async () => {
      const app = new EpornerCompanionApp({
        searchQuery: "?quality=1080",
      });
      await app.init();

      const [hardBtn] = document.querySelectorAll(".javr-btn") as any;
      expect(hardBtn.textContent).toBe("筛选 4K+");
      expect(hardBtn.disabled).toBe(false);

      // Sub-4K card is NOT deleted prior to manual activation
      expect(document.querySelector("#v2")).not.toBeNull();

      app.destroy();
    });
  });

  describe("Only-AV1 Soft Filter In-Flight Settling (Race Condition)", () => {
    it("automatically hides later-settled NO AV1 cards when Only-AV1 is toggled during probing without requiring second toggle", async () => {
      let resolveV1: (val: any) => void;
      let resolveV3: (val: any) => void;

      const promiseV1 = new Promise((resolve) => {
        resolveV1 = resolve;
      });
      const promiseV3 = new Promise((resolve) => {
        resolveV3 = resolve;
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          if (url.includes("video-one")) {
            return promiseV1;
          }
          if (url.includes("video-three")) {
            return promiseV3;
          }
          return Promise.resolve({
            ok: true,
            text: async () => `<div id="hd-porn-dload"></div>`,
          });
        })
      );

      const app = new EpornerCompanionApp({
        searchQuery: "?quality=2160",
      });
      await app.init();

      const elV1 = document.querySelector("#v1") as HTMLElement;
      const elV3 = document.querySelector("#v3") as HTMLElement;

      // Both cards are in-flight probing
      expect(elV1).not.toBeNull();
      expect(elV3).not.toBeNull();

      // Step 3: User clicks "只看 AV1" while probing is in-flight
      const buttons = document.querySelectorAll(".javr-btn") as any;
      const softBtn = buttons[1]; // [只看 AV1]
      softBtn.click();
      expect(softBtn.classList.contains("active")).toBe(true);

      // Optimistic visibility: while in-flight, neither card is hidden
      expect(elV1.style.display).not.toBe("none");
      expect(elV3.style.display).not.toBe("none");

      // Step 5 & 6: Settle v1 as detected (AV1 4K) and v3 as no_av1 (H264 only)
      resolveV1!({
        ok: true,
        text: async () => `
          <div id="downloaddiv">
            <span class="download-av1"><a href="/dload/1/2160/1-2160p.mp4">2160p (4K) AV1</a></span>
          </div>
        `,
      });

      resolveV3!({
        ok: true,
        text: async () => `
          <div id="downloaddiv">
            <span class="download-h264"><a href="/dload/3/2160/3-2160p.mp4">2160p (4K) H264</a></span>
          </div>
        `,
      });

      // Allow microtasks & queue callbacks to settle
      await new Promise((r) => setTimeout(r, 50));

      // Assertions:
      // v1 (detected AV1) must remain visible
      expect(elV1.style.display).not.toBe("none");
      expect(elV1.classList.contains("javr-soft-hidden")).toBe(false);

      // v3 (later settled as no_av1) MUST be automatically hidden without requiring second toggle!
      expect(elV3.style.display).toBe("none");
      expect(elV3.classList.contains("javr-soft-hidden")).toBe(true);

      // Toggle off Only-AV1 -> v3 becomes visible again
      softBtn.click();
      expect(elV3.style.display).not.toBe("none");
      expect(elV3.classList.contains("javr-soft-hidden")).toBe(false);

      app.destroy();
    });

    it("keeps Error / Unknown cards visible under Only-AV1 active mode after auto-retries exhaust", async () => {
      let callCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          if (url.includes("video-one")) {
            callCount++;
            return Promise.resolve({
              ok: false,
              status: 500,
              statusText: "Internal Server Error",
            });
          }
          return Promise.resolve({
            ok: true,
            text: async () => `<div id="hd-porn-dload"></div>`,
          });
        })
      );

      const app = new EpornerCompanionApp({
        searchQuery: "?quality=2160",
      });
      await app.init();

      const elV1 = document.querySelector("#v1") as HTMLElement;
      const buttons = document.querySelectorAll(".javr-btn") as any;
      const softBtn = buttons[1]; // [只看 AV1]
      softBtn.click();
      expect(softBtn.classList.contains("active")).toBe(true);

      // Wait for initial attempt + 2 auto-retries (300ms + 600ms backoff) to exhaust
      await new Promise((r) => setTimeout(r, 1100));

      // Verify retries were actually performed
      expect(callCount).toBeGreaterThanOrEqual(3);

      // Verify badge settled into Error retry state
      const badgeV1 = elV1.querySelector(".javr-card-badge") as HTMLElement;
      expect(badgeV1.textContent).toContain("4K · ⚠️ 重试");
      expect(badgeV1.classList.contains("javr-badge-error")).toBe(true);

      // Error/Unknown MUST remain optimistic visible even when Only-AV1 is active
      expect(elV1.style.display).not.toBe("none");
      expect(elV1.classList.contains("javr-soft-hidden")).toBe(false);

      app.destroy();
    });

    it("automatically hides dynamically loaded cards that later settle as NO AV1 while Only-AV1 is active", async () => {
      let resolveDyn: (val: any) => void;
      const promiseDyn = new Promise((resolve) => {
        resolveDyn = resolve;
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          if (url.includes("video-dyn-4k")) {
            return promiseDyn;
          }
          return Promise.resolve({
            ok: true,
            text: async () => `<div id="hd-porn-dload"><span class="download-av1"><a href="/dload/1/2160/1.mp4">4K AV1</a></span></div>`,
          });
        })
      );

      const app = new EpornerCompanionApp({
        searchQuery: "?quality=2160",
      });
      await app.init();

      // Enable Only-AV1
      const buttons = document.querySelectorAll(".javr-btn") as any;
      const softBtn = buttons[1];
      softBtn.click();
      expect(softBtn.classList.contains("active")).toBe(true);

      // Dynamically add a new 4K candidate card
      const dynamicContainer = document.querySelector("#vidresults") as HTMLDivElement;
      const dynamic4k = document.createElement("div");
      dynamic4k.className = "mb";
      dynamic4k.id = "v-dyn-4k";
      dynamic4k.innerHTML = `<a href="/video-dyn-4k/test"><span class="mvhd">4K</span></a>`;
      dynamicContainer.appendChild(dynamic4k);

      app.scanAndProcess(dynamicContainer);

      const elDyn = document.querySelector("#v-dyn-4k") as HTMLElement;
      expect(elDyn).not.toBeNull();
      // Initially pending/probing -> visible
      expect(elDyn.style.display).not.toBe("none");

      // Settle dynamically added card as no_av1
      resolveDyn!({
        ok: true,
        text: async () => `
          <div id="downloaddiv">
            <span class="download-h264"><a href="/dload/dyn/2160/dyn.mp4">2160p H264</a></span>
          </div>
        `,
      });

      await new Promise((r) => setTimeout(r, 50));

      // Must be automatically hidden without user interaction
      expect(elDyn.style.display).toBe("none");
      expect(elDyn.classList.contains("javr-soft-hidden")).toBe(true);

      app.destroy();
    });
  });
});
