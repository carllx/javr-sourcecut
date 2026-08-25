import type { MediaRendition, VideoCodec } from "../types.js";

export function getCodecWeight(codec: VideoCodec): number {
  switch (codec) {
    case "av1":
      return 3;
    case "h264":
      return 2;
    case "hevc":
      return 1;
    default:
      return 0;
  }
}

export function compareCodecs(a: VideoCodec, b: VideoCodec): number {
  return getCodecWeight(b) - getCodecWeight(a);
}

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

  // 2. Check for 480p (other codecs, preferring H.264 over other)
  const exact480 = renditions.filter((r) => r.height === 480);
  if (exact480.length > 0) {
    exact480.sort((a, b) => compareCodecs(a.vcodec, b.vcodec));
    return exact480[0];
  }

  // 3. Nearest low-res (< 720p), pick closest to 480p, tie-break by codec weight then height
  const lowRes = renditions.filter((r) => r.height > 0 && r.height < 720);
  if (lowRes.length > 0) {
    lowRes.sort((a, b) => {
      const distA = Math.abs(a.height - 480);
      const distB = Math.abs(b.height - 480);
      if (distA !== distB) {
        return distA - distB;
      }
      const codecDiff = compareCodecs(a.vcodec, b.vcodec);
      if (codecDiff !== 0) return codecDiff;
      return b.height - a.height;
    });
    return lowRes[0];
  }

  // 4. Fallback to lowest available height tier
  const sorted = [...renditions].sort((a, b) => {
    if (a.height !== b.height) {
      return a.height - b.height;
    }
    return compareCodecs(a.vcodec, b.vcodec);
  });

  return sorted[0];
}
