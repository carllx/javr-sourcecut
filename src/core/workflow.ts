import path from "node:path";
import type { HITLPauseResult, SourceAdapter } from "../types.js";
import { EpornerAdapter } from "../adapters/eporner/index.js";
import { selectProxyRendition } from "./proxy-selector.js";
import { createJob, saveJob, updateJobStatus } from "./job.js";
import { downloadFile } from "./downloader.js";
import { verifyMediaFile } from "./verifier.js";

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
  };
}
