// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import {
  extractVideoId,
  isResolution4kPlus,
  extractCardResolution,
  parseCandidateCards,
  applyHardFilter,
  applySoftFilter,
} from "../../companion/src/card-parser.js";
import type { CandidateCard, RenditionProfile } from "../../companion/src/types.js";

describe("Companion Card Parser & Filters", () => {
  describe("extractVideoId", () => {
    it("extracts ID from standard Eporner URL patterns", () => {
      expect(extractVideoId("/video-abc1234/test-title")).toBe("abc1234");
      expect(extractVideoId("https://www.eporner.com/video/xyz7890/sample")).toBe("xyz7890");
      expect(extractVideoId("/hd-porn/def456/")).toBe("def456");
      expect(extractVideoId("/other-path")).toBeNull();
    });
  });

  describe("isResolution4kPlus", () => {
    it("recognizes 4K and higher resolution labels", () => {
      expect(isResolution4kPlus("4K")).toBe(true);
      expect(isResolution4kPlus("4K 2160p")).toBe(true);
      expect(isResolution4kPlus("2160p")).toBe(true);
      expect(isResolution4kPlus("VR 4K")).toBe(true);
      expect(isResolution4kPlus("5K 2880p")).toBe(true);
      expect(isResolution4kPlus("8K 4320p")).toBe(true);
    });

    it("rejects sub-4K resolutions", () => {
      expect(isResolution4kPlus("1080p")).toBe(false);
      expect(isResolution4kPlus("1080p 60fps")).toBe(false);
      expect(isResolution4kPlus("720p")).toBe(false);
      expect(isResolution4kPlus("HD")).toBe(false);
      expect(isResolution4kPlus("480p")).toBe(false);
      expect(isResolution4kPlus("unknown")).toBe(false);
    });
  });

  describe("parseCandidateCards & Hard Filter", () => {
    let container: HTMLDivElement;

    beforeEach(() => {
      document.body.innerHTML = `
        <div id="vidresults">
          <div class="mb" id="vf1">
            <a href="/video-v1/video-one">
              <span class="mv4k">4K 2160p</span>
            </a>
            <div class="mbtit"><a href="/video-v1/video-one">Video One</a></div>
          </div>
          <div class="mb" id="vf2">
            <a href="/video-v2/video-two">
              <span class="mvhd">1080p</span>
            </a>
            <div class="mbtit"><a href="/video-v2/video-two">Video Two</a></div>
          </div>
          <div class="mb" id="vf3">
            <a href="/video-v3/video-three">
              <span class="mvvr">VR 4K</span>
            </a>
            <div class="mbtit"><a href="/video-v3/video-three">Video Three</a></div>
          </div>
          <div class="mb" id="vf4">
            <a href="/video-v4/video-four">
              <span class="mvhd">720p</span>
            </a>
            <div class="mbtit"><a href="/video-v4/video-four">Video Four</a></div>
          </div>
        </div>
      `;
      container = document.querySelector("#vidresults") as HTMLDivElement;
    });

    it("parses candidate cards with resolution classification", () => {
      const cards = parseCandidateCards(container);
      expect(cards).toHaveLength(4);

      expect(cards[0].videoId).toBe("v1");
      expect(cards[0].is4kPlus).toBe(true);

      expect(cards[1].videoId).toBe("v2");
      expect(cards[1].is4kPlus).toBe(false);

      expect(cards[2].videoId).toBe("v3");
      expect(cards[2].is4kPlus).toBe(true);

      expect(cards[3].videoId).toBe("v4");
      expect(cards[3].is4kPlus).toBe(false);
    });

    it("Hard Filter permanently deletes <4K cards from the DOM", () => {
      const cards = parseCandidateCards(container);
      const { kept, removedCount } = applyHardFilter(cards);

      expect(removedCount).toBe(2);
      expect(kept).toHaveLength(2);
      expect(kept.map((c) => c.videoId)).toEqual(["v1", "v3"]);

      // Verify DOM: vf2 and vf4 must be completely removed
      expect(document.querySelector("#vf1")).not.toBeNull();
      expect(document.querySelector("#vf2")).toBeNull();
      expect(document.querySelector("#vf3")).not.toBeNull();
      expect(document.querySelector("#vf4")).toBeNull();
    });
  });

  describe("Soft Filter & Optimistic Visibility", () => {
    let cards: CandidateCard[];

    beforeEach(() => {
      document.body.innerHTML = `
        <div id="vidresults">
          <div class="mb" id="card-av1"><a href="/video-1/">4K</a></div>
          <div class="mb" id="card-noav1"><a href="/video-2/">4K</a></div>
          <div class="mb" id="card-pending"><a href="/video-3/">4K</a></div>
          <div class="mb" id="card-error"><a href="/video-4/">4K</a></div>
        </div>
      `;
      cards = parseCandidateCards();
    });

    it("optimistically preserves pending, probing, and error cards; only hides confirmed NO AV1", () => {
      const profiles = new Map<string, RenditionProfile>([
        [
          "1",
          {
            videoId: "1",
            sourceUrl: "https://www.eporner.com/video-1/",
            maxResolution: "4K",
            av1Resolutions: ["2160p"],
            highestAv1Resolution: "2160p",
            has4kAv1: true,
            probeStatus: "detected",
          },
        ],
        [
          "2",
          {
            videoId: "2",
            sourceUrl: "https://www.eporner.com/video-2/",
            maxResolution: "4K",
            av1Resolutions: [],
            highestAv1Resolution: null,
            has4kAv1: false,
            probeStatus: "no_av1",
          },
        ],
        [
          "3",
          {
            videoId: "3",
            sourceUrl: "https://www.eporner.com/video-3/",
            maxResolution: "4K",
            av1Resolutions: [],
            highestAv1Resolution: null,
            has4kAv1: false,
            probeStatus: "pending",
          },
        ],
        [
          "4",
          {
            videoId: "4",
            sourceUrl: "https://www.eporner.com/video-4/",
            maxResolution: "4K",
            av1Resolutions: [],
            highestAv1Resolution: null,
            has4kAv1: false,
            probeStatus: "error",
            error: "HTTP 500",
          },
        ],
      ]);

      // Enable Soft Filter (only AV1)
      applySoftFilter(cards, true, profiles);

      const elAv1 = document.querySelector("#card-av1") as HTMLElement;
      const elNoAv1 = document.querySelector("#card-noav1") as HTMLElement;
      const elPending = document.querySelector("#card-pending") as HTMLElement;
      const elError = document.querySelector("#card-error") as HTMLElement;

      expect(elAv1.style.display).not.toBe("none");
      expect(elNoAv1.style.display).toBe("none");
      // Optimistic visibility: pending & error MUST NOT be hidden
      expect(elPending.style.display).not.toBe("none");
      expect(elError.style.display).not.toBe("none");

      // Disable Soft Filter
      applySoftFilter(cards, false, profiles);
      expect(elNoAv1.style.display).not.toBe("none");
    });
  });
});
