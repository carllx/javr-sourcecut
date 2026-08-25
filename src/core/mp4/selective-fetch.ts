import type { ByteRangeFetchPlan, MP4Index, MP4IndexProbeResult, TimeRange } from "./types.js";
import { UnprovablePartialPlanError } from "./types.js";
import { probeMP4Index, type IndexProbeOptions } from "./index-prober.js";
import { createByteRangeFetchPlan } from "./fetch-plan.js";
import { extractClipFromPlan, type ExtractClipResult } from "./extractor.js";
import type { FfprobeProbeResult } from "../verifier.js";

export interface SelectiveFetchParams {
  sourceUrl: string;
  timeRange: TimeRange;
  outputClipPath: string;
  workDir: string;
  options?: IndexProbeOptions & {
    onProgress?: (percent: number, transferredBytes: number, totalExpectedBytes: number) => void;
  };
}

export interface SelectiveFetchResult {
  outputClipPath: string;
  plan: ByteRangeFetchPlan;
  index: MP4Index;
  probeResult: FfprobeProbeResult;
  indexProbeResult: MP4IndexProbeResult;
  transferredBytes: number;
  fullFileBytes: number;
  savingsPercent: number;
}

export async function runSelectiveFetch(
  params: SelectiveFetchParams
): Promise<SelectiveFetchResult> {
  const { sourceUrl, timeRange, outputClipPath, workDir, options = {} } = params;

  // 1. Probe MP4 Index (bounded head and optional tail probe)
  const indexProbeResult = await probeMP4Index(sourceUrl, options);
  const index = indexProbeResult.index;

  // 2. Build structurally proven ByteRange Fetch Plan
  const plan = createByteRangeFetchPlan(index, timeRange, sourceUrl);

  // 3. Strict Fail-Closed Enforcement: Must be provably partial
  if (!plan.isProvablePartial) {
    throw new UnprovablePartialPlanError(
      `Plan is not provably partial for time range [${timeRange.startSeconds}s, ${timeRange.endSeconds}s]. Total bytes to fetch (${plan.totalBytesToFetch}B) spans full file (${plan.fullFileBytes}B) or provides zero byte savings. Refusing full-file fetch.`
    );
  }

  // 4. Execute partial HTTP 206 fetch and extract clip via FFmpeg
  const extractResult = await extractClipFromPlan({
    plan,
    index,
    outputClipPath,
    workDir,
    cachedHeadBuffer: indexProbeResult.cachedHeadBuffer,
    cachedTailBuffer: indexProbeResult.cachedTailBuffer,
    fetchFn: options.fetchFn,
    onProgress: (transferred, total) => {
      if (options.onProgress && total > 0) {
        const percent = Math.min(100, Math.round((transferred / total) * 100));
        options.onProgress(percent, transferred, total);
      }
    },
  });

  // 5. Total transferred network bytes includes all probing and extraction network transfers
  const totalTransferredBytes =
    indexProbeResult.totalProbeBytesTransferred + extractResult.bytesFetched;
  const fullFileBytes = index.fileSize;
  const savingsPercent = Math.max(
    0,
    Math.round((1 - totalTransferredBytes / fullFileBytes) * 100)
  );

  return {
    outputClipPath: extractResult.outputClipPath,
    plan,
    index,
    probeResult: extractResult.probeResult,
    indexProbeResult,
    transferredBytes: totalTransferredBytes,
    fullFileBytes,
    savingsPercent,
  };
}
