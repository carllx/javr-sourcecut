export interface PerformerRecord {
  id: string;
  name: string;
  aliases?: string[];
  dateOfBirth?: string;
  region?: "asian" | "western" | "unclassified";
}

export interface WorkIdentifier {
  scheme: string;
  value: string;
}

export interface IdentificationEvidence {
  source: string;
  evidenceKey?: string;
  evidenceValue: string;
  recordedAt: string;
}

export interface SourceReference {
  id?: string;
  provider: string;
  sourceUrl: string;
  providerAssetId?: string;
  rawTitle?: string;
}

export interface LocalFileRecord {
  id: string;
  workId: string;
  path: string;
  sizeBytes?: number;
  format?: string;
  codec?: string;
  resolution?: string;
}

export interface ReviewCandidateRecord {
  title: string;
  studio?: string;
  director?: string;
  releaseDate?: string;
  shootDate?: string;
  identifiers: WorkIdentifier[];
  performers: PerformerInput[];
  sourceReferences: SourceReferenceInput[];
  evidences?: IdentificationEvidenceInput[];
}

export interface WorkRecord {
  id: string;
  title: string;
  identifiers: WorkIdentifier[];
  performers: PerformerRecord[];
  sourceReferences: SourceReference[];
  evidences: IdentificationEvidence[];
  localFiles: LocalFileRecord[];
  isLibraryReady: boolean;
  reviewStatus?: "ready" | "pending_review" | "query_failed";
  reviewReason?: string;
  reviewCandidates?: ReviewCandidateRecord[];
  director?: string;
  releaseDate?: string;
  shootDate?: string;
}

export interface PerformerInput {
  name: string;
  aliases?: string[];
  dateOfBirth?: string;
  region?: "asian" | "western" | "unclassified";
}

export interface WorkInput {
  title: string;
  identifiers?: WorkIdentifier[];
  director?: string;
  releaseDate?: string;
  shootDate?: string;
}

export interface LocalFileInput {
  path: string;
  sizeBytes?: number;
  format?: string;
  codec?: string;
  resolution?: string;
}

export interface SourceReferenceInput {
  provider: string;
  sourceUrl: string;
  providerAssetId?: string;
  rawTitle?: string;
}

export interface IdentificationEvidenceInput {
  source: string;
  evidenceKey?: string;
  evidenceValue: string;
  recordedAt?: string;
}

export interface PendingMediaInput {
  work: WorkInput;
  reviewStatus?: "pending_review" | "query_failed";
  reviewReason?: string;
  performers?: PerformerInput[];
  localFile: LocalFileInput;
  sourceReferences?: SourceReferenceInput[];
  evidences?: IdentificationEvidenceInput[];
  reviewCandidates?: ReviewCandidateRecord[];
}

export interface ReviewResolutionInput {
  title?: string;
  identifiers?: WorkIdentifier[];
  performers?: PerformerInput[];
  sourceReferences?: SourceReferenceInput[];
  director?: string;
  releaseDate?: string;
  shootDate?: string;
  notes?: string;
}

export interface ConfirmedMediaInput {
  work: WorkInput;
  performers: PerformerInput[];
  localFile: LocalFileInput;
  sourceReferences?: SourceReferenceInput[];
  evidences?: IdentificationEvidenceInput[];
}
