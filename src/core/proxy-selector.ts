import type { MediaRendition } from "../types.js";

/**
 * Selects the optimal lightweight proxy rendition according to the priority:
 * 1. ~480p AV1
 * 2. ~480p other codecs (H.264, etc.)
 * 3. Nearest practical low-resolution Direct MP4 (< 720p)
 * 4. Lowest available resolution if only >= 720p exists.
 */
export function selectProxyRendition(renditions: MediaRendition[]): MediaRendition {
  if (!renditions || renditions.length === 0) {
    throw new Error("No renditions available for proxy selection");
  }

  // 1. Check for 480p AV1
  const av1_480 = renditions.find((r) => r.height === 480 && r.vcodec === "av1");
  if (av1_480) {
    return av1_480;
  }

  // 2. Check for 480p (other codecs)
  const other_480 = renditions.find((r) => r.height === 480);
  if (other_480) {
    return other_480;
  }

  // 3. Nearest low-res (< 720p), pick the one closest to 480p (e.g. 360p > 240p)
  const lowRes = renditions.filter((r) => r.height > 0 && r.height < 720);
  if (lowRes.length > 0) {
    // Sort by distance to 480 ascending; tie-break: av1 first, higher height first
    lowRes.sort((a, b) => {
      const distA = Math.abs(a.height - 480);
      const distB = Math.abs(b.height - 480);
      if (distA !== distB) {
        return distA - distB;
      }
      if (a.vcodec === "av1" && b.vcodec !== "av1") return -1;
      if (a.vcodec !== "av1" && b.vcodec === "av1") return 1;
      return b.height - a.height;
    });
    return lowRes[0];
  }

  // 4. Fallback to lowest available height
  const sorted = [...renditions].sort((a, b) => {
    if (a.height !== b.height) {
      return a.height - b.height;
    }
    if (a.vcodec === "av1" && b.vcodec !== "av1") return -1;
    if (a.vcodec !== "av1" && b.vcodec === "av1") return 1;
    return 0;
  });

  return sorted[0];
}
