import type { ByteRangeFetchPlan, MP4Index, TimeRange } from "./types.js";
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
  transferredBytes: number;
  fullFileBytes: number;
  savingsPercent: number;
}

export async function runSelectiveFetch(
  params: SelectiveFetchParams
): Promise<SelectiveFetchResult> {
  const { sourceUrl, timeRange, outputClipPath, workDir, options = {} } = params;

  // 1. Probe MP4 Index (bounded head and optional tail probe)
  const index = await probeMP4Index(sourceUrl, options);

  // 2. Build structurally proven ByteRange Fetch Plan
  const plan = createByteRangeFetchPlan(index, timeRange, sourceUrl);

  // 3. Execute partial HTTP 206 fetch and extract clip via FFmpeg
  const extractResult = await extractClipFromPlan({
    plan,
    index,
    outputClipPath,
    workDir,
    fetchFn: options.fetchFn,
    onProgress: (transferred, total) => {
      if (options.onProgress && total > 0) {
        const percent = Math.min(100, Math.round((transferred / total) * 100));
        options.onProgress(percent, transferred, total);
      }
    },
  });

  const fullFileBytes = index.fileSize;
  const savingsPercent = Math.max(
    0,
    Math.round((1 - extractResult.bytesFetched / fullFileBytes) * 100)
  );

  return {
    outputClipPath: extractResult.outputClipPath,
    plan,
    index,
    probeResult: extractResult.probeResult,
    transferredBytes: extractResult.bytesFetched,
    fullFileBytes,
    savingsPercent,
  };
}
