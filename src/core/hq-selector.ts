import type { MediaRendition, VideoCodec } from "../types.js";
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

export interface HqCandidateProbeAttempt {
  formatId: string;
  resolution: string;
  height: number;
  codec: VideoCodec;
  httpStatus?: number;
  contentRange?: string;
  accepted: boolean;
  reason?: string;
  bodyBytesConsumed: number;
}

export interface HqSelectionResult {
  selected: MediaRendition;
  attempts: HqCandidateProbeAttempt[];
  capabilitySelectionBytesTransferred: number;
}

async function cancelResponseBody(res: Response): Promise<void> {
  try {
    if (res.body && typeof res.body.cancel === "function") {
      await res.body.cancel();
    }
  } catch {
    // Ignore cancellation errors
  }
}

/**
 * Discovers the highest publicly available Direct MP4 rendition from a list of renditions,
 * verifying live HTTP 206 Range capability in strict rank order (highest resolution first,
 * then AV1 within the same tier).
 *
 * Implements fail-closed immediate cancellation of response streams for rejected candidates.
 */
export async function selectHighestPublicHqRendition(
  renditions: MediaRendition[],
  options?: {
    fetchFn?: typeof fetch;
    onLog?: (msg: string) => void;
  }
): Promise<HqSelectionResult> {
  const ranked = groupAndRankHqRenditions(renditions);
  const fetchFn = options?.fetchFn ?? fetch;
  const onLog = options?.onLog ?? (() => {});

  const attempts: HqCandidateProbeAttempt[] = [];
  let totalSelectionBytesTransferred = 0;

  for (const candidate of ranked) {
    onLog(
      `[Capability Probe] Verifying candidate ${candidate.formatId} (${candidate.resolution}, ${candidate.vcodec.toUpperCase()})...`
    );

    let res: Response;
    try {
      res = await fetchFn(candidate.directUrl, {
        headers: { Range: "bytes=0-0" },
        redirect: "follow",
      });
    } catch (err: any) {
      onLog(
        `[Capability Probe] Candidate ${candidate.formatId} network error: ${err.message}. Skipping.`
      );
      attempts.push({
        formatId: candidate.formatId,
        resolution: candidate.resolution,
        height: candidate.height || 0,
        codec: candidate.vcodec,
        accepted: false,
        reason: `Network fetch failed: ${err.message}`,
        bodyBytesConsumed: 0,
      });
      continue;
    }

    const httpStatus = res.status;
    const contentRange = res.headers.get("content-range") || undefined;

    // Fail-closed check 1: Must be HTTP 206
    if (httpStatus !== 206) {
      await cancelResponseBody(res);
      onLog(
        `[Capability Probe] Candidate ${candidate.formatId} rejected: HTTP ${httpStatus} is not 206 Partial Content. Cancelled stream.`
      );
      attempts.push({
        formatId: candidate.formatId,
        resolution: candidate.resolution,
        height: candidate.height || 0,
        codec: candidate.vcodec,
        httpStatus,
        contentRange,
        accepted: false,
        reason: `HTTP ${httpStatus} is not 206 Partial Content`,
        bodyBytesConsumed: 0,
      });
      continue;
    }

    // Fail-closed check 2: Must have valid Content-Range: bytes 0-0/TOTAL
    if (!contentRange || !/^bytes\s+0-0\/\d+$/i.test(contentRange.trim())) {
      await cancelResponseBody(res);
      onLog(
        `[Capability Probe] Candidate ${candidate.formatId} rejected: Invalid or missing Content-Range header ("${contentRange ?? ""}"). Cancelled stream.`
      );
      attempts.push({
        formatId: candidate.formatId,
        resolution: candidate.resolution,
        height: candidate.height || 0,
        codec: candidate.vcodec,
        httpStatus,
        contentRange,
        accepted: false,
        reason: `Invalid or missing Content-Range header: "${contentRange ?? ""}"`,
        bodyBytesConsumed: 0,
      });
      continue;
    }

    // Read exactly 1 byte body
    let body: ArrayBuffer;
    try {
      body = await res.arrayBuffer();
    } catch (err: any) {
      await cancelResponseBody(res);
      attempts.push({
        formatId: candidate.formatId,
        resolution: candidate.resolution,
        height: candidate.height || 0,
        codec: candidate.vcodec,
        httpStatus,
        contentRange,
        accepted: false,
        reason: `Failed to read response body: ${err.message}`,
        bodyBytesConsumed: 0,
      });
      continue;
    }

    const bodyBytesConsumed = body.byteLength;
    totalSelectionBytesTransferred += bodyBytesConsumed;

    // Fail-closed check 3: Body must be exactly 1 byte for Range: bytes=0-0
    if (bodyBytesConsumed !== 1) {
      onLog(
        `[Capability Probe] Candidate ${candidate.formatId} rejected: Expected 1 byte body, received ${bodyBytesConsumed} bytes.`
      );
      attempts.push({
        formatId: candidate.formatId,
        resolution: candidate.resolution,
        height: candidate.height || 0,
        codec: candidate.vcodec,
        httpStatus,
        contentRange,
        accepted: false,
        reason: `Expected 1 byte body for Range: bytes=0-0, received ${bodyBytesConsumed} bytes`,
        bodyBytesConsumed,
      });
      continue;
    }

    // Candidate accepted
    onLog(
      `[Capability Probe] Candidate ${candidate.formatId} verified with HTTP 206 Range capability (${contentRange.trim()}).`
    );
    attempts.push({
      formatId: candidate.formatId,
      resolution: candidate.resolution,
      height: candidate.height || 0,
      codec: candidate.vcodec,
      httpStatus,
      contentRange,
      accepted: true,
      bodyBytesConsumed: 1,
    });

    return {
      selected: candidate,
      attempts,
      capabilitySelectionBytesTransferred: totalSelectionBytesTransferred,
    };
  }

  throw new CapabilityMismatchError(
    "No publicly available Direct MP4 rendition with verified HTTP 206 Range capability found."
  );
}
