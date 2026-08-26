import fs from "node:fs/promises";
import path from "node:path";
import type { HITLPauseResult, MediaRendition, QualityTargetOptions, SourceAdapter, SourceDescriptor } from "../types.js";
import { EpornerAdapter } from "../adapters/eporner/index.js";
import { AstalaVrAdapter } from "../adapters/astalavr/index.js";
import { selectProxyRendition } from "./proxy-selector.js";
import {
  selectHighestPublicHqRendition,
  resolveJobQualityTargetMetadata,
  type HqSelectionResult,
} from "./hq-selector.js";
import {
  resolveSessionProvider,
  type SourceSessionProvider,
} from "./session.js";
import { createJob, loadJob, saveJob, updateJobStatus } from "./job.js";
import { checkDuplicatePreflight, DuplicatePreflightError } from "./preflight.js";
import { downloadFile } from "./downloader.js";
import { verifyMediaFile } from "./verifier.js";
import { loadAndNormalizeLlc, findLlcFileInWorkspace } from "./llc.js";
import { runSelectiveFetch, type SelectiveFetchResult } from "./mp4/selective-fetch.js";
import { normalizeCodecName } from "./mp4/extractor.js";
import type { TimeRange } from "./mp4/types.js";

import type { JobState } from "../types.js";

export const DEFAULT_ADAPTERS: SourceAdapter[] = [
  new EpornerAdapter(),
  new AstalaVrAdapter(),
];

export function isAuthOrAccessError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as any;
  if (anyErr.status === 401 || anyErr.status === 403 || anyErr.status === 407) return true;
  if (anyErr.statusCode === 401 || anyErr.statusCode === 403 || anyErr.statusCode === 407) return true;
  const msg = (anyErr.message || String(err)).toLowerCase();
  return (
    /\b(401|403|407|unauthorized|forbidden|login required|session expired|token expired|access denied|cloudflare|turnstile|captcha|bot verification|auth(?:entication)? required)\b/i.test(
      msg
    ) ||
    msg.includes("requires an authenticated session") ||
    msg.includes("authenticated session transport is not configured") ||
    msg.includes("failed public probe: 403") ||
    msg.includes("failed public probe: 401") ||
    msg.includes("failed live range capability verification")
  );
}

export function buildInterventionReason(
  err: Error | unknown,
  sessionProvider: SourceSessionProvider,
  provider: string,
  context: "resolve" | "proxy-download" | "hq-selection"
): string {
  const errMsg = err instanceof Error ? err.message : String(err);
  if (!sessionProvider.hasSession) {
    return `Authenticated session transport is not configured for runtime (e.g. run 'javr-sourcecut auth ${provider}' or pass --cookies). Action '${context}' failed with access/session error: ${errMsg}`;
  }
  return `Current session or token was rejected or expired for provider '${provider}' during '${context}' (${errMsg}). Please re-authenticate via 'javr-sourcecut auth ${provider}' or supply fresh --cookies.`;
}

export interface TracerSliceParams {
  sourceUrl: string;
  rootDir: string;
  adapters?: SourceAdapter[];
  fetchFn?: typeof fetch;
  cookiesPath?: string;
  sessionProvider?: SourceSessionProvider;
  verifierFn?: typeof verifyMediaFile;
  onProgress?: (transferredBytes: number, totalBytes?: number) => void;
  onLog?: (message: string) => void;
}

