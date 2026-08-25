import fs from "node:fs/promises";
import path from "node:path";
import type { JobState, JobStatus, MediaRendition, SourceDescriptor } from "../types.js";
import { buildMediaIdentity } from "./identity.js";

export async function createJob(
  rootDir: string,
  sourceDescriptor: SourceDescriptor,
  selectedProxy: MediaRendition
): Promise<JobState> {
  const identity = buildMediaIdentity(sourceDescriptor);
  const baseName = identity.baseName;
  const workspaceDir = path.resolve(rootDir, baseName);

  await fs.mkdir(workspaceDir, { recursive: true });

  const proxyPath = path.join(workspaceDir, `${baseName}.proxy.mp4`);
  const expectedLlcPath = path.join(workspaceDir, `${baseName}.llc`);
  const finalOutputPath = path.join(workspaceDir, `${baseName}.mp4`);

  const now = new Date().toISOString();
  const jobId = `${sourceDescriptor.provider}-${sourceDescriptor.providerAssetId}`;

  const jobState: JobState = {
    jobId,
    status: "created",
    createdAt: now,
    updatedAt: now,
    sourceUrl: sourceDescriptor.sourceUrl,
    provider: sourceDescriptor.provider,
    providerAssetId: sourceDescriptor.providerAssetId,
    identity,
    workspaceDir,
    selectedProxy,
    proxyPath,
    expectedLlcPath,
    finalOutputPath,
    renditions: sourceDescriptor.renditions,
  };

  return jobState;
}

export async function saveJob(job: JobState): Promise<string> {
  const jobJsonPath = path.join(job.workspaceDir, "job.json");
  job.updatedAt = new Date().toISOString();
  const content = JSON.stringify(job, null, 2);
  await fs.writeFile(jobJsonPath, content, "utf-8");
  return jobJsonPath;
}

export async function loadJob(jobPathOrDir: string): Promise<JobState> {
  let jsonPath = path.resolve(jobPathOrDir);
  const stat = await fs.stat(jsonPath);
  if (stat.isDirectory()) {
    jsonPath = path.join(jsonPath, "job.json");
  }

  const raw = await fs.readFile(jsonPath, "utf-8");
  const job: JobState = JSON.parse(raw);
  return job;
}

export async function updateJobStatus(job: JobState, status: JobStatus): Promise<JobState> {
  job.status = status;
  await saveJob(job);
  return job;
}
