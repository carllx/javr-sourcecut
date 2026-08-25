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

  // 1. Probe MP4 Index (2-stage capability + bounded head & tail probe)
  const indexProbeResult = await probeMP4Index(sourceUrl, options);
  const index = indexProbeResult.index;
  const fullFileBytes = index.fileSize;

  // 2. Build structurally proven ByteRange Fetch Plan
  const plan = createByteRangeFetchPlan(index, timeRange, sourceUrl);

  // 3. Pre-Fetch Network Budget Estimation
  const headEndByte = index.hasMoovAtStart
    ? index.moovOffset + index.moovSize - 1
    : Math.min(index.fileSize - 1, 1024);

  let expectedAdditionalMetadataBytes = 0;
  const hasCachedHead =
    indexProbeResult.cachedHead &&
    indexProbeResult.cachedHead.range.startByte === 0 &&
    indexProbeResult.cachedHead.range.endByte >= headEndByte;
  if (!hasCachedHead) {
    expectedAdditionalMetadataBytes += headEndByte + 1;
  }

  if (!index.hasMoovAtStart) {
    const moovStart = index.moovOffset;
    const moovEnd = index.moovOffset + index.moovSize - 1;
    const hasCachedTailMoov =
      indexProbeResult.cachedTail &&
      moovStart >= indexProbeResult.cachedTail.range.startByte &&
      moovEnd <= indexProbeResult.cachedTail.range.endByte;
    if (!hasCachedTailMoov) {
      expectedAdditionalMetadataBytes += index.moovSize;
    }
  }

  const expectedTotalNetworkBytes =
    indexProbeResult.totalProbeBytesTransferred +
    expectedAdditionalMetadataBytes +
    plan.totalBytesToFetch;

  const expectedTotalSavingsRatio = 1 - expectedTotalNetworkBytes / fullFileBytes;

  // 4. Strict Pre-Fetch Fail-Closed Budget Enforcement:
  // Must be provably partial across TOTAL expected network transfer before fetching media payload
  if (
    !plan.isProvablePartial ||
    expectedTotalNetworkBytes >= fullFileBytes ||
    expectedTotalSavingsRatio <= 0.05
  ) {
    throw new UnprovablePartialPlanError(
      `Plan is not provably partial for time range [${timeRange.startSeconds}s, ${timeRange.endSeconds}s]. Total expected network bytes (${expectedTotalNetworkBytes}B) exceeds budget or spans full file (${fullFileBytes}B). Refusing full-file fetch.`
    );
  }

  // 5. Execute partial HTTP 206 fetch and extract clip via FFmpeg
  const extractResult = await extractClipFromPlan({
    plan,
    index,
    outputClipPath,
    workDir,
    cachedHead: indexProbeResult.cachedHead,
    cachedTail: indexProbeResult.cachedTail,
    fetchFn: options.fetchFn,
    onProgress: (transferred, total) => {
      if (options.onProgress && total > 0) {
        const percent = Math.min(100, Math.round((transferred / total) * 100));
        options.onProgress(percent, transferred, total);
      }
    },
  });

  // 6. Total transferred network bytes includes all probing and extraction network transfers
  const totalTransferredBytes =
    indexProbeResult.totalProbeBytesTransferred + extractResult.bytesFetched;
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