export async function runTracerSlice(params: TracerSliceParams): Promise<HITLPauseResult> {
  const {
    sourceUrl,
    rootDir,
    adapters = DEFAULT_ADAPTERS,
    fetchFn = fetch,
    cookiesPath,
    sessionProvider: explicitSessionProvider,
    verifierFn = verifyMediaFile,
    onProgress,
    onLog = () => {},
  } = params;

  // 1. Adapter Selection
  const adapter = adapters.find((a) => a.canHandle(sourceUrl));
  if (!adapter) {
    throw new Error(`No compatible source adapter found for URL: ${sourceUrl}`);
  }

  const sessionProvider =
    explicitSessionProvider ??
    (await resolveSessionProvider({ cookiesPath, provider: adapter.provider }));
  const sessionFetch = sessionProvider.createSessionFetch(fetchFn);

  onLog(`[1/5] Ingesting URL with adapter "${adapter.provider}"...`);

  // 2. Discover formats and metadata (Fail closed before job creation if initial page fetch fails)
  let descriptor: SourceDescriptor;
  try {
    descriptor = await adapter.resolve(sourceUrl, sessionFetch);
  } catch (err: any) {
    if (isAuthOrAccessError(err)) {
      const guidance = !sessionProvider.hasSession
        ? `Authentication or browser session is required to access "${sourceUrl}". Please run 'javr-sourcecut auth ${adapter.provider}' or supply --cookies.`
        : `Session access failed for "${sourceUrl}". Please re-authenticate via 'javr-sourcecut auth ${adapter.provider}' or update --cookies.`;
      throw new Error(`Failed to resolve source page (${err.message}). ${guidance}`);
    }
    throw err;
  }

  onLog(`Discovered source: "${descriptor.rawTitle}" (${descriptor.renditions.length} renditions)`);

  // 3. Duplicate Preflight Check (fail-closed before downloading proxy or creating job)
  const preflight = await checkDuplicatePreflight(rootDir, descriptor);
  if (preflight.status !== "not-seen" && preflight.matchedJob) {
    onLog(`[PREFLIGHT DUPLICATE] ${preflight.status.toUpperCase()}: ${preflight.matchedReason}`);
    throw new DuplicatePreflightError(
      preflight.status,
      preflight.matchedJob,
      preflight.matchedReason || "Existing job detected"
    );
  }

  // 4. Select proxy rendition
  const selectedProxy = selectProxyRendition(descriptor.renditions);
  onLog(`Selected proxy rendition: ${selectedProxy.formatId} (${selectedProxy.resolution}, ${selectedProxy.vcodec.toUpperCase()})`);

  // 5. Create Job & deterministic flat workspace
  const job = await createJob(rootDir, descriptor, selectedProxy);
  await saveJob(job);
  onLog(`Initialized job workspace: ${job.workspaceDir}`);

  // 6. Download proxy
  await updateJobStatus(job, "proxy-downloading");
  onLog(`[2/5] Downloading proxy video to: ${job.proxyPath}`);
  try {
    await downloadFile(selectedProxy.directUrl, job.proxyPath, {
      fetchFn: sessionFetch,
      onProgress,
    });
  } catch (err: any) {
    // Cleanup any partial file
    await fs.rm(`${job.proxyPath}.part`, { force: true }).catch(() => {});

    if (isAuthOrAccessError(err)) {
      const reason = buildInterventionReason(err, sessionProvider, job.provider, "proxy-download");
      job.status = "needs-user-intervention";
      job.interventionReason = reason;
      await saveJob(job);
      onLog(`[NEEDS USER INTERVENTION] Job ${job.jobId}: ${reason}`);
    }
    throw err;
  }

  // 6. Verify container integrity via ffprobe
  onLog(`[3/5] Verifying proxy container integrity with ffprobe...`);
  const probeResult = await verifierFn(job.proxyPath);
  onLog(
    `Proxy verified: duration=${probeResult.duration.toFixed(1)}s, video=${probeResult.videoStream.codec} (${probeResult.videoStream.width}x${probeResult.videoStream.height}), audio=${probeResult.audioStream?.codec || "none"}`
  );

  // 7. Persist Job in waiting-for-llc state
  await updateJobStatus(job, "waiting-for-llc");
  const jobJsonPath = path.join(job.workspaceDir, "job.json");

  // 8. Output intentional HITL pause instructions
  const instructions = [
    "=======================================================================",
    " [SUCCESS GATE] Tracer Slice 1 Paused: waiting-for-llc",
    "=======================================================================",
    ` 1. Job Identity:    ${job.jobId}`,
    `    Job Workspace:   ${job.workspaceDir}`,
    `    Job State:       ${jobJsonPath} (status: waiting-for-llc)`,
    ` 2. Proxy Video:     ${job.proxyPath}`,
    ` 3. LosslessCut:     Open the proxy video above in LosslessCut`,
    `    Expected LLC:    ${job.expectedLlcPath}`,
    ` 4. Resume Action:   Once cut segments are saved to the .llc project,`,
    `                     resume the workflow in subsequent slices (#11+).`,
    "=======================================================================",
  ].join("\n");

  onLog(instructions);

  return {
    jobId: job.jobId,
    workspaceDir: job.workspaceDir,
    jobJsonPath,
    proxyPath: job.proxyPath,
    expectedLlcPath: job.expectedLlcPath,
    status: "waiting-for-llc",
    instructions,
    job,
  };
}

