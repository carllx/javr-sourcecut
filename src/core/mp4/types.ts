export interface TimeRange {
  startSeconds: number;
  endSeconds: number;
}

export interface ByteRange {
  startByte: number;
  endByte: number;
}

export interface SampleEntry {
  sampleIndex: number; // 0-indexed
  dts: number;         // Decode Timestamp in seconds
  pts: number;         // Presentation Timestamp in seconds
  duration: number;    // Duration in seconds
  isKeyframe: boolean; // True if sync sample (I-frame)
  size: number;        // Byte size of sample payload
  offset: number;      // Absolute byte offset in file
}

export interface TrackIndex {
  trackId: number;
  type: "video" | "audio" | "hint" | "other";
  timescale: number;
  duration: number; // in seconds
  codec: string;
  width?: number;
  height?: number;
  samples: SampleEntry[];
}

export interface MP4Index {
  fileSize: number;
  moovOffset: number;
  moovSize: number;
  timescale: number;
  duration: number; // in seconds
  tracks: TrackIndex[];
  hasMoovAtStart: boolean;
}

export interface CachedBufferWithRange {
  buffer: Buffer;
  range: ByteRange;
}

export interface MP4IndexProbeResult {
  index: MP4Index;
  capabilityProbeBytesTransferred: number;
  headProbeBytesTransferred: number;
  tailProbeBytesTransferred: number;
  totalProbeBytesTransferred: number;
  etag?: string;
  cachedHead?: CachedBufferWithRange;
  cachedTail?: CachedBufferWithRange;
}


export interface ByteRangeFetchPlan {
  sourceUrl: string;
  targetTimeRange: TimeRange;
  keyframeAlignedTimeRange: TimeRange;
  videoByteRange: ByteRange;
  audioByteRange?: ByteRange;
  combinedByteRange: ByteRange;
  segmentRanges: ByteRange[];
  totalBytesToFetch: number;
  fullFileBytes: number;
  savingsRatio: number;
  isProvablePartial: boolean;
  moovByteRange?: ByteRange;
}

export interface MultiSegmentFetchPlan {
  sourceUrl: string;
  targetTimeRanges: TimeRange[];
  segmentPlans: ByteRangeFetchPlan[];
  discreteByteRanges: ByteRange[];
  totalBytesToFetch: number;
  fullFileBytes: number;
  savingsRatio: number;
  isProvablePartial: boolean;
  moovByteRange?: ByteRange;
}

export class UnprovablePartialPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnprovablePartialPlanError";
  }
}

export class CapabilityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityMismatchError";
  }
}

export class Http206RequiredError extends CapabilityMismatchError {
  constructor(message: string) {
    super(message);
    this.name = "Http206RequiredError";
  }
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class RenditionVersionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenditionVersionMismatchError";
  }
}

export class IncompatibleConcatSegmentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompatibleConcatSegmentsError";
  }
}

export interface LedgerRenditionIdentity {
  provider: string;
  providerAssetId: string;
  formatId: string;
  fullFileBytes: number;
  etag?: string;
  lastModified?: string;
}

export interface LedgerChunkEntry {
  chunkId: string;
  range: ByteRange;
  byteLength: number;
  sha256?: string;
  filePath: string;
  etag?: string;
  status: "completed" | "failed";
  transferredNetworkBytes: number;
  completedAt: string;
}

export interface TransferLedger {
  version: number;
  logicalRenditionId: string;
  rendition: LedgerRenditionIdentity;
  transactions: LedgerChunkEntry[];
  cumulativeHistoricalSpentBytes?: number; // Monotonic total of all network bytes spent for this logical transfer
  cumulativeFailedBytes: number;
  updatedAt: string;
}

export interface TransferBudgetOptions {
  budgetMultiplier?: number; // default 1.5, >= 1.0
}


