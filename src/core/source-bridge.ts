import type { SourceAdapter, SourceDescriptor } from "../types.js";
import { normalizePerformers } from "./identity.js";
import {
  SourceQueryFailure,
  type IngestionInput,
  type IngestionResult,
  type IngestionService,
  type LocalFileInput,
} from "./ingestion.js";

export function mapErrorToSourceQueryFailure(err: unknown): SourceQueryFailure {
  if (err instanceof SourceQueryFailure) {
    return err;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b(403|forbidden)\b/i.test(msg)) {
    return new SourceQueryFailure("HTTP_403", msg, true);
  }
  if (/\b(429|too many requests|rate limit)\b/i.test(msg)) {
    return new SourceQueryFailure("HTTP_429", msg, true);
  }
  if (/\b(401|unauthorized|auth|login required)\b/i.test(msg)) {
    return new SourceQueryFailure("AUTH_FAILED", msg, true);
  }
  return new SourceQueryFailure("NETWORK_ERROR", msg, true);
}

/**
 * Maps a resolved SourceDescriptor from a SourceAdapter into IngestionInput
 * capturing Source Reference, providerAssetId, rawTitle, and credit performers as source evidence.
 */
export function mapSourceDescriptorToIngestionInput(
  descriptor: SourceDescriptor,
  localFile: LocalFileInput,
  extraClues?: Partial<IngestionInput["clues"]>
): IngestionInput {
  const normalizedPerformers = normalizePerformers(descriptor.declaredPerformers || []);
  const performerNames = normalizedPerformers.map((p) => p.preferredName);

  return {
    localFile,
    sourceReference: {
      provider: descriptor.provider,
      sourceUrl: descriptor.sourceUrl,
      providerAssetId: descriptor.providerAssetId,
      rawTitle: descriptor.rawTitle,
    },
    clues: {
      provider: descriptor.provider,
      providerAssetId: descriptor.providerAssetId,
      rawTitle: descriptor.rawTitle,
      sourceUrl: descriptor.sourceUrl,
      performers: performerNames.length > 0 ? performerNames : undefined,
      ...extraClues,
    },
  };
}

export interface ResolveSourceForIngestionOptions {
  localFile: LocalFileInput;
  fetchFn?: typeof fetch;
  extraClues?: Partial<IngestionInput["clues"]>;
}

/**
 * Resolves a source URL using the provided SourceAdapter and converts it into IngestionInput.
 */
export async function resolveSourceForIngestion(
  adapter: SourceAdapter,
  sourceUrl: string,
  options: ResolveSourceForIngestionOptions
): Promise<IngestionInput> {
  const { localFile, fetchFn = fetch, extraClues } = options;

  let descriptor: SourceDescriptor;
  try {
    descriptor = await adapter.resolve(sourceUrl, fetchFn);
  } catch (err: unknown) {
    throw mapErrorToSourceQueryFailure(err);
  }

  return mapSourceDescriptorToIngestionInput(descriptor, localFile, extraClues);
}

export interface IngestSourceWithAdapterParams {
  service: IngestionService;
  adapter: SourceAdapter;
  sourceUrl: string;
  localFile: LocalFileInput;
  fetchFn?: typeof fetch;
  extraClues?: Partial<IngestionInput["clues"]>;
}

/**
 * Resolves source page via SourceAdapter and pipes into unified IngestionService.ingest.
 * Captures access/HTTP failures as retryable query_failed status in the catalog.
 */
export async function ingestSourceWithAdapter(
  params: IngestSourceWithAdapterParams
): Promise<IngestionResult> {
  const { service, adapter, sourceUrl, localFile, fetchFn = fetch, extraClues } = params;

  try {
    const input = await resolveSourceForIngestion(adapter, sourceUrl, {
      localFile,
      fetchFn,
      extraClues,
    });
    return await service.ingest(input);
  } catch (err: unknown) {
    const queryError = mapErrorToSourceQueryFailure(err);
    const fallbackInput: IngestionInput = {
      localFile,
      sourceReference: {
        provider: adapter.provider,
        sourceUrl,
      },
      clues: {
        provider: adapter.provider,
        sourceUrl,
        ...extraClues,
      },
      sourceQueryError: queryError,
    };
    return await service.ingest(fallbackInput);
  }
}
