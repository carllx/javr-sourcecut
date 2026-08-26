import type { RenditionProfile, StorageAdapter } from "./types.js";

export const CACHE_STORAGE_KEY = "javr_eporner_av1_cache_v1";
export const CACHE_SCHEMA_VERSION = 1;
export const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

/**
 * Validates whether a cached profile has expired based on updatedAt and TTL.
 * Missing, non-numeric, or non-positive updatedAt is strictly treated as expired.
 */
export function isProfileExpired(
  profile: RenditionProfile,
  ttlMs: number = DEFAULT_CACHE_TTL_MS,
  now: number = Date.now()
): boolean {
  if (
    !profile ||
    typeof profile.updatedAt !== "number" ||
    isNaN(profile.updatedAt) ||
    profile.updatedAt <= 0
  ) {
    return true;
  }
  return now - profile.updatedAt > ttlMs;
}

export interface SerializedCache {
  version: number;
  profiles: Record<string, RenditionProfile>;
}

export class MemoryStorageAdapter implements StorageAdapter {
  private store = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : defaultValue;
  }

  set<T>(key: string, value: T): void {
    this.store.set(key, value);
  }

  delete(key: string): void {
    this.store.delete(key);
  }
}

export class TampermonkeyStorageAdapter implements StorageAdapter {
  async get<T>(key: string, defaultValue: T): Promise<T> {
    if (typeof GM_getValue !== "undefined") {
      return GM_getValue(key, defaultValue);
    }
    if (typeof localStorage !== "undefined") {
      const item = localStorage.getItem(key);
      if (item !== null) {
        try {
          return JSON.parse(item);
        } catch {
          return defaultValue;
        }
      }
    }
    return defaultValue;
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (typeof GM_setValue !== "undefined") {
      GM_setValue(key, value as any);
      return;
    }
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, JSON.stringify(value));
    }
  }

  async delete(key: string): Promise<void> {
    if (typeof GM_deleteValue !== "undefined") {
      GM_deleteValue(key);
      return;
    }
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(key);
    }
  }
}

export class RenditionCacheManager {
  private storage: StorageAdapter;
  private memoryCache = new Map<string, RenditionProfile>();
  private isLoaded = false;
  private ttlMs: number;

  constructor(storage?: StorageAdapter, ttlMs: number = DEFAULT_CACHE_TTL_MS) {
    this.storage = storage || new TampermonkeyStorageAdapter();
    this.ttlMs = ttlMs;
  }

  async loadCache(now: number = Date.now()): Promise<Map<string, RenditionProfile>> {
    if (this.isLoaded) {
      return this.memoryCache;
    }

    const raw = await this.storage.get<SerializedCache | null>(
      CACHE_STORAGE_KEY,
      null
    );

    this.memoryCache.clear();

    if (raw && raw.version === CACHE_SCHEMA_VERSION && raw.profiles) {
      for (const [id, profile] of Object.entries(raw.profiles)) {
        // Enforce cache integrity and TTL: only non-expired detected/no_av1 are loaded
        if (
          profile &&
          (profile.probeStatus === "detected" || profile.probeStatus === "no_av1") &&
          !isProfileExpired(profile, this.ttlMs, now)
        ) {
          this.memoryCache.set(id, profile);
        }
      }
    }

    this.isLoaded = true;
    return this.memoryCache;
  }

  getProfile(videoId: string, now: number = Date.now()): RenditionProfile | undefined {
    const profile = this.memoryCache.get(videoId);
    if (!profile) return undefined;

    if (isProfileExpired(profile, this.ttlMs, now)) {
      this.memoryCache.delete(videoId);
      return undefined;
    }

    return profile;
  }

  async saveProfile(profile: RenditionProfile): Promise<boolean> {
    // Strictly reject caching error or unknown status as per ADR-0002
    if (profile.probeStatus !== "detected" && profile.probeStatus !== "no_av1") {
      return false;
    }

    const withTimestamp: RenditionProfile = {
      ...profile,
      updatedAt: profile.updatedAt && profile.updatedAt > 0 ? profile.updatedAt : Date.now(),
    };

    this.memoryCache.set(profile.videoId, withTimestamp);
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    const serialized: SerializedCache = {
      version: CACHE_SCHEMA_VERSION,
      profiles: Object.fromEntries(this.memoryCache.entries()),
    };
    await this.storage.set(CACHE_STORAGE_KEY, serialized);
  }

  async clear(): Promise<void> {
    this.memoryCache.clear();
    if (this.storage.delete) {
      await this.storage.delete(CACHE_STORAGE_KEY);
    } else {
      await this.storage.set(CACHE_STORAGE_KEY, null);
    }
  }
}
