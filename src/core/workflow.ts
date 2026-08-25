import fs from "node:fs/promises";
import path from "node:path";
import type { HITLPauseResult, MediaRendition, SourceAdapter } from "../types.js";
import { EpornerAdapter } from "../adapters/eporner/index.js";
import { selectProxyRendition } from "./proxy-selector.js";
import { selectHqRendition } from "./hq-selector.js";
import { createJob, loadJob, saveJob, updateJobStatus } from "./job.js";
import { downloadFile } from "./downloader.js";
import { verifyMediaFile } from "./verifier.js";
import { loadAndNormalizeLlc, findLlcFileInWorkspace } from "./llc.js";
import { runSelectiveFetch, type SelectiveFetchResult } from "./mp4/selective-fetch.js";
import type { TimeRange } from "./mp4/types.js";
import type { JobState } from "../types.js";

export interface TracerSliceParams {
  sourceUrl: string;
  rootDir: string;
  adapters?: SourceAdapter[];
  fetchFn?: typeof fetch;
  verifierFn?: typeof verifyMediaFile;
  onProgress?: (transferredBytes: number, totalBytes?: number) => void;
  onLog?: (message: string) => void;
}

export async function runTracerSlice(params: TracerSliceParams): Promise<HITLPauseResult> {
  const {
    sourceUrl,
    rootDir,
    adapters = [new EpornerAdapter()],
    fetchFn = fetch,
    verifierFn = verifyMediaFile,
    onProgress,
    onLog = () => {},
  } = params;

  // 1. Adapter Selection
  const adapter = adapters.find((a) => a.canHandle(sourceUrl));
  if (!adapter) {
    throw new Error(`No compatible source adapter found for URL: ${sourceUrl}`);
  }

  onLog(`[1/5] Ingesting URL with adapter "${adapter.provider}"...`);

  // 2. Discover formats and metadata
  const descriptor = await adapter.resolve(sourceUrl, fetchFn);
  onLog(`Discovered source: "${descriptor.rawTitle}" (${descriptor.renditions.length} renditions)`);

  // 3. Select proxy rendition
  const selectedProxy = selectProxyRendition(descriptor.renditions);
  onLog(`Selected proxy rendition: ${selectedProxy.formatId} (${selectedProxy.resolution}, ${selectedProxy.vcodec.toUpperCase()})`);

  // 4. Create Job & deterministic flat workspace
  const job = await createJob(rootDir, descriptor, selectedProxy);
  await saveJob(job);
  onLog(`Initialized job workspace: ${job.workspaceDir}`);

  // 5. Download proxy
  await updateJobStatus(job, "proxy-downloading");
  onLog(`[2/5] Downloading proxy video to: ${job.proxyPath}`);
  await downloadFile(selectedProxy.directUrl, job.proxyPath, {
    fetchFn,
    onProgress,
  });

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
  selectedHq: MediaRendition;
  discoveredRenditions: MediaRendition[];
  outputClipPath: string;
  selectiveFetchResult: SelectiveFetchResult;
}

export async function resumeJobWorkflow(params: ResumeJobParams): Promise<ResumeJobResult> {
  const {
    jobPathOrDir,
    llcPath: explicitLlcPath,
    adapters = [new EpornerAdapter()],
    fetchFn = fetch,
    verifierFn = verifyMediaFile,
    onProgress,
    onLog = () => {},
  } = params;

  // 1. Load existing job.json from disk
  const job = await loadJob(jobPathOrDir);
  onLog(`[Resume 1/5] Loaded Job "${job.jobId}" from ${job.workspaceDir} (status: ${job.status})`);

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

  const { timeRange } = await loadAndNormalizeLlc(resolvedLlcPath);
  onLog(
    `[Resume 2/5] Parsed cut segment [${timeRange.startSeconds.toFixed(3)}s -> ${timeRange.endSeconds.toFixed(3)}s] (duration ${(timeRange.endSeconds - timeRange.startSeconds).toFixed(3)}s) from ${resolvedLlcPath}`
  );

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

  // 5. Re-resolve current live Eporner renditions (do not trust stale direct URLs in job.json)
  const adapter = adapters.find((a) => a.canHandle(job.sourceUrl));
  if (!adapter) {
    throw new Error(`No compatible source adapter found for source URL: ${job.sourceUrl}`);
  }

  onLog(`[Resume 3/5] Re-resolving live renditions from ${job.sourceUrl}...`);
  const descriptor = await adapter.resolve(job.sourceUrl, fetchFn);
  onLog(`Discovered ${descriptor.renditions.length} live renditions.`);

  // 6. Select highest-quality Direct MP4 rendition (prefer AV1 in top resolution tier)
  const selectedHq = selectHqRendition(descriptor.renditions);
  onLog(
    `[Resume 4/5] Selected HQ rendition: ${selectedHq.formatId} (${selectedHq.resolution}, ${selectedHq.vcodec.toUpperCase()}) directUrl=${selectedHq.directUrl}`
  );

  // 7. Execute bounded MP4 index probe and HTTP 206 selective fetch
  onLog(`[Resume 5/5] Executing selective fetch for [${timeRange.startSeconds.toFixed(3)}s -> ${timeRange.endSeconds.toFixed(3)}s]...`);
  const selectiveFetchResult = await runSelectiveFetch({
    sourceUrl: selectedHq.directUrl,
    timeRange,
    outputClipPath,
    workDir: job.workspaceDir,
    options: {
      fetchFn,
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

  // 8. Invariant: Verify existing proxy was completely untouched
  const proxyStatAfter = await fs.stat(job.proxyPath);
  if (
    proxyStatAfter.mtimeMs !== proxyStatBefore.mtimeMs ||
    proxyStatAfter.size !== proxyStatBefore.size
  ) {
    throw new Error(
      `Invariant violation: Proxy file "${job.proxyPath}" was modified during resume execution!`
    );
  }

  // 9. Update job status to completed and save
  job.status = "completed";
  job.renditions = descriptor.renditions;
  await saveJob(job);

  onLog(`\n[SUCCESS] Eporner Resume E2E completed successfully! Output: ${outputClipPath}`);

  return {
    job,
    llcPath: resolvedLlcPath,
    timeRange,
    selectedHq,
    discoveredRenditions: descriptor.renditions,
    outputClipPath,
    selectiveFetchResult,
  };
}
