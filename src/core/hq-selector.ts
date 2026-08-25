import type { MediaRendition } from "../types.js";
import { compareCodecs } from "./proxy-selector.js";

/**
 * Selects the optimal high-quality rendition according to the strict priority:
 * 1. Highest publicly available resolution (maximum height).
 * 2. Within the same highest resolution tier, prioritize AV1 over H.264 / HEVC / other.
 * 3. Never downgrade resolution for AV1 (e.g. 2160p H264 > 1440p AV1).
 */
export function selectHqRendition(renditions: MediaRendition[]): MediaRendition {
  if (!renditions || renditions.length === 0) {
    throw new Error("No renditions available for high-quality selection");
  }

  // Filter renditions that have a valid directUrl
  const valid = renditions.filter((r) => Boolean(r.directUrl));
  if (valid.length === 0) {
    throw new Error("No renditions with valid directUrl available for HQ selection");
  }

  // 1. Group by highest resolution (height)
  const withHeight = valid.filter((r) => (r.height || 0) > 0);
  const pool = withHeight.length > 0 ? withHeight : valid;

  const maxHeight = Math.max(...pool.map((r) => r.height || 0));
  const topTier = pool.filter((r) => (r.height || 0) === maxHeight);

  // 2. Sort within highest tier by codec preference: AV1 > H264 > HEVC > other
  topTier.sort((a, b) => compareCodecs(a.vcodec, b.vcodec));

  return topTier[0];
}
