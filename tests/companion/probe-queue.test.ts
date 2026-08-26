// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProbeQueue } from "../../companion/src/probe-queue.js";
import { RenditionCacheManager, MemoryStorageAdapter } from "../../companion/src/cache.js";
import type { CandidateCard, RenditionProfile, Requester } from "../../companion/src/types.js";

describe("Companion Probe Queue", () => {
  let storage: MemoryStorageAdapter;
  let cacheManager: RenditionCacheManager;
  let mockRequester: Requester;

  const validAv1Html = `
    <html><head><title>4K Video - EPORNER</title></head><body>
      <div id="downloaddiv">
        <span class="download-av1"><a href="/dload/v1/2160/v1-2160p-av1.mp4">2160p AV1</a></span>
      </div>
    </body></html>
  `;

  const validNoAv1Html = `
    <html><head><title>4K Video - EPORNER</title></head><body>
      <div id="downloaddiv">
        <span class="download-h264"><a href="/dload/v2/2160/v2-2160p.mp4">2160p H264</a></span>
      </div>
    </body></html>
  `;

  beforeEach(() => {
    storage = new MemoryStorageAdapter();
    cacheManager = new RenditionCacheManager(storage);
    mockRequester = {
      fetchText: vi.fn(),
    };
  });

  function createCard(id: string, is4kPlus = true): CandidateCard {
    const el = document.createElement("div");
    return {
      videoId: id,
      url: `https://www.eporner.com/video-${id}/`,
      element: el,
      advertisedResolution: "4K 2160p",
      is4kPlus,
    };
  }

  it("serves cached result immediately without network request", async () => {
    const cachedProfile: RenditionProfile = {
      videoId: "cached1",
      sourceUrl: "https://www.eporner.com/video-cached1/",
      maxResolution: "4K",
      av1Resolutions: ["2160p"],
      highestAv1Resolution: "2160p",
      has4kAv1: true,
      probeStatus: "detected",
      updatedAt: Date.now(),
    };
    await cacheManager.saveProfile(cachedProfile);

    const updateSpy = vi.fn();
    const queue = new ProbeQueue({
      requester: mockRequester,
      cacheManager,
      onProfileUpdate: updateSpy,
    });

    const card = createCard("cached1");
    queue.enqueue(card);

    expect(card.profile).toEqual(cachedProfile);
    expect(mockRequester.fetchText).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledWith(cachedProfile, card);
  });

  it("processes queue with concurrency limit and updates profile", async () => {
    (mockRequester.fetchText as any).mockResolvedValue(validAv1Html);

    const updateSpy = vi.fn();
    const queue = new ProbeQueue({
      concurrency: 1,
      requester: mockRequester,
      cacheManager,
      onProfileUpdate: updateSpy,
    });

    const card1 = createCard("card1");
    const card2 = createCard("card2");

    queue.enqueue(card1);
    queue.enqueue(card2);

    // Wait for async execution
    await vi.waitFor(() => {
      expect(card1.profile?.probeStatus).toBe("detected");
      expect(card2.profile?.probeStatus).toBe("detected");
    });

    expect(card1.profile?.has4kAv1).toBe(true);
    expect(mockRequester.fetchText).toHaveBeenCalledTimes(2);
  });

  it("auto-retries up to 2 times on network failure then settles into error", async () => {
    (mockRequester.fetchText as any).mockRejectedValue(new Error("Network connection reset"));

    const updateSpy = vi.fn();
    const queue = new ProbeQueue({
      maxAutoRetries: 2,
      baseBackoffMs: 10,
      requester: mockRequester,
      cacheManager,
      onProfileUpdate: updateSpy,
    });

    const card = createCard("fail1");
    queue.enqueue(card);

    // Wait for retries to exhaust
    await vi.waitFor(
      () => {
        expect(card.profile?.probeStatus).toBe("error");
      },
      { timeout: 2000 }
    );

    // 1 initial attempt + 2 retries = 3 attempts total
    expect(mockRequester.fetchText).toHaveBeenCalledTimes(3);
    expect(card.profile?.error).toContain("Network connection reset");

    // Verify cache was NOT polluted with error
    expect(cacheManager.getProfile("fail1")).toBeUndefined();
  });

  it("manual retry clears error and re-enqueues card at high priority", async () => {
    // First fail
    (mockRequester.fetchText as any).mockRejectedValueOnce(new Error("Rate Limited"));
    (mockRequester.fetchText as any).mockRejectedValueOnce(new Error("Rate Limited"));
    (mockRequester.fetchText as any).mockRejectedValueOnce(new Error("Rate Limited"));

    const queue = new ProbeQueue({
      maxAutoRetries: 2,
      baseBackoffMs: 10,
      requester: mockRequester,
      cacheManager,
    });

    const card = createCard("retry1");
    queue.enqueue(card);

    await vi.waitFor(() => {
      expect(card.profile?.probeStatus).toBe("error");
    });

    // Now mock recovery on next call
    (mockRequester.fetchText as any).mockResolvedValue(validAv1Html);

    // User clicks error badge -> triggers retryManual
    queue.retryManual("retry1");

    await vi.waitFor(() => {
      expect(card.profile?.probeStatus).toBe("detected");
      expect(card.profile?.highestAv1Resolution).toBe("2160p");
    });
  });
});
