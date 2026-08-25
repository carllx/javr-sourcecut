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

export interface SourceDescriptor {
  provider: "eporner" | "astalavr" | "pikpak";
  providerAssetId: string;
  sourceUrl: string;
  rawTitle: string;
  declaredPerformers: string[];
  durationSeconds?: number;
  renditions: MediaRendition[];
}

export interface ProgressiveMediaIdentity {
  provider: string;
  providerAssetId: string;
  observedTitle: string;
  canonicalCatalogId?: string; // e.g. "WAVR110"
  searchAliases: string[];      // e.g. ["WAVR110", "WAVR-110", "wavr110"]
  performers: {
    preferredName: string;
    aliases?: string[];
  }[];
  confidence: "high" | "medium" | "fallback";
  baseName: string;
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
