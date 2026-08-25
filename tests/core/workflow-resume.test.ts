import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resumeJobWorkflow } from "../../src/core/workflow.js";
import { NoopSessionProvider } from "../../src/core/session.js";
import { saveJob, loadJob } from "../../src/core/job.js";
import type { JobState, SourceAdapter, SourceDescriptor } from "../../src/types.js";
import * as selectiveFetchModule from "../../src/core/mp4/selective-fetch.js";

function createSampleJob(workspaceDir: string): JobState {
  const proxyPath = path.join(workspaceDir, "test.proxy.mp4");
  return {
    jobId: "test-job",
    status: "waiting-for-llc",
    createdAt: "2026-08-25T10:00:00.000Z",
    updatedAt: "2026-08-25T10:05:00.000Z",
    sourceUrl: "https://example.com/video-test/",
    provider: "eporner",
    providerAssetId: "test",
    identity: {
      provider: "eporner",
      providerAssetId: "test",
      observedTitle: "Test",
      searchAliases: ["test"],
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
      directUrl: "https://example.com/proxy.mp4",
    },
    proxyPath,
    expectedLlcPath: path.join(workspaceDir, "test.llc"),
    finalOutputPath: path.join(workspaceDir, "test.mp4"),
    renditions: [],
  };
}

describe("Workflow Resume E2E", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "javr-resume-test-"));
    vi.stubEnv("JAVR_PROFILES_DIR", path.join(tmpDir, "profiles"));
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

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      return new Response(new Uint8Array([0x00]), {
        status: 206,
        headers: {
          "Content-Range": "bytes 0-0/100000",
          "Content-Length": "1",
        },
      });
    });

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
      fetchFn: mockFetch as any,
      sessionProvider: new NoopSessionProvider(),
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

  // Rule 6: Job is NOT set to completed when target quality is inaccessible (status becomes needs-user-intervention)
  it("Rule 6: persists status as needs-user-intervention when target quality is inaccessible", async () => {
    const workspaceDir = path.join(tmpDir, "eporner-intervention-test");
    await fs.mkdir(workspaceDir, { recursive: true });

    const proxyPath = path.join(workspaceDir, "test.proxy.mp4");
    await fs.writeFile(proxyPath, "dummy-proxy");

    const llcPath = path.join(workspaceDir, "test.proxy-proj.llc");
    await fs.writeFile(llcPath, JSON.stringify({ cutSegments: [{ start: 10, end: 20 }] }));

    const jobState: JobState = {
      jobId: "eporner-intervention-test",
      status: "waiting-for-llc",
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:05:00.000Z",
      sourceUrl: "https://www.eporner.com/video-test/sample/",
      provider: "eporner",
      providerAssetId: "test",
      identity: {
        provider: "eporner",
        providerAssetId: "test",
        observedTitle: "Test",
        searchAliases: ["test"],
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
      finalOutputPath: path.join(workspaceDir, "test.mp4"),
      renditions: [],
    };

    const jobJsonPath = path.join(workspaceDir, "job.json");
    await fs.writeFile(jobJsonPath, JSON.stringify(jobState, null, 2));

    const mockDescriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "test",
      sourceUrl: "https://www.eporner.com/video-test/sample/",
      rawTitle: "Test",
      declaredPerformers: [],
      renditions: [
        { formatId: "2160p-av1", resolution: "2160p", height: 2160, vcodec: "av1", directUrl: "https://example.com/2160-av1" },
        { formatId: "720p-av1", resolution: "720p", height: 720, vcodec: "av1", directUrl: "https://example.com/720-av1" },
      ],
    };

    const mockAdapter: SourceAdapter = {
      provider: "eporner",
      canHandle: () => true,
      resolve: vi.fn().mockResolvedValue(mockDescriptor),
    };

    // 2160p-av1 returns 200 (login required)
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: { cancel: vi.fn() },
    });

    await expect(
      resumeJobWorkflow({
        jobPathOrDir: workspaceDir,
        adapters: [mockAdapter],
        fetchFn: mockFetch as any,
        sessionProvider: new NoopSessionProvider(),
      })
    ).rejects.toThrow("All candidates at target resolution 2160p failed live Range capability");

    const savedJob = JSON.parse(await fs.readFile(jobJsonPath, "utf-8"));
    expect(savedJob.status).toBe("needs-user-intervention");
    expect(savedJob.qualityTarget?.targetHeight).toBe(2160);
    expect(savedJob.qualityTarget?.preferredCodec).toBe("av1");
    expect(savedJob.interventionReason).toContain("2160p");
  });

  // Test D: explicit resolution override persists requested target on intervention
  it("Test D: persists requested targetHeight=1440 when 1440p resolution is requested but inaccessible", async () => {
    const workspaceDir = path.join(tmpDir, "eporner-1440-intervention");
    await fs.mkdir(workspaceDir, { recursive: true });

    const proxyPath = path.join(workspaceDir, "test.proxy.mp4");
    await fs.writeFile(proxyPath, "dummy-proxy");

    const llcPath = path.join(workspaceDir, "test.proxy-proj.llc");
    await fs.writeFile(llcPath, JSON.stringify({ cutSegments: [{ start: 10, end: 20 }] }));

    const jobState: JobState = {
      jobId: "eporner-1440-intervention",
      status: "waiting-for-llc",
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:05:00.000Z",
      sourceUrl: "https://www.eporner.com/video-test/sample/",
      provider: "eporner",
      providerAssetId: "test",
      identity: {
        provider: "eporner",
        providerAssetId: "test",
        observedTitle: "Test",
        searchAliases: ["test"],
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
      finalOutputPath: path.join(workspaceDir, "test.mp4"),
      renditions: [],
    };

    const jobJsonPath = path.join(workspaceDir, "job.json");
    await fs.writeFile(jobJsonPath, JSON.stringify(jobState, null, 2));

    const mockDescriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "test",
      sourceUrl: "https://www.eporner.com/video-test/sample/",
      rawTitle: "Test",
      declaredPerformers: [],
      renditions: [
        { formatId: "2160p-av1", resolution: "2160p", height: 2160, vcodec: "av1", directUrl: "https://example.com/2160-av1" },
        { formatId: "1440p-av1", resolution: "1440p", height: 1440, vcodec: "av1", directUrl: "https://example.com/1440-av1" },
      ],
    };

    const mockAdapter: SourceAdapter = {
      provider: "eporner",
      canHandle: () => true,
      resolve: vi.fn().mockResolvedValue(mockDescriptor),
    };

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: { cancel: vi.fn() },
    });

    await expect(
      resumeJobWorkflow({
        jobPathOrDir: workspaceDir,
        qualityTarget: { resolution: "1440p" },
        adapters: [mockAdapter],
        fetchFn: mockFetch as any,
        sessionProvider: new NoopSessionProvider(),
      })
    ).rejects.toThrow("All candidates at target resolution 1440p failed live Range capability");

    const savedJob = JSON.parse(await fs.readFile(jobJsonPath, "utf-8"));
    expect(savedJob.status).toBe("needs-user-intervention");
    expect(savedJob.qualityTarget?.targetHeight).toBe(1440);
    expect(savedJob.qualityTarget?.requestedResolution).toBe("1440p");
    expect(savedJob.qualityTarget?.explicitOverride).toBe(true);
  });

  // Test E: Workflow ledger: hqSelectionProbeBytes + selectiveFetchBytes = totalHqLifecycleBytes
  it("Test E: enforces workflow network ledger: hqSelectionProbeBytes + selectiveFetchBytes === totalHqLifecycleBytes", async () => {
    const workspaceDir = path.join(tmpDir, "eporner-ledger-test");
    await fs.mkdir(workspaceDir, { recursive: true });

    const proxyPath = path.join(workspaceDir, "test.proxy.mp4");
    await fs.writeFile(proxyPath, "dummy-proxy");

    const llcPath = path.join(workspaceDir, "test.proxy-proj.llc");
    await fs.writeFile(llcPath, JSON.stringify({ cutSegments: [{ start: 10, end: 20 }] }));

    const jobState: JobState = {
      jobId: "eporner-ledger-test",
      status: "waiting-for-llc",
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:05:00.000Z",
      sourceUrl: "https://www.eporner.com/video-test/sample/",
      provider: "eporner",
      providerAssetId: "test",
      identity: {
        provider: "eporner",
        providerAssetId: "test",
        observedTitle: "Ledger Test",
        searchAliases: ["test"],
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
      finalOutputPath: path.join(workspaceDir, "test.mp4"),
      renditions: [],
    };

    const jobJsonPath = path.join(workspaceDir, "job.json");
    await fs.writeFile(jobJsonPath, JSON.stringify(jobState, null, 2));

    const mockDescriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "test",
      sourceUrl: "https://www.eporner.com/video-test/sample/",
      rawTitle: "Ledger Test",
      declaredPerformers: [],
      renditions: [
        { formatId: "720p-av1", resolution: "720p", height: 720, vcodec: "av1", directUrl: "https://example.com/720-av1" },
      ],
    };

    const mockAdapter: SourceAdapter = {
      provider: "eporner",
      canHandle: () => true,
      resolve: vi.fn().mockResolvedValue(mockDescriptor),
    };

    // Range probe succeeds with 1 byte consumed
    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(new Uint8Array([0x00]), {
        status: 206,
        headers: {
          "Content-Range": "bytes 0-0/50000000",
          "Content-Type": "video/mp4",
          "Content-Length": "1",
        },
      });
    });

    vi.spyOn(selectiveFetchModule, "runSelectiveFetch").mockImplementation(async (params) => {
      await fs.writeFile(params.outputClipPath, "mock-output");
      params.onProbeBytesTransferred?.(100);
      params.onProbeBytesTransferred?.(1);
      params.onDataBytesTransferred?.(401);

      return {
        outputClipPath: params.outputClipPath,
        plan: {
          sourceUrl: params.sourceUrl,
          targetTimeRange: params.timeRange,
          keyframeAlignedTimeRange: params.timeRange,
          videoByteRange: { startByte: 100, endByte: 500 },
          combinedByteRange: { startByte: 100, endByte: 500 },
          segmentRanges: [{ startByte: 100, endByte: 500 }],
          totalBytesToFetch: 401,
          fullFileBytes: 50000000,
          savingsRatio: 0.99,
          isProvablePartial: true,
        },
        index: {
          fileSize: 50000000,
          moovOffset: 0,
          moovSize: 100,
          timescale: 1000,
          duration: 10,
          tracks: [],
          hasMoovAtStart: true,
        },
        probeResult: {
          format: { filename: params.outputClipPath, format_name: "mp4", duration: "10.0", size: "401", bit_rate: "100" },
          videoStream: { index: 0, codec: "av1", width: 1280, height: 720, fps: 30 },
          duration: 10.0,
        },
        indexProbeResult: {
          index: { fileSize: 50000000, moovOffset: 0, moovSize: 100, timescale: 1000, duration: 10, tracks: [], hasMoovAtStart: true },
          capabilityProbeBytesTransferred: 1,
          headProbeBytesTransferred: 100,
          tailProbeBytesTransferred: 0,
          totalProbeBytesTransferred: 101,
        },
        transferredBytes: 502, // 101 probe + 401 data
        fullFileBytes: 50000000,
        savingsPercent: 99,
      };
    });

    const result = await resumeJobWorkflow({
      jobPathOrDir: workspaceDir,
      adapters: [mockAdapter],
      qualityTarget: { height: 720 },
      fetchFn: mockFetch as any,
      sessionProvider: new NoopSessionProvider(),
    });

    expect(result.hqSelectionProbeBytes).toBe(1);
    expect(result.selectiveFetchBytes).toBe(502);
    expect(result.totalHqLifecycleBytes).toBe(result.hqSelectionProbeBytes + result.selectiveFetchBytes);
    expect(result.totalHqLifecycleBytes).toBe(503);
    expect(result.selectedFullFileBytes).toBe(50000000);
    expect(result.selectiveFetchSavingsPercent).toBe(99);
    expect(result.lifecycleSavingsPercent).toBe(100);
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
        sessionProvider: new NoopSessionProvider(),
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
        qualityTarget: { height: 480 },
        sessionProvider: new NoopSessionProvider(),
      })
    ).rejects.toThrow("Final output file already exists");
  });

  // Test F: Regression test proving mocked workflow tests do not access or launch the default real BrowserProfile
  it("Test F: regression test proving mocked workflow tests do not access or launch the default real BrowserProfile", async () => {
    const workspaceDir = path.join(tmpDir, "eporner-isolation-test");
    await fs.mkdir(workspaceDir, { recursive: true });

    const proxyPath = path.join(workspaceDir, "test.proxy.mp4");
    await fs.writeFile(proxyPath, "proxy-data");

    const llcPath = path.join(workspaceDir, "test.proxy-proj.llc");
    await fs.writeFile(llcPath, JSON.stringify({ cutSegments: [{ start: 10, end: 20 }] }));

    const jobState: JobState = {
      jobId: "eporner-isolation-test",
      status: "waiting-for-llc",
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:05:00.000Z",
      sourceUrl: "https://www.eporner.com/video-test/sample/",
      provider: "eporner",
      providerAssetId: "test",
      identity: {
        provider: "eporner",
        providerAssetId: "test",
        observedTitle: "Isolation Test",
        searchAliases: ["test"],
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
      finalOutputPath: path.join(workspaceDir, "test.mp4"),
      renditions: [],
    };

    const jobJsonPath = path.join(workspaceDir, "job.json");
    await fs.writeFile(jobJsonPath, JSON.stringify(jobState, null, 2));

    const mockDescriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "test",
      sourceUrl: "https://www.eporner.com/video-test/sample/",
      rawTitle: "Isolation Test",
      declaredPerformers: [],
      renditions: [
        { formatId: "720p-av1", resolution: "720p", height: 720, vcodec: "av1", directUrl: "https://example.com/720-av1" },
      ],
    };

    const mockAdapter: SourceAdapter = {
      provider: "eporner",
      canHandle: () => true,
      resolve: vi.fn().mockResolvedValue(mockDescriptor),
    };

    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(new Uint8Array([0x00]), {
        status: 206,
        headers: {
          "Content-Range": "bytes 0-0/1000000",
          "Content-Type": "video/mp4",
          "Content-Length": "1",
        },
      });
    });

    vi.spyOn(selectiveFetchModule, "runSelectiveFetch").mockImplementation(async (params) => {
      await fs.writeFile(params.outputClipPath, "mock-output");
      return {
        outputClipPath: params.outputClipPath,
        plan: {
          sourceUrl: params.sourceUrl,
          targetTimeRange: params.timeRange,
          keyframeAlignedTimeRange: params.timeRange,
          videoByteRange: { startByte: 100, endByte: 500 },
          combinedByteRange: { startByte: 100, endByte: 500 },
          segmentRanges: [{ startByte: 100, endByte: 500 }],
          totalBytesToFetch: 401,
          fullFileBytes: 1000000,
          savingsRatio: 0.99,
          isProvablePartial: true,
        },
        index: {
          fileSize: 1000000,
          moovOffset: 0,
          moovSize: 100,
          timescale: 1000,
          duration: 10,
          tracks: [],
          hasMoovAtStart: true,
        },
        probeResult: {
          format: { filename: params.outputClipPath, format_name: "mp4", duration: "10.0", size: "401", bit_rate: "100" },
          videoStream: { index: 0, codec: "av1", width: 1280, height: 720, fps: 30 },
          duration: 10.0,
        },
        indexProbeResult: {
          index: { fileSize: 1000000, moovOffset: 0, moovSize: 100, timescale: 1000, duration: 10, tracks: [], hasMoovAtStart: true },
          capabilityProbeBytesTransferred: 1,
          headProbeBytesTransferred: 100,
          tailProbeBytesTransferred: 0,
          totalProbeBytesTransferred: 100,
        },
        transferredBytes: 501,
        fullFileBytes: 1000000,
        savingsPercent: 99,
      };
    });

    // Run without passing sessionProvider to verify JAVR_PROFILES_DIR points to isolated temp dir
    const result = await resumeJobWorkflow({
      jobPathOrDir: workspaceDir,
      adapters: [mockAdapter],
      fetchFn: mockFetch as any,
    });

    expect(result.job.status).toBe("completed");
    expect(process.env.JAVR_PROFILES_DIR).toBe(path.join(tmpDir, "profiles"));
  });

  it("Test G: rejects completed status if verified video codec does not match selected HQ codec (e.g. AV1 vs H264)", async () => {
    const workspaceDir = path.join(tmpDir, "codec-mismatch-workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const job = createSampleJob(workspaceDir);
    await saveJob(job);
    await fs.writeFile(job.proxyPath, "proxy-content");
    await fs.writeFile(
      job.expectedLlcPath,
      JSON.stringify({
        version: 1,
        mediaFileName: "test.mp4",
        cutSegments: [{ start: 10, end: 20 }],
      })
    );

    const mockDescriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "test-codec",
      sourceUrl: job.sourceUrl,
      rawTitle: "Codec Mismatch Test",
      declaredPerformers: [],
      renditions: [
        { formatId: "720p-av1", resolution: "720p", height: 720, vcodec: "av1", directUrl: "https://example.com/720-av1" },
      ],
    };

    const mockAdapter: SourceAdapter = {
      provider: "eporner",
      canHandle: () => true,
      resolve: vi.fn().mockResolvedValue(mockDescriptor),
    };

    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(new Uint8Array([0x00]), {
        status: 206,
        headers: { "Content-Range": "bytes 0-0/1000000", "Content-Type": "video/mp4", "Content-Length": "1" },
      });
    });

    // Simulate selective fetch returning H264 probeResult when AV1 was selected
    vi.spyOn(selectiveFetchModule, "runSelectiveFetch").mockImplementation(async (params) => {
      await fs.writeFile(params.outputClipPath, "mock-output");
      return {
        outputClipPath: params.outputClipPath,
        plan: {} as any,
        index: {} as any,
        probeResult: {
          format: { filename: params.outputClipPath, duration: "10.0" } as any,
          videoStream: { index: 0, codec: "h264", width: 1280, height: 720, fps: 30 },
          duration: 10.0,
          isValid: true,
        },
        indexProbeResult: {} as any,
        transferredBytes: 500,
        fullFileBytes: 1000000,
        savingsPercent: 99,
      };
    });

    await expect(
      resumeJobWorkflow({
        jobPathOrDir: workspaceDir,
        adapters: [mockAdapter],
        fetchFn: mockFetch as any,
        sessionProvider: new NoopSessionProvider(),
      })
    ).rejects.toThrow(/Output video codec mismatch: expected "av1"/);

    // Verify job status was NOT set to completed
    const savedJob = await loadJob(workspaceDir);
    expect(savedJob.status).not.toBe("completed");
  });

  it("Test H: rejects completed status if verified video height does not match selected HQ height", async () => {
    const workspaceDir = path.join(tmpDir, "height-mismatch-workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const job = createSampleJob(workspaceDir);
    await saveJob(job);
    await fs.writeFile(job.proxyPath, "proxy-content");
    await fs.writeFile(
      job.expectedLlcPath,
      JSON.stringify({
        version: 1,
        mediaFileName: "test.mp4",
        cutSegments: [{ start: 10, end: 20 }],
      })
    );

    const mockDescriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "test-height",
      sourceUrl: job.sourceUrl,
      rawTitle: "Height Mismatch Test",
      declaredPerformers: [],
      renditions: [
        { formatId: "720p-av1", resolution: "720p", height: 720, vcodec: "av1", directUrl: "https://example.com/720-av1" },
      ],
    };

    const mockAdapter: SourceAdapter = {
      provider: "eporner",
      canHandle: () => true,
      resolve: vi.fn().mockResolvedValue(mockDescriptor),
    };

    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(new Uint8Array([0x00]), {
        status: 206,
        headers: { "Content-Range": "bytes 0-0/1000000", "Content-Type": "video/mp4", "Content-Length": "1" },
      });
    });

    // Simulate selective fetch returning 480p height when 720p was selected
    vi.spyOn(selectiveFetchModule, "runSelectiveFetch").mockImplementation(async (params) => {
      await fs.writeFile(params.outputClipPath, "mock-output");
      return {
        outputClipPath: params.outputClipPath,
        plan: {} as any,
        index: {} as any,
        probeResult: {
          format: { filename: params.outputClipPath, duration: "10.0" } as any,
          videoStream: { index: 0, codec: "av1", width: 854, height: 480, fps: 30 },
          duration: 10.0,
          isValid: true,
        },
        indexProbeResult: {} as any,
        transferredBytes: 500,
        fullFileBytes: 1000000,
        savingsPercent: 99,
      };
    });

    await expect(
      resumeJobWorkflow({
        jobPathOrDir: workspaceDir,
        adapters: [mockAdapter],
        fetchFn: mockFetch as any,
        sessionProvider: new NoopSessionProvider(),
      })
    ).rejects.toThrow(/Output video height mismatch: expected 720p, but ffprobe verified 480p/);

    const savedJob = await loadJob(workspaceDir);
    expect(savedJob.status).not.toBe("completed");
  });

  it("Test I: rejects completed status if verified duration deviates excessively from LLC timeRange", async () => {
    const workspaceDir = path.join(tmpDir, "duration-mismatch-workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const job = createSampleJob(workspaceDir);
    await saveJob(job);
    await fs.writeFile(job.proxyPath, "proxy-content");
    await fs.writeFile(
      job.expectedLlcPath,
      JSON.stringify({
        version: 1,
        mediaFileName: "test.mp4",
        cutSegments: [{ start: 10, end: 20 }], // 10s duration
      })
    );

    const mockDescriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "test-duration",
      sourceUrl: job.sourceUrl,
      rawTitle: "Duration Mismatch Test",
      declaredPerformers: [],
      renditions: [
        { formatId: "720p-av1", resolution: "720p", height: 720, vcodec: "av1", directUrl: "https://example.com/720-av1" },
      ],
    };

    const mockAdapter: SourceAdapter = {
      provider: "eporner",
      canHandle: () => true,
      resolve: vi.fn().mockResolvedValue(mockDescriptor),
    };

    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(new Uint8Array([0x00]), {
        status: 206,
        headers: { "Content-Range": "bytes 0-0/1000000", "Content-Type": "video/mp4", "Content-Length": "1" },
      });
    });

    // Simulate selective fetch returning 100s duration instead of 10s
    vi.spyOn(selectiveFetchModule, "runSelectiveFetch").mockImplementation(async (params) => {
      await fs.writeFile(params.outputClipPath, "mock-output");
      return {
        outputClipPath: params.outputClipPath,
        plan: {} as any,
        index: {} as any,
        probeResult: {
          format: { filename: params.outputClipPath, duration: "100.0" } as any,
          videoStream: { index: 0, codec: "av1", width: 1280, height: 720, fps: 30 },
          duration: 100.0,
          isValid: true,
        },
        indexProbeResult: {} as any,
        transferredBytes: 500,
        fullFileBytes: 1000000,
        savingsPercent: 99,
      };
    });

    await expect(
      resumeJobWorkflow({
        jobPathOrDir: workspaceDir,
        adapters: [mockAdapter],
        fetchFn: mockFetch as any,
        sessionProvider: new NoopSessionProvider(),
      })
    ).rejects.toThrow(/Output duration mismatch: expected ~10.000s/);

    const savedJob = await loadJob(workspaceDir);
    expect(savedJob.status).not.toBe("completed");
  });

  it("Test J: completes workflow when verified AV1 / 2160p / duration match expectations", async () => {
    const workspaceDir = path.join(tmpDir, "valid-av1-workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const job = createSampleJob(workspaceDir);
    await saveJob(job);
    await fs.writeFile(job.proxyPath, "proxy-content");
    await fs.writeFile(
      job.expectedLlcPath,
      JSON.stringify({
        version: 1,
        mediaFileName: "test.mp4",
        cutSegments: [{ start: 10, end: 20 }], // 10s
      })
    );

    const mockDescriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "test-valid-2160",
      sourceUrl: job.sourceUrl,
      rawTitle: "Valid 2160p Test",
      declaredPerformers: [],
      renditions: [
        { formatId: "2160p-av1", resolution: "2160p", height: 2160, vcodec: "av1", directUrl: "https://example.com/2160-av1" },
      ],
    };

    const mockAdapter: SourceAdapter = {
      provider: "eporner",
      canHandle: () => true,
      resolve: vi.fn().mockResolvedValue(mockDescriptor),
    };

    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(new Uint8Array([0x00]), {
        status: 206,
        headers: { "Content-Range": "bytes 0-0/1000000", "Content-Type": "video/mp4", "Content-Length": "1" },
      });
    });

    vi.spyOn(selectiveFetchModule, "runSelectiveFetch").mockImplementation(async (params) => {
      await fs.writeFile(params.outputClipPath, "mock-output");
      return {
        outputClipPath: params.outputClipPath,
        plan: {} as any,
        index: {} as any,
        probeResult: {
          format: { filename: params.outputClipPath, duration: "10.05" } as any,
          videoStream: { index: 0, codec: "av01", width: 4320, height: 2160, fps: 60 },
          duration: 10.05,
          isValid: true,
        },
        indexProbeResult: {} as any,
        transferredBytes: 500,
        fullFileBytes: 1000000,
        savingsPercent: 99,
      };
    });

    const result = await resumeJobWorkflow({
      jobPathOrDir: workspaceDir,
      adapters: [mockAdapter],
      fetchFn: mockFetch as any,
      sessionProvider: new NoopSessionProvider(),
    });

    expect(result.job.status).toBe("completed");
    expect(result.selectedHq.formatId).toBe("2160p-av1");
    expect(result.outputClipPath).toBe(path.join(workspaceDir, "test.mp4"));
  });
});
