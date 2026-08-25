import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resumeJobWorkflow } from "../../src/core/workflow.js";
import type { JobState, SourceAdapter, SourceDescriptor } from "../../src/types.js";
import * as selectiveFetchModule from "../../src/core/mp4/selective-fetch.js";

describe("Workflow Resume E2E", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "javr-resume-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("resumes an existing job from disk, selects top resolution AV1, and completes without touching proxy", async () => {
    const workspaceDir = path.join(tmpDir, "eporner-test123");
    await fs.mkdir(workspaceDir, { recursive: true });

    const proxyPath = path.join(workspaceDir, "eporner-test123.proxy.mp4");
    const proxyContent = Buffer.from("dummy-proxy-data-content-12345");
    await fs.writeFile(proxyPath, proxyContent);
    const proxyStatBefore = await fs.stat(proxyPath);

    const llcPath = path.join(workspaceDir, "eporner-test123.proxy-proj.llc");
    const llcContent = `
{
  version: 2,
  mediaFileName: 'eporner-test123.proxy.mp4',
  cutSegments: [
    {
      start: 100.5,
      end: 200.5,
      selected: true,
    },
  ],
}
`;
    await fs.writeFile(llcPath, llcContent, "utf-8");

    const finalOutputPath = path.join(workspaceDir, "eporner-test123.mp4");

    const jobState: JobState = {
      jobId: "eporner-test123",
      status: "waiting-for-llc",
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:05:00.000Z",
      sourceUrl: "https://www.eporner.com/video-test123/sample/",
      provider: "eporner",
      providerAssetId: "test123",
      identity: {
        provider: "eporner",
        providerAssetId: "test123",
        observedTitle: "Sample Video Title",
        searchAliases: ["test123"],
        performers: [],
        confidence: "fallback",
        baseName: "eporner-test123",
      },
      workspaceDir,
      selectedProxy: {
        formatId: "480p-av1",
        resolution: "480p",
        height: 480,
        vcodec: "av1",
        directUrl: "https://www.eporner.com/dload/old-stale-proxy.mp4",
      },
      proxyPath,
      expectedLlcPath: path.join(workspaceDir, "eporner-test123.llc"),
      finalOutputPath,
      renditions: [],
    };

    const jobJsonPath = path.join(workspaceDir, "job.json");
    await fs.writeFile(jobJsonPath, JSON.stringify(jobState, null, 2), "utf-8");

    // Mock live adapter
    const mockDescriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "test123",
      sourceUrl: "https://www.eporner.com/video-test123/sample/",
      rawTitle: "Sample Video Title",
      declaredPerformers: [],
      renditions: [
        {
          formatId: "1080p-h264",
          resolution: "1080p",
          height: 1080,
          vcodec: "h264",
          directUrl: "https://www.eporner.com/dload/fresh-1080p.mp4",
        },
        {
          formatId: "2160p-h264",
          resolution: "2160p",
          height: 2160,
          vcodec: "h264",
          directUrl: "https://www.eporner.com/dload/fresh-2160p-h264.mp4",
        },
        {
          formatId: "2160p-av1",
          resolution: "2160p",
          height: 2160,
          vcodec: "av1",
          directUrl: "https://www.eporner.com/dload/fresh-2160p-av1.mp4",
        },
      ],
    };

    const mockAdapter: SourceAdapter = {
      provider: "eporner",
      canHandle: (url) => url.includes("eporner.com"),
      resolve: vi.fn().mockResolvedValue(mockDescriptor),
    };

    // Mock selective fetch
    const selectiveFetchSpy = vi.spyOn(selectiveFetchModule, "runSelectiveFetch").mockImplementation(async (params) => {
      // Create empty mock output clip
      await fs.writeFile(params.outputClipPath, "mock-output-video-data");
      return {
        outputClipPath: params.outputClipPath,
        plan: {
          sourceUrl: params.sourceUrl,
          targetTimeRange: params.timeRange,
          keyframeAlignedTimeRange: params.timeRange,
          videoByteRange: { startByte: 1000, endByte: 5000 },
          combinedByteRange: { startByte: 1000, endByte: 5000 },
          segmentRanges: [{ startByte: 1000, endByte: 5000 }],
          totalBytesToFetch: 4001,
          fullFileBytes: 100000,
          savingsRatio: 0.95,
          isProvablePartial: true,
        },
        index: {
          fileSize: 100000,
          moovOffset: 0,
          moovSize: 500,
          timescale: 1000,
          duration: 300,
          tracks: [],
          hasMoovAtStart: true,
        },
        probeResult: {
          format: {
            filename: params.outputClipPath,
            format_name: "mp4",
            duration: "100.0",
            size: "1000",
            bit_rate: "100000",
          },
          videoStream: {
            index: 0,
            codec: "av1",
            width: 3840,
            height: 2160,
            fps: 60,
          },
          duration: 100.0,
        },
        indexProbeResult: {
          index: {
            fileSize: 100000,
            moovOffset: 0,
            moovSize: 500,
            timescale: 1000,
            duration: 300,
            tracks: [],
            hasMoovAtStart: true,
          },
          capabilityProbeBytesTransferred: 100,
          headProbeBytesTransferred: 500,
          tailProbeBytesTransferred: 0,
          totalProbeBytesTransferred: 600,
        },
        transferredBytes: 4601,
        fullFileBytes: 100000,
        savingsPercent: 95,
      };
    });

    const result = await resumeJobWorkflow({
      jobPathOrDir: workspaceDir,
      adapters: [mockAdapter],
    });

    expect(result.job.status).toBe("completed");
    expect(result.selectedHq.formatId).toBe("2160p-av1");
    expect(result.selectedHq.directUrl).toBe("https://www.eporner.com/dload/fresh-2160p-av1.mp4");
    expect(result.timeRange.startSeconds).toBe(100.5);
    expect(result.timeRange.endSeconds).toBe(200.5);
    expect(selectiveFetchSpy).toHaveBeenCalledOnce();

    // Verify proxy was untouched
    const proxyStatAfter = await fs.stat(proxyPath);
    expect(proxyStatAfter.size).toBe(proxyStatBefore.size);
    expect(proxyStatAfter.mtimeMs).toBe(proxyStatBefore.mtimeMs);

    // Verify saved job.json is completed
    const savedJobJson = JSON.parse(await fs.readFile(jobJsonPath, "utf-8"));
    expect(savedJobJson.status).toBe("completed");
  });

  it("fails if existing proxy file is missing (does not silently re-download)", async () => {
    const workspaceDir = path.join(tmpDir, "eporner-missing-proxy");
    await fs.mkdir(workspaceDir, { recursive: true });

    const jobState: JobState = {
      jobId: "eporner-missing-proxy",
      status: "waiting-for-llc",
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:05:00.000Z",
      sourceUrl: "https://www.eporner.com/video-missing/sample/",
      provider: "eporner",
      providerAssetId: "missing",
      identity: {
        provider: "eporner",
        providerAssetId: "missing",
        observedTitle: "Missing Proxy",
        searchAliases: ["missing"],
        performers: [],
        confidence: "fallback",
        baseName: "eporner-missing",
      },
      workspaceDir,
      selectedProxy: {
        formatId: "480p-av1",
        resolution: "480p",
        height: 480,
        vcodec: "av1",
        directUrl: "https://www.eporner.com/dload/proxy.mp4",
      },
      proxyPath: path.join(workspaceDir, "missing.proxy.mp4"),
      expectedLlcPath: path.join(workspaceDir, "missing.llc"),
      finalOutputPath: path.join(workspaceDir, "missing.mp4"),
      renditions: [],
    };

    const jobJsonPath = path.join(workspaceDir, "job.json");
    await fs.writeFile(jobJsonPath, JSON.stringify(jobState, null, 2), "utf-8");

    await expect(
      resumeJobWorkflow({
        jobPathOrDir: workspaceDir,
      })
    ).rejects.toThrow("Proxy video file not found");
  });

  it("refuses to overwrite existing final output file", async () => {
    const workspaceDir = path.join(tmpDir, "eporner-out-exists");
    await fs.mkdir(workspaceDir, { recursive: true });

    const proxyPath = path.join(workspaceDir, "test.proxy.mp4");
    await fs.writeFile(proxyPath, "proxy-data");

    const llcPath = path.join(workspaceDir, "test.proxy-proj.llc");
    await fs.writeFile(llcPath, JSON.stringify({ cutSegments: [{ start: 10, end: 20 }] }));

    const finalOutputPath = path.join(workspaceDir, "test.mp4");
    await fs.writeFile(finalOutputPath, "existing-output-video-file");

    const jobState: JobState = {
      jobId: "eporner-out-exists",
      status: "waiting-for-llc",
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:05:00.000Z",
      sourceUrl: "https://www.eporner.com/video-exists/sample/",
      provider: "eporner",
      providerAssetId: "exists",
      identity: {
        provider: "eporner",
        providerAssetId: "exists",
        observedTitle: "Output Exists",
        searchAliases: ["exists"],
        performers: [],
        confidence: "fallback",
        baseName: "test",
      },
      workspaceDir,
      selectedProxy: {
        formatId: "480p-av1",
        resolution: "480p",
        height: 480,
        vcodec: "av1",
        directUrl: "https://www.eporner.com/dload/proxy.mp4",
      },
      proxyPath,
      expectedLlcPath: path.join(workspaceDir, "test.llc"),
      finalOutputPath,
      renditions: [],
    };

    const jobJsonPath = path.join(workspaceDir, "job.json");
    await fs.writeFile(jobJsonPath, JSON.stringify(jobState, null, 2), "utf-8");

    await expect(
      resumeJobWorkflow({
        jobPathOrDir: workspaceDir,
      })
    ).rejects.toThrow("Final output file already exists");
  });
});
