// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FloatingToolbar } from "../../companion/src/ui/floating-toolbar.js";
import { FormatBadgeRenderer } from "../../companion/src/ui/format-badge.js";
import type { CandidateCard, RenditionProfile } from "../../companion/src/types.js";

describe("Companion UI Components", () => {
  describe("FloatingToolbar", () => {
    let toolbar: FloatingToolbar;
    let onHardFilter: any;
    let onSoftFilter: any;

    beforeEach(() => {
      document.body.innerHTML = "";
      onHardFilter = vi.fn();
      onSoftFilter = vi.fn();
      toolbar = new FloatingToolbar({
        onActivateHardFilter: onHardFilter,
        onToggleSoftFilter: onSoftFilter,
      });
      toolbar.mount();
    });

    it("mounts to DOM and renders controls", () => {
      expect(document.getElementById("javr-floating-toolbar")).not.toBeNull();
      const buttons = document.querySelectorAll(".javr-btn");
      expect(buttons).toHaveLength(2);
    });

    it("activates hard filter as a one-way irreversible action", () => {
      const [hardBtn, softBtn] = document.querySelectorAll(".javr-btn") as any;

      hardBtn.click();
      expect(onHardFilter).toHaveBeenCalledTimes(1);
      expect(hardBtn.classList.contains("active-gold")).toBe(true);
      expect(hardBtn.textContent).toBe("已筛选 4K+");
      expect(hardBtn.disabled).toBe(true);

      // Subsequent clicks must NOT toggle off or trigger callback again
      hardBtn.click();
      expect(onHardFilter).toHaveBeenCalledTimes(1);
      expect(hardBtn.classList.contains("active-gold")).toBe(true);

      // Soft filter remains a reversible toggle
      softBtn.click();
      expect(onSoftFilter).toHaveBeenCalledWith(true);
      expect(softBtn.classList.contains("active")).toBe(true);

      softBtn.click();
      expect(onSoftFilter).toHaveBeenCalledWith(false);
      expect(softBtn.classList.contains("active")).toBe(false);
    });

    it("renders native 4K prefiltered state gracefully", () => {
      toolbar.setNative4kActive(true);
      const [hardBtn] = document.querySelectorAll(".javr-btn") as any;

      expect(hardBtn.textContent).toBe("✓ Eporner 4K+");
      expect(hardBtn.disabled).toBe(true);
      expect(hardBtn.classList.contains("active-gold")).toBe(true);
    });

    it("updates statistics display accurately", () => {
      toolbar.updateStats({
        totalCards: 20,
        total4kPlus: 12,
        confirmedAv1: 7,
        confirmed4kAv1: 4,
        confirmedNoAv1: 5,
        probing: 2,
        errorCount: 1,
      });

      const statsEl = document.querySelector(".javr-stats-line");
      expect(statsEl?.textContent).toContain("4K: 12");
      expect(statsEl?.textContent).toContain("AV1: 7");
      expect(statsEl?.textContent).toContain("4K");
      expect(statsEl?.textContent).toContain("探测: 2");
      expect(statsEl?.textContent).toContain("失败: 1");
    });
  });

  describe("FormatBadgeRenderer", () => {
    let card: CandidateCard;
    let renderer: FormatBadgeRenderer;
    let onRetry: any;

    beforeEach(() => {
      onRetry = vi.fn();
      renderer = new FormatBadgeRenderer({ onRetry });
      const el = document.createElement("div");
      card = {
        videoId: "v123",
        url: "https://www.eporner.com/video-v123/",
        element: el,
        advertisedResolution: "4K 2160p",
        is4kPlus: true,
      };
    });

    it("renders 4K · AV1 4K badge for 4K AV1 profiles", () => {
      const profile: RenditionProfile = {
        videoId: "v123",
        sourceUrl: card.url,
        maxResolution: "4K",
        av1Resolutions: ["2160p", "1080p"],
        highestAv1Resolution: "2160p",
        has4kAv1: true,
        probeStatus: "detected",
      };

      const badge = renderer.mountBadge(card, profile);
      expect(badge.textContent).toBe("4K · AV1 4K");
      expect(badge.classList.contains("javr-badge-4k-av1-4k")).toBe(true);
    });

    it("renders 4K · AV1 1080p for 1080p AV1 profiles", () => {
      const profile: RenditionProfile = {
        videoId: "v123",
        sourceUrl: card.url,
        maxResolution: "4K",
        av1Resolutions: ["1080p"],
        highestAv1Resolution: "1080p",
        has4kAv1: false,
        probeStatus: "detected",
      };

      const badge = renderer.mountBadge(card, profile);
      expect(badge.textContent).toBe("4K · AV1 1080p");
      expect(badge.classList.contains("javr-badge-4k-av1-1080p")).toBe(true);
    });

    it("renders 4K · NO AV1 for confirmed NO AV1", () => {
      const profile: RenditionProfile = {
        videoId: "v123",
        sourceUrl: card.url,
        maxResolution: "4K",
        av1Resolutions: [],
        highestAv1Resolution: null,
        has4kAv1: false,
        probeStatus: "no_av1",
      };

      const badge = renderer.mountBadge(card, profile);
      expect(badge.textContent).toBe("4K · NO AV1");
      expect(badge.classList.contains("javr-badge-4k-no-av1")).toBe(true);
    });

    it("renders clickable error badge and invokes onRetry callback", () => {
      const profile: RenditionProfile = {
        videoId: "v123",
        sourceUrl: card.url,
        maxResolution: "4K",
        av1Resolutions: [],
        highestAv1Resolution: null,
        has4kAv1: false,
        probeStatus: "error",
        error: "Gateway Timeout",
      };

      const badge = renderer.mountBadge(card, profile);
      expect(badge.textContent).toContain("4K · ⚠️ 重试");
      expect(badge.classList.contains("javr-badge-error")).toBe(true);

      badge.click();
      expect(onRetry).toHaveBeenCalledWith("v123");
    });
  });
});
