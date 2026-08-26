export type VideoCodec = "av1" | "h264" | "hevc" | "other";

export interface MediaRendition {
  formatId: string;
  resolution: string; // e.g. "480p", "1080p", "2160p"
  height: number;
  fps?: number;
  vcodec: VideoCodec;
  acodec?: string;
  directUrl: string;
  contentLength?: number;
  formattedSize?: string;
  supportsRange?: boolean;
}

export interface PerformerIdentity {
  preferredName: string;
  aliases?: string[];
  hints?: string[];
}

export type CandidateProvenance =
  | "observed-title"
  | "source-url"
  | "observed-filename"
  | "declared-hint"
  | "manual"
  | "external-authority";

export interface CatalogCandidate {
  canonical: string;
  hyphenated: string;
  raw: string;
  provenance: CandidateProvenance;
  confidence: "high" | "medium" | "low";
}

export interface SourceDescriptor {
  provider: "eporner" | "astalavr" | "pikpak";
  providerAssetId: string;
  sourceUrl: string;
  rawTitle: string;
  declaredPerformers: (string | PerformerIdentity)[];
  observedFilenames?: string[];
  durationSeconds?: number;
  renditions: MediaRendition[];
}

export interface ProgressiveMediaIdentity {
  provider: string;
  providerAssetId: string;
  observedTitle: string;
  observedFilenames?: string[];
  canonicalCatalogId?: string; // e.g. "WAVR110"
  catalogCandidates?: CatalogCandidate[];
  workSearchAliases: string[];       // Work-identity aliases (canonical, hyphenated, providerAssetId, candidates)
  performerSearchAliases: string[];  // Performer-identity aliases (preferred names, aliases)
  searchAliases: string[];           // Unified search and indexing list (work + performer aliases)
  performers: PerformerIdentity[];
  confidence: "high" | "medium" | "fallback";
  provenance?: CandidateProvenance;
  baseName: string;
}

export type DuplicateStatus = "not-seen" | "in-progress" | "completed";

export interface DuplicatePreflightResult {
  status: DuplicateStatus;
  matchedJob?: JobState;
  matchedReason?: string;
  auxiliaryClues?: string[];
}

export type JobStatus =
  | "created"
  | "discovering"
  | "proxy-downloading"
  | "waiting-for-llc"
  | "needs-user-intervention"
  | "completed"
  | "failed";

export interface QualityTargetOptions {
  height?: number;
  resolution?: string; // e.g. "2160p", "1440p", "1080p", "720p"
  codec?: VideoCodec;
  formatId?: string;
}

export interface JobQualityTarget {
  targetHeight?: number;
  preferredCodec?: VideoCodec;
  requestedResolution?: string;
  requestedFormatId?: string;
  requestedCodec?: VideoCodec;
  explicitOverride?: boolean;
  reason?: string;
}

export interface JobState {
  jobId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  sourceUrl: string;
  provider: string;
  providerAssetId: string;
  identity: ProgressiveMediaIdentity;
  workspaceDir: string;
  selectedProxy: MediaRendition;
  proxyPath: string;
  expectedLlcPath: string;
  finalOutputPath: string;
  renditions: MediaRendition[];
  interventionReason?: string;
  qualityTarget?: JobQualityTarget;
}

export interface SourceAdapter {
  readonly provider: "eporner" | "astalavr" | "pikpak";
  canHandle(url: string): boolean;
  resolve(url: string): Promise<SourceDescriptor>;
}

export interface HITLPauseResult {
  jobId: string;
  workspaceDir: string;
  jobJsonPath: string;
  proxyPath: string;
  expectedLlcPath: string;
  status: "waiting-for-llc";
  instructions: string;
  job: JobState;
}
