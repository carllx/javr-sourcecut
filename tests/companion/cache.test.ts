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

  describe("Cache TTL (7 Days) & Expiration Semantics", () => {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const now = 1700000000000;

    it("fresh cache hit: retrieves valid entry within TTL", async () => {
      const profile: RenditionProfile = {
        videoId: "fresh1",
        sourceUrl: "https://www.eporner.com/video-fresh1/",
        maxResolution: "4K",
        av1Resolutions: ["2160p"],
        highestAv1Resolution: "2160p",
        has4kAv1: true,
        probeStatus: "detected",
        updatedAt: now - (SEVEN_DAYS_MS - 1000), // 1 second before expiry
      };

      await cacheManager.saveProfile(profile);
      const hit = cacheManager.getProfile("fresh1", now);
      expect(hit).toBeDefined();
      expect(hit?.videoId).toBe("fresh1");
    });

    it("expired cache miss: evicts detected profile older than TTL", async () => {
      const profile: RenditionProfile = {
        videoId: "exp1",
        sourceUrl: "https://www.eporner.com/video-exp1/",
        maxResolution: "4K",
        av1Resolutions: ["2160p"],
        highestAv1Resolution: "2160p",
        has4kAv1: true,
        probeStatus: "detected",
        updatedAt: now - (SEVEN_DAYS_MS + 1000), // 1 second after expiry
      };

      await cacheManager.saveProfile(profile);
      // Profile is expired at `now`
      const miss = cacheManager.getProfile("exp1", now);
      expect(miss).toBeUndefined();

      // Subsequent get without custom now should also be undefined
      expect(cacheManager.getProfile("exp1", now)).toBeUndefined();
    });

    it("NO AV1 expiration: confirmed NO AV1 expires after TTL so capability is re-checked", async () => {
      const noAv1Profile: RenditionProfile = {
        videoId: "noav1-exp",
        sourceUrl: "https://www.eporner.com/video-noav1-exp/",
        maxResolution: "4K",
        av1Resolutions: [],
        highestAv1Resolution: null,
        has4kAv1: false,
        probeStatus: "no_av1",
        updatedAt: now - (SEVEN_DAYS_MS + 5000),
      };

      await cacheManager.saveProfile(noAv1Profile);
      const miss = cacheManager.getProfile("noav1-exp", now);
      expect(miss).toBeUndefined();
    });

    it("missing or invalid updatedAt: treated as expired and not trusted", async () => {
      // Simulate raw cache with missing or malformed updatedAt
      storage.set(CACHE_STORAGE_KEY, {
        version: 1,
        profiles: {
          malformed1: {
            videoId: "malformed1",
            sourceUrl: "https://www.eporner.com/video-malformed1/",
            maxResolution: "4K",
            av1Resolutions: ["2160p"],
            highestAv1Resolution: "2160p",
            has4kAv1: true,
            probeStatus: "detected",
            // missing updatedAt
          },
          malformed2: {
            videoId: "malformed2",
            sourceUrl: "https://www.eporner.com/video-malformed2/",
            maxResolution: "4K",
            av1Resolutions: [],
            highestAv1Resolution: null,
            has4kAv1: false,
            probeStatus: "no_av1",
            updatedAt: 0, // invalid timestamp
          },
          malformed3: {
            videoId: "malformed3",
            sourceUrl: "https://www.eporner.com/video-malformed3/",
            maxResolution: "4K",
            av1Resolutions: ["2160p"],
            highestAv1Resolution: "2160p",
            has4kAv1: true,
            probeStatus: "detected",
            updatedAt: "invalid" as any,
          },
        },
      });

      const freshManager = new RenditionCacheManager(storage);
      await freshManager.loadCache(now);

      expect(freshManager.getProfile("malformed1", now)).toBeUndefined();
      expect(freshManager.getProfile("malformed2", now)).toBeUndefined();
      expect(freshManager.getProfile("malformed3", now)).toBeUndefined();
    });
  });
});
