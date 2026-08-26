// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EpornerCompanionApp } from "../../companion/src/index.js";

describe("Eporner Companion Integration & Lifecycle", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="vidresults">
        <div class="mb" id="v1"><a href="/video-v1/video-one"><span class="mv4k">4K 2160p</span></a></div>
        <div class="mb" id="v2"><a href="/video-v2/video-two"><span class="mvhd">1080p</span></a></div>
        <div class="mb" id="v3"><a href="/video-v3/video-three"><span class="mvvr">VR 4K</span></a></div>
      </div>
    `;
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

  it("handles Hard Filter: deletes <4K cards and queues remaining 4K cards", async () => {
    const app = new EpornerCompanionApp();
    await app.init();

    // Toggle 4K+ filter
    const hardBtn = document.querySelector(".javr-btn") as HTMLButtonElement;
    hardBtn.click();

    // Sub-4K card #v2 must be removed from DOM
    expect(document.querySelector("#v2")).toBeNull();
    expect(document.querySelector("#v1")).not.toBeNull();
    expect(document.querySelector("#v3")).not.toBeNull();

    app.destroy();
  });
});
