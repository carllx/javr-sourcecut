import type { MediaRendition, QualityTargetOptions, VideoCodec } from "../types.js";
import { compareCodecs } from "./proxy-selector.js";
import { CapabilityMismatchError } from "./mp4/types.js";

/**
 * Resolves candidates within the target quality tier.
 * Rules:
 * 1. If qualityTarget specifies height/resolution/formatId, only that tier is considered.
 * 2. If qualityTarget is omitted or "max", the highest discovered resolution (maximum height) is the target tier.
 * 3. Within the target tier, candidates are ranked with AV1 first, then other codecs.
 * 4. Lower resolution tiers are NEVER included in the candidate pool by default.
 */
export function getTargetTierCandidates(
  renditions: MediaRendition[],
  target?: QualityTargetOptions
): { targetHeight: number; candidates: MediaRendition[] } {
  if (!renditions || renditions.length === 0) {
    throw new Error("No renditions available for high-quality selection");
  }

  const valid = renditions.filter((r) => Boolean(r.directUrl));
  if (valid.length === 0) {
    throw new Error("No renditions with valid directUrl available for HQ selection");
  }

  let filtered = valid;

  // Explicit formatId
  if (target?.formatId) {
    filtered = filtered.filter((r) => r.formatId.toLowerCase() === target.formatId?.toLowerCase());
    if (filtered.length === 0) {
      throw new CapabilityMismatchError(
        `No rendition matching requested formatId "${target.formatId}" found.`
      );
    }
  }

  // Explicit height / resolution
  let targetHeight: number;
  if (target?.height && target.height > 0) {
    targetHeight = target.height;
    filtered = filtered.filter((r) => (r.height || 0) === targetHeight);
  } else if (target?.resolution) {
    const parsed = parseInt(target.resolution.replace(/\D/g, ""), 10);
    if (!isNaN(parsed) && parsed > 0) {
      targetHeight = parsed;
      filtered = filtered.filter((r) => (r.height || 0) === targetHeight);
    } else {
      targetHeight = Math.max(...valid.map((r) => r.height || 0));
      filtered = filtered.filter((r) => (r.height || 0) === targetHeight);
    }
  } else {
    // Default max quality: maximum discovered height
    targetHeight = Math.max(...valid.map((r) => r.height || 0));
    filtered = filtered.filter((r) => (r.height || 0) === targetHeight);
  }

  if (filtered.length === 0) {
    throw new CapabilityMismatchError(
      `No rendition available for target resolution tier ${targetHeight}p.`
    );
  }

  // Optional codec filter
  if (target?.codec) {
    const byCodec = filtered.filter((r) => r.vcodec === target.codec);
    if (byCodec.length > 0) {
      filtered = byCodec;
    }
  }

  // Rank within target tier: AV1 first, then H264, HEVC, other
  const candidates = [...filtered].sort((a, b) => compareCodecs(a.vcodec, b.vcodec));

  return { targetHeight, candidates };
}

/**
 * Pure synchronous selector picking the statically highest ranked rendition in target tier.
 */
export function selectHqRendition(
  renditions: MediaRendition[],
  target?: QualityTargetOptions
): MediaRendition {
  const { candidates } = getTargetTierCandidates(renditions, target);
  return candidates[0];
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
  targetHeight: number;
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
 * Discovers the highest-quality Direct MP4 rendition from the target resolution tier,
 * verifying live HTTP 206 Range capability in strict rank order (AV1 first, then same-tier alternatives).
 *
 * Never silently downgrades to a lower resolution tier if the target tier is inaccessible.
 */
export async function selectHighestPublicHqRendition(
  renditions: MediaRendition[],
  options?: {
    target?: QualityTargetOptions;
    fetchFn?: typeof fetch;
    onLog?: (msg: string) => void;
  }
): Promise<HqSelectionResult> {
  const { targetHeight, candidates } = getTargetTierCandidates(renditions, options?.target);
  const fetchFn = options?.fetchFn ?? fetch;
  const onLog = options?.onLog ?? (() => {});

  const attempts: HqCandidateProbeAttempt[] = [];
  let totalSelectionBytesTransferred = 0;

  for (const candidate of candidates) {
    onLog(
      `[Capability Probe] Verifying target tier candidate ${candidate.formatId} (${candidate.resolution}, ${candidate.vcodec.toUpperCase()})...`
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
        `[Capability Probe] Candidate ${candidate.formatId} rejected: HTTP ${httpStatus} is not 206 Partial Content (likely requires authentication/session access). Cancelled stream.`
      );
      attempts.push({
        formatId: candidate.formatId,
        resolution: candidate.resolution,
        height: candidate.height || 0,
        codec: candidate.vcodec,
        httpStatus,
        contentRange,
        accepted: false,
        reason: `HTTP ${httpStatus} is not 206 Partial Content (requires authentication or unsupported range)`,
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
      targetHeight,
      attempts,
      capabilitySelectionBytesTransferred: totalSelectionBytesTransferred,
    };
  }

  throw new CapabilityMismatchError(
    `All candidates at target resolution ${targetHeight}p failed live Range capability verification (e.g. login/session gated). Silent downgrade to lower resolutions is prohibited.`
  );
}
