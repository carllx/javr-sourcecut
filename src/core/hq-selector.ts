import type { MediaRendition } from "../types.js";
import { compareCodecs } from "./proxy-selector.js";
import { CapabilityMismatchError } from "./mp4/types.js";

/**
 * Ranks renditions strictly by:
 * 1. Highest resolution (height descending)
 * 2. Within the same resolution tier, prioritize AV1 > H264 > HEVC > other
 * 3. Never downgrade resolution for AV1 (e.g. 2160p H264 > 1440p AV1).
 */
export function groupAndRankHqRenditions(renditions: MediaRendition[]): MediaRendition[] {
  if (!renditions || renditions.length === 0) {
    throw new Error("No renditions available for high-quality selection");
  }

  const valid = renditions.filter((r) => Boolean(r.directUrl));
  if (valid.length === 0) {
    throw new Error("No renditions with valid directUrl available for HQ selection");
  }

  return [...valid].sort((a, b) => {
    const heightA = a.height || 0;
    const heightB = b.height || 0;
    if (heightA !== heightB) {
      return heightB - heightA;
    }
    return compareCodecs(a.vcodec, b.vcodec);
  });
}

/**
 * Pure synchronous selector picking the statically highest ranked rendition.
 */
export function selectHqRendition(renditions: MediaRendition[]): MediaRendition {
  const ranked = groupAndRankHqRenditions(renditions);
  return ranked[0];
}

/**
 * Discovers the highest publicly available Direct MP4 rendition from a list of renditions,
 * verifying live HTTP 206 Range capability in strict rank order (highest resolution first,
 * then AV1 within the same tier).
 */
export async function selectHighestPublicHqRendition(
  renditions: MediaRendition[],
  options?: {
    fetchFn?: typeof fetch;
    onLog?: (msg: string) => void;
  }
): Promise<MediaRendition> {
  const ranked = groupAndRankHqRenditions(renditions);
  const fetchFn = options?.fetchFn ?? fetch;
  const onLog = options?.onLog ?? (() => {});

  for (const candidate of ranked) {
    onLog(`[Capability Probe] Verifying candidate ${candidate.formatId} (${candidate.resolution}, ${candidate.vcodec.toUpperCase()})...`);
    try {
      const res = await fetchFn(candidate.directUrl, {
        headers: { Range: "bytes=0-0" },
        redirect: "follow",
      });

      if (res.status === 206) {
        const contentRange = res.headers.get("content-range");
        if (contentRange && /^bytes\s+0-0\/\d+$/i.test(contentRange.trim())) {
          const body = await res.arrayBuffer();
          if (body.byteLength === 1) {
            onLog(
              `[Capability Probe] Candidate ${candidate.formatId} verified with HTTP 206 Range capability (${contentRange.trim()}).`
            );
            return candidate;
          }
        }
      }
      onLog(
        `[Capability Probe] Candidate ${candidate.formatId} is not a publicly accessible Direct MP4 with Range capability (HTTP status ${res.status}). Skipping.`
      );
    } catch (err: any) {
      onLog(
        `[Capability Probe] Candidate ${candidate.formatId} capability probe error: ${err.message}. Skipping.`
      );
    }
  }

  throw new CapabilityMismatchError(
    "No publicly available Direct MP4 rendition with verified HTTP 206 Range capability found."
  );
}
