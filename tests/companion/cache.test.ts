import { describe, it, expect, beforeEach } from "vitest";
import {
  RenditionCacheManager,
  MemoryStorageAdapter,
  CACHE_STORAGE_KEY,
} from "../../companion/src/cache.js";
import type { RenditionProfile } from "../../companion/src/types.js";

describe("Companion Cache Manager", () => {
  let storage: MemoryStorageAdapter;
  let cacheManager: RenditionCacheManager;

  beforeEach(() => {
    storage = new MemoryStorageAdapter();
    cacheManager = new RenditionCacheManager(storage);
  });

  it("persists valid detected AV1 profiles", async () => {
    const profile: RenditionProfile = {
      videoId: "v100",
      sourceUrl: "https://www.eporner.com/video-v100/",
      maxResolution: "4K",
      av1Resolutions: ["2160p", "1080p"],
      highestAv1Resolution: "2160p",
      has4kAv1: true,
      probeStatus: "detected",
      updatedAt: Date.now(),
    };

    const saved = await cacheManager.saveProfile(profile);
    expect(saved).toBe(true);

    const loaded = cacheManager.getProfile("v100");
    expect(loaded).toEqual(profile);

    // Create new manager with same storage to verify persistence
    const freshManager = new RenditionCacheManager(storage);
    await freshManager.loadCache();
    expect(freshManager.getProfile("v100")).toEqual(profile);
  });

  it("persists verified NO AV1 profiles", async () => {
    const profile: RenditionProfile = {
      videoId: "v200",
      sourceUrl: "https://www.eporner.com/video-v200/",
      maxResolution: "4K",
      av1Resolutions: [],
      highestAv1Resolution: null,
      has4kAv1: false,
      probeStatus: "no_av1",
      updatedAt: Date.now(),
    };

    const saved = await cacheManager.saveProfile(profile);
    expect(saved).toBe(true);
    expect(cacheManager.getProfile("v200")).toEqual(profile);
  });

  it("STRICT INTEGRITY: refuses to persist error or unknown profiles", async () => {
    const errorProfile: RenditionProfile = {
      videoId: "err1",
      sourceUrl: "https://www.eporner.com/video-err1/",
      maxResolution: "unknown",
      av1Resolutions: [],
      highestAv1Resolution: null,
      has4kAv1: false,
      probeStatus: "error",
      error: "Timeout 504",
      updatedAt: Date.now(),
    };

    const unknownProfile: RenditionProfile = {
      videoId: "unk1",
      sourceUrl: "https://www.eporner.com/video-unk1/",
      maxResolution: "unknown",
      av1Resolutions: [],
      highestAv1Resolution: null,
      has4kAv1: false,
      probeStatus: "unknown",
      updatedAt: Date.now(),
    };

    expect(await cacheManager.saveProfile(errorProfile)).toBe(false);
    expect(await cacheManager.saveProfile(unknownProfile)).toBe(false);

    expect(cacheManager.getProfile("err1")).toBeUndefined();
    expect(cacheManager.getProfile("unk1")).toBeUndefined();

    // Verify storage remained empty
    const raw = storage.get(CACHE_STORAGE_KEY, null);
    expect(raw).toBeNull();
  });
});
