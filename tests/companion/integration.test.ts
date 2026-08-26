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
});
