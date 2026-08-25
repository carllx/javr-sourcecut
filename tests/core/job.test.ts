import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createJob, saveJob, loadJob, updateJobStatus } from "../../src/core/job.js";
import type { SourceDescriptor, MediaRendition } from "../../src/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("Job and Workspace Lifecycle", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sc-job-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("creates, saves and reloads job state with flat workspace paths", async () => {
    const descriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "vid123",
      sourceUrl: "https://www.eporner.com/video-vid123/wavr-110-yua-mikami/",
      rawTitle: "WAVR-110 Yua Mikami",
      declaredPerformers: ["Yua Mikami"],
      renditions: [
        { formatId: "480p-av1", resolution: "480p", height: 480, vcodec: "av1", directUrl: "http://example.com/480.mp4" },
      ],
    };

    const selectedProxy: MediaRendition = descriptor.renditions[0];

    const job = await createJob(tempRoot, descriptor, selectedProxy);
    expect(job.status).toBe("created");
    expect(job.workspaceDir).toBe(path.join(tempRoot, "Yua Mikami - WAVR110"));
    expect(job.proxyPath).toBe(path.join(tempRoot, "Yua Mikami - WAVR110", "Yua Mikami - WAVR110.proxy.mp4"));
    expect(job.expectedLlcPath).toBe(path.join(tempRoot, "Yua Mikami - WAVR110", "Yua Mikami - WAVR110.llc"));
    expect(job.finalOutputPath).toBe(path.join(tempRoot, "Yua Mikami - WAVR110", "Yua Mikami - WAVR110.mp4"));

    const jobJsonPath = await saveJob(job);
    expect(jobJsonPath).toBe(path.join(job.workspaceDir, "job.json"));

    // Verify workspace directory exists
    const stat = await fs.stat(job.workspaceDir);
    expect(stat.isDirectory()).toBe(true);

    // Reload job
    const loaded = await loadJob(job.workspaceDir);
    expect(loaded.jobId).toBe(job.jobId);
    expect(loaded.status).toBe("created");
    expect(loaded.selectedProxy.formatId).toBe("480p-av1");

    // Transition to waiting-for-llc
    const updated = await updateJobStatus(loaded, "waiting-for-llc");
    expect(updated.status).toBe("waiting-for-llc");

    const reloaded = await loadJob(jobJsonPath);
    expect(reloaded.status).toBe("waiting-for-llc");
  });
});
