import type {
  ByteRangeFetchPlan,
  MP4Index,
  MP4IndexProbeResult,
  MultiSegmentFetchPlan,
  TimeRange,
  LedgerRenditionIdentity,
} from "./types.js";
import { UnprovablePartialPlanError } from "./types.js";
import { probeMP4Index, type IndexProbeOptions } from "./index-prober.js";
import { createByteRangeFetchPlan, createMultiSegmentFetchPlan } from "./fetch-plan.js";
import { extractClipFromPlan } from "./extractor.js";
import { TransferLedgerManager } from "./ledger.js";
import { TransferBudgetTracker } from "./budget.js";
import type { FfprobeProbeResult } from "../verifier.js";

export interface SelectiveFetchParams {
  sourceUrl: string;
  timeRange?: TimeRange;
  timeRanges?: TimeRange[];
  outputClipPath: string;
  workDir: string;
  renditionIdentity?: LedgerRenditionIdentity;
  options?: IndexProbeOptions & {
    budgetMultiplier?: number;
    ledgerManager?: TransferLedgerManager;
    maxChunkSize?: number;
    onProgress?: (percent: number, transferredBytes: number, totalExpectedBytes: number) => void;
    onProbeBytesTransferred?: (bytes: number) => void;
    onDataBytesTransferred?: (bytes: number) => void;
  };
}


export interface SelectiveFetchResult {
  outputClipPath: string;
  plan: ByteRangeFetchPlan;
  multiPlan?: MultiSegmentFetchPlan;
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
  const {
    sourceUrl,
    timeRange,
    timeRanges: explicitTimeRanges,
    outputClipPath,
    workDir,
    renditionIdentity,
    options = {},
  } = params;

  const targetSegments: TimeRange[] =
    explicitTimeRanges && explicitTimeRanges.length > 0
      ? explicitTimeRanges
      : timeRange
        ? [timeRange]
        : [];

  if (targetSegments.length === 0) {
    throw new UnprovablePartialPlanError("No target time range specified for selective fetch.");
  }

  // 1. Initialize Transfer Ledger & Pre-Probe Budget Tracker before issuing probe traffic
  let ledgerManager = options.ledgerManager;
  if (!ledgerManager && renditionIdentity) {
    ledgerManager = new TransferLedgerManager({
      workspaceDir: workDir,
      rendition: renditionIdentity,
    });
    await ledgerManager.loadOrCreateLedger();
  }

  let budgetTracker: TransferBudgetTracker | undefined = undefined;
  if (ledgerManager && ledgerManager.estimatedBudgetBytes) {
    budgetTracker = new TransferBudgetTracker({
      estimatedBytes: ledgerManager.estimatedBudgetBytes,
      budgetMultiplier: options.budgetMultiplier ?? 1.5,
      historicalTransferredBytes: ledgerManager.cumulativeHistoricalSpentBytes,
    });
  }

  // 2. Probe MP4 Index (2-stage capability + bounded head & tail probe with incremental budget & spend tracking)
  const indexProbeResult = await probeMP4Index(sourceUrl, {
    ...options,
    budgetTracker,
    ledgerManager,
  });
  const index = indexProbeResult.index;
  const fullFileBytes = index.fileSize;

  // 3. Build structurally proven Fetch Plan
  const multiPlan =
    targetSegments.length > 1
      ? createMultiSegmentFetchPlan(index, targetSegments, sourceUrl)
      : undefined;
  const singlePlan =
    multiPlan === undefined
      ? createByteRangeFetchPlan(index, targetSegments[0], sourceUrl)
      : multiPlan.segmentPlans[0];

  const activePlan: ByteRangeFetchPlan | MultiSegmentFetchPlan = multiPlan || singlePlan;

  // 4. Pre-Fetch Network Budget Estimation
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
    activePlan.totalBytesToFetch;

  const expectedTotalSavingsRatio = 1 - expectedTotalNetworkBytes / fullFileBytes;

  // Strict Pre-Fetch Fail-Closed Budget Enforcement:
  // Must be provably partial across TOTAL expected network transfer before fetching media payload
  if (
    !activePlan.isProvablePartial ||
    expectedTotalNetworkBytes >= fullFileBytes ||
    expectedTotalSavingsRatio <= 0.05
  ) {
    const segDescr = targetSegments
      .map((s) => `[${s.startSeconds}s, ${s.endSeconds}s]`)
      .join(", ");
    throw new UnprovablePartialPlanError(
      `Plan is not provably partial for time ranges ${segDescr}. Total expected network bytes (${expectedTotalNetworkBytes}B) exceeds budget or spans full file (${fullFileBytes}B). Refusing full-file fetch.`
    );
  }

  // 5. Update Ledger Envelope & Authoritative Identity
  if (ledgerManager) {
    await ledgerManager.updateEstimatedBudgetBytes(expectedTotalNetworkBytes);
    await ledgerManager.updateAuthoritativeFileSize(fullFileBytes);
    if (indexProbeResult.etag) {
      await ledgerManager.updateRenditionEtag(indexProbeResult.etag);
    }
  }

  if (!budgetTracker) {
    budgetTracker = new TransferBudgetTracker({
      estimatedBytes: expectedTotalNetworkBytes,
      budgetMultiplier: options.budgetMultiplier ?? 1.5,
      historicalTransferredBytes: ledgerManager?.cumulativeHistoricalSpentBytes || 0,
    });
  }


  // 6. Execute partial HTTP 206 fetch and extract clip via FFmpeg
  const extractResult = await extractClipFromPlan({
    plan: activePlan,
    index,
    outputClipPath,
    workDir,
    cachedHead: indexProbeResult.cachedHead,
    cachedTail: indexProbeResult.cachedTail,
    ledgerManager,
    budgetTracker,
    maxChunkSize: options.maxChunkSize,
    expectedTotalFileSize: fullFileBytes,
    expectedEtag: indexProbeResult.etag || renditionIdentity?.etag,
    fetchFn: options.fetchFn,
    onProgress: (transferred, total) => {
      if (options.onProgress && total > 0) {
        const percent = Math.min(100, Math.round((transferred / total) * 100));
        options.onProgress(percent, transferred, total);
      }
    },
  });


  // 7. Total transferred network bytes includes all probing and extraction network transfers
  const totalTransferredBytes =
    indexProbeResult.totalProbeBytesTransferred + extractResult.bytesFetched;
  const savingsPercent = Math.max(
    0,
    Math.round((1 - totalTransferredBytes / fullFileBytes) * 100)
  );

  return {
    outputClipPath: extractResult.outputClipPath,
    plan: singlePlan,
    multiPlan,
    index,
    probeResult: extractResult.probeResult,
    indexProbeResult,
    transferredBytes: totalTransferredBytes,
    fullFileBytes,
    savingsPercent,
  };
}
