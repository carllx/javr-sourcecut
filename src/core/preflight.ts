import fs from "node:fs/promises";
import path from "node:path";
import type {
  DuplicatePreflightResult,
  JobState,
  ProgressiveMediaIdentity,
  SourceDescriptor,
} from "../types.js";
import { buildMediaIdentity, extractLegacyWorkAliases } from "./identity.js";
import { loadJob } from "./job.js";

export class DuplicatePreflightError extends Error {
  readonly status: "in-progress" | "completed";
  readonly matchedJob: JobState;
  readonly matchedReason: string;

  constructor(
    status: "in-progress" | "completed",
    matchedJob: JobState,
    matchedReason: string
  ) {
    const summary =
      status === "completed"
        ? `Asset is already completed (${matchedReason})`
        : `Active job is currently in progress (${matchedReason}, status: ${matchedJob.status})`;
    super(`Duplicate preflight halted: ${summary}. Workspace: ${matchedJob.workspaceDir}`);
    this.name = "DuplicatePreflightError";
    this.status = status;
    this.matchedJob = matchedJob;
    this.matchedReason = matchedReason;
  }
}

export async function checkDuplicatePreflight(
  rootDir: string,
  descriptor: SourceDescriptor,
  explicitIdentity?: ProgressiveMediaIdentity
): Promise<DuplicatePreflightResult> {
  const identity = explicitIdentity || buildMediaIdentity(descriptor);

  let entries: { name: string; isDirectory: () => boolean }[] = [];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (err: unknown) {
    // If rootDir does not exist yet, no duplicates can exist
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "not-seen" };
    }
    throw err;
  }

  const candidateWorkAliases = new Set(
    (identity.workSearchAliases || [
      identity.canonicalCatalogId,
      identity.provider && identity.providerAssetId
        ? `${identity.provider}:${identity.providerAssetId}`
        : undefined,
    ].filter(Boolean) as string[]).map((s) => s.toLowerCase().trim())
  );

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const candidateWorkspaceDir = path.join(rootDir, entry.name);
    const jobJsonPath = path.join(candidateWorkspaceDir, "job.json");

    let job: JobState;
    try {
      job = await loadJob(jobJsonPath);
    } catch {
      // Ignore unparseable or missing job.json (unmanaged directory)
      continue;
    }

    // Failed jobs do NOT block duplicate preflight (can retry or re-ingest)
    if (job.status === "failed") {
      continue;
    }

    let matchedReason: string | undefined;

    // 1. Strong matching: Provider + Provider Asset ID (strictly provider-scoped)
    if (
      job.provider &&
      descriptor.provider &&
      job.provider === descriptor.provider &&
      job.providerAssetId &&
      descriptor.providerAssetId &&
      job.providerAssetId.toLowerCase() === descriptor.providerAssetId.toLowerCase()
    ) {
      matchedReason = `Matched provider asset ID: ${descriptor.provider}:${descriptor.providerAssetId}`;
    }
    // 2. Strong matching: Exact Source URL
    else if (
      job.sourceUrl &&
      descriptor.sourceUrl &&
      job.sourceUrl.trim().toLowerCase() === descriptor.sourceUrl.trim().toLowerCase()
    ) {
      matchedReason = `Matched source URL: ${descriptor.sourceUrl}`;
    }
    // 3. Strong matching: Canonical Catalog ID
    else if (
      job.identity?.canonicalCatalogId &&
      identity.canonicalCatalogId &&
      job.identity.canonicalCatalogId.toUpperCase() === identity.canonicalCatalogId.toUpperCase()
    ) {
      matchedReason = `Matched canonical catalog ID: ${identity.canonicalCatalogId}`;
    }
    // 4. Strong matching: Structured Work Search Aliases (catalog variants, provider-scoped IDs)
    // NOTE: Performer names / performer aliases and low-confidence clues are search/indexing only and MUST NOT block
    else {
      const existingWorkAliases: string[] =
        job.identity?.workSearchAliases && job.identity.workSearchAliases.length > 0
          ? job.identity.workSearchAliases
          : extractLegacyWorkAliases(job.identity, job.provider, job.providerAssetId);

      const normalizedExisting = existingWorkAliases.map((s) => s.toLowerCase().trim());
      const commonWorkAlias = normalizedExisting.find((a) => a.length > 2 && candidateWorkAliases.has(a));
      if (commonWorkAlias) {
        matchedReason = `Matched work catalog/asset alias: "${commonWorkAlias}"`;
      }
    }

    if (matchedReason) {
      if (job.status === "completed") {
        return {
          status: "completed",
          matchedJob: job,
          matchedReason,
        };
      }

      if (
        [
          "created",
          "discovering",
          "proxy-downloading",
          "waiting-for-llc",
          "needs-user-intervention",
        ].includes(job.status)
      ) {
        return {
          status: "in-progress",
          matchedJob: job,
          matchedReason,
        };
      }
    }
  }

  return {
    status: "not-seen",
  };
}