export interface ResumeJobParams {
  jobPathOrDir: string;
  llcPath?: string;
  qualityTarget?: QualityTargetOptions;
  budgetMultiplier?: number;
  cookiesPath?: string;
  sessionProvider?: SourceSessionProvider;
  adapters?: SourceAdapter[];
  fetchFn?: typeof fetch;
  verifierFn?: typeof verifyMediaFile;
  onProgress?: (transferredBytes: number, totalBytes?: number) => void;
  onLog?: (message: string) => void;
}

export interface ResumeJobResult {
  job: JobState;
  llcPath: string;
  timeRange: TimeRange;
  timeRanges: TimeRange[];
  selectedHq: MediaRendition;
  hqSelectionResult: HqSelectionResult;
  discoveredRenditions: MediaRendition[];
  outputClipPath: string;
  selectiveFetchResult: SelectiveFetchResult;
  hqSelectionProbeBytes: number;
  selectiveFetchBytes: number;
  totalHqLifecycleBytes: number;
  selectedFullFileBytes: number;
  selectiveFetchSavingsPercent: number;
  lifecycleSavingsPercent: number;
}

export async function resumeJobWorkflow(params: ResumeJobParams): Promise<ResumeJobResult> {
  const {
    jobPathOrDir,
    llcPath: explicitLlcPath,
    qualityTarget,
    budgetMultiplier,
    cookiesPath,
    sessionProvider: explicitSessionProvider,
    adapters = DEFAULT_ADAPTERS,
    fetchFn = fetch,
    verifierFn = verifyMediaFile,
    onProgress,
    onLog = () => {},
  } = params;

  // 1. Load existing job.json from disk
  const job = await loadJob(jobPathOrDir);
  onLog(`[Resume 1/5] Loaded Job "${job.jobId}" from ${job.workspaceDir} (status: ${job.status})`);

  const sessionProvider =
    explicitSessionProvider ??
    (await resolveSessionProvider({ cookiesPath, provider: job.provider }));
  const sessionFetch = sessionProvider.createSessionFetch(fetchFn);

  // 2. Invariant: Existing proxy must exist on disk and MUST NOT be re-downloaded or modified
  let proxyStatBefore: { mtimeMs: number; size: number };
  try {
    const stat = await fs.stat(job.proxyPath);
    if (!stat.isFile()) {
      throw new Error(`Proxy path is not a file: ${job.proxyPath}`);
    }
    proxyStatBefore = { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (err: any) {
    throw new Error(
      `Proxy video file not found at "${job.proxyPath}". Refusing to resume or re-download: ${err.message}`
    );
  }

  // 3. Locate and Parse LosslessCut .llc file
  const resolvedLlcPath = explicitLlcPath
    ? path.resolve(explicitLlcPath)
    : await findLlcFileInWorkspace(job.workspaceDir, job.expectedLlcPath);

  const { timeRange, timeRanges } = await loadAndNormalizeLlc(resolvedLlcPath);
  onLog(
    `[Resume 2/5] Parsed ${timeRanges.length} cut segment(s) from ${resolvedLlcPath}:`
  );
  for (let i = 0; i < timeRanges.length; i++) {
    const s = timeRanges[i];
    onLog(
      `  Segment ${i + 1}: [${s.startSeconds.toFixed(3)}s -> ${s.endSeconds.toFixed(3)}s] (duration ${(s.endSeconds - s.startSeconds).toFixed(3)}s)`
    );
  }

  // 4. Invariant: Do not overwrite existing final output file if present
  const outputClipPath = job.finalOutputPath;
  try {
    const outStat = await fs.stat(outputClipPath);
    if (outStat.isFile()) {
      throw new Error(
        `Final output file already exists at "${outputClipPath}". Refusing to overwrite existing file.`
      );
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  // 5. Re-resolve current live renditions (do not trust stale direct URLs in job.json)
  const adapter =
    adapters.find((a) => a.canHandle(job.sourceUrl)) ??
    adapters.find((a) => a.provider === job.provider);
  if (!adapter) {
    throw new Error(`No compatible source adapter found for source URL: ${job.sourceUrl}`);
  }

  let descriptor: SourceDescriptor;
  try {
    onLog(`[Resume 3/5] Re-resolving live renditions from ${job.sourceUrl}...`);
    descriptor = await adapter.resolve(job.sourceUrl, sessionFetch);
    onLog(`Discovered ${descriptor.renditions.length} live renditions.`);
  } catch (err: any) {
    if (isAuthOrAccessError(err)) {
      const reason = buildInterventionReason(err, sessionProvider, job.provider, "resolve");
      job.status = "needs-user-intervention";
      job.interventionReason = reason;
      job.qualityTarget = resolveJobQualityTargetMetadata(
        job.renditions || [],
        qualityTarget,
        reason
      );
      await saveJob(job);
      onLog(`[NEEDS USER INTERVENTION] Job ${job.jobId}: ${reason}`);
    }
    throw err;
  }

  // 6. Select highest publicly available Direct MP4 rendition in target tier
  let hqSelectionResult: HqSelectionResult;
  try {
    hqSelectionResult = await selectHighestPublicHqRendition(descriptor.renditions, {
      target: qualityTarget,
      fetchFn: sessionFetch,
      onLog,
    });
  } catch (err: any) {
    // Quality target is inaccessible (e.g. requires authentication) -> enter needs-user-intervention
    const reason = buildInterventionReason(err, sessionProvider, job.provider, "hq-selection");

    job.status = "needs-user-intervention";
    job.renditions = descriptor.renditions;
    job.interventionReason = reason;
    job.qualityTarget = resolveJobQualityTargetMetadata(
      descriptor.renditions,
      qualityTarget,
      reason
    );
    await saveJob(job);
    onLog(`[NEEDS USER INTERVENTION] Job ${job.jobId}: ${reason}`);
    throw err;
  }

  const selectedHq = hqSelectionResult.selected;
  onLog(
    `[Resume 4/5] Selected HQ rendition: ${selectedHq.formatId} (${selectedHq.resolution}, ${selectedHq.vcodec.toUpperCase()}) directUrl=${selectedHq.directUrl}`
  );

  // 7. Execute bounded MP4 index probe and HTTP 206 selective fetch
  onLog(`[Resume 5/5] Executing selective fetch for ${timeRanges.length} cut segment(s)...`);
  const selectiveFetchResult = await runSelectiveFetch({
    sourceUrl: selectedHq.directUrl,
    timeRange,
    timeRanges,
    outputClipPath,
    workDir: job.workspaceDir,
    renditionIdentity: {
      provider: job.provider,
      providerAssetId: job.providerAssetId,
      formatId: selectedHq.formatId,
      fullFileBytes: selectedHq.contentLength || 0,
    },
    options: {
      budgetMultiplier,
      fetchFn: sessionFetch,
      onProgress: (percent, transferred, total) => {
        onProgress?.(transferred, total);
      },
    },
  });

  // Verify final output using verifierFn (defaults to probeResult verified by selective-fetch)
  const verifiedProbe =
    verifierFn !== verifyMediaFile
      ? await verifierFn(outputClipPath)
      : selectiveFetchResult.probeResult;

  onLog(
    `Output verified: duration=${verifiedProbe.duration.toFixed(2)}s, codec=${verifiedProbe.videoStream.codec} (${verifiedProbe.videoStream.width}x${verifiedProbe.videoStream.height}), audio=${verifiedProbe.audioStream?.codec || "none"}`
  );

  // 8. Enforce authoritative ffprobe invariants before completing job
  const actualCodec = normalizeCodecName(verifiedProbe.videoStream.codec);
  const expectedCodec = normalizeCodecName(selectedHq.vcodec);
  if (actualCodec !== expectedCodec) {
    throw new Error(
      `Output video codec mismatch: expected "${selectedHq.vcodec}" (${expectedCodec}), but ffprobe verified "${verifiedProbe.videoStream.codec}" (${actualCodec}). Refusing to complete job.`
    );
  }


  if (verifiedProbe.videoStream.height !== selectedHq.height) {
    throw new Error(
      `Output video height mismatch: expected ${selectedHq.height}p, but ffprobe verified ${verifiedProbe.videoStream.height}p. Refusing to complete job.`
    );
  }

  const expectedCutDuration = timeRanges.reduce(
    (sum, r) => sum + (r.endSeconds - r.startSeconds),
    0
  );
  const durationDiff = Math.abs(verifiedProbe.duration - expectedCutDuration);
  const maxDurationTolerance = Math.min(5.0 * timeRanges.length, 12.0); // Bounded keyframe alignment tolerance (<= 5s per segment, globally capped at 12s)
  if (durationDiff > maxDurationTolerance) {
    throw new Error(
      `Output duration mismatch: expected ~${expectedCutDuration.toFixed(3)}s (from LLC ${timeRanges.length} segments), but ffprobe verified ${verifiedProbe.duration.toFixed(3)}s (diff ${durationDiff.toFixed(3)}s exceeds fixed tolerance ${maxDurationTolerance.toFixed(3)}s). Refusing to complete job.`
    );
  }


  // 9. Invariant: Verify existing proxy was completely untouched
  const proxyStatAfter = await fs.stat(job.proxyPath);
  if (
    proxyStatAfter.mtimeMs !== proxyStatBefore.mtimeMs ||
    proxyStatAfter.size !== proxyStatBefore.size
  ) {
    throw new Error(
      `Invariant violation: Proxy file "${job.proxyPath}" was modified during resume execution!`
    );
  }

  // 10. Aggregate lifecycle network ledger
  const hqSelectionProbeBytes = hqSelectionResult.capabilitySelectionBytesTransferred;
  const selectiveFetchBytes = selectiveFetchResult.transferredBytes;
  const totalHqLifecycleBytes = hqSelectionProbeBytes + selectiveFetchBytes;
  const selectedFullFileBytes = selectiveFetchResult.fullFileBytes;
  const selectiveFetchSavingsPercent = selectiveFetchResult.savingsPercent;
  const lifecycleSavingsPercent = Math.max(
    0,
    Math.round((1 - totalHqLifecycleBytes / selectedFullFileBytes) * 100)
  );

  // 11. Update job status to completed and save
  job.status = "completed";
  job.renditions = descriptor.renditions;
  job.qualityTarget = resolveJobQualityTargetMetadata(
    descriptor.renditions,
    qualityTarget
  );
  await saveJob(job);

  onLog(`\n[SUCCESS] Resume E2E completed successfully (${job.provider})! Output: ${outputClipPath}`);

  return {
    job,
    llcPath: resolvedLlcPath,
    timeRange,
    timeRanges,
    selectedHq,
    hqSelectionResult,
    discoveredRenditions: descriptor.renditions,
    outputClipPath,
    selectiveFetchResult,
    hqSelectionProbeBytes,
    selectiveFetchBytes,
    totalHqLifecycleBytes,
    selectedFullFileBytes,
    selectiveFetchSavingsPercent,
    lifecycleSavingsPercent,
  };
}

