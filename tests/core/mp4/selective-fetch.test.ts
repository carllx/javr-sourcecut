import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runSelectiveFetch } from "../../../src/core/mp4/selective-fetch.js";
import { Http206RequiredError, UnprovablePartialPlanError } from "../../../src/core/mp4/types.js";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

describe("Controlled Direct-MP4 Selective Fetch Orchestrator", () => {
  let tempDir: string;
  let faststartMp4Path: string;
  let tailMp4Path: string;
  let tinyMp4Path: string;
  let server: http.Server;
  let serverUrl: string;
  let faststartBuffer: Buffer;
  let tailBuffer: Buffer;
  let tinyBuffer: Buffer;
  let networkRequestLog: { url: string; rangeHeader?: string }[] = [];

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-orchestrator-test-"));
    faststartMp4Path = path.join(tempDir, "faststart_15s.mp4");
    tailMp4Path = path.join(tempDir, "tail_15s.mp4");
    tinyMp4Path = path.join(tempDir, "tiny_1s.mp4");

    // 1. 15s test video with 30fps and GOP 30 (+faststart)
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=15:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=15",
      "-c:v", "libx264", "-g", "30", "-keyint_min", "30",
      "-c:a", "aac",
      "-movflags", "+faststart",
      faststartMp4Path,
    ]);

    // 2. 15s test video with tail moov (non-faststart)
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=15:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=15",
      "-c:v", "libx264", "-g", "30", "-keyint_min", "30",
      "-c:a", "aac",
      tailMp4Path,
    ]);

    // 3. Tiny 1s test video (< 50KB)
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=10",
      "-c:v", "libx264", "-g", "10",
      "-movflags", "+faststart",
      tinyMp4Path,
    ]);

    faststartBuffer = await fs.readFile(faststartMp4Path);
    tailBuffer = await fs.readFile(tailMp4Path);
    tinyBuffer = await fs.readFile(tinyMp4Path);

    server = http.createServer((req, res) => {
      const url = req.url || "";
      const rangeHeader = req.headers.range;
      networkRequestLog.push({ url, rangeHeader });

      let targetBuffer = faststartBuffer;
      if (url.includes("tail")) {
        targetBuffer = tailBuffer;
      } else if (url.includes("tiny")) {
        targetBuffer = tinyBuffer;
      }

      if (url.includes("server-sends-200")) {
        res.writeHead(200, {
          "Content-Length": targetBuffer.length.toString(),
          "Content-Type": "video/mp4",
        });
        res.end(targetBuffer);
        return;
      }

      if (!rangeHeader) {
        res.writeHead(200, {
          "Content-Length": targetBuffer.length.toString(),
          "Content-Type": "video/mp4",
        });
        res.end(targetBuffer);
        return;
      }

      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const requestedEnd = match[2] ? parseInt(match[2], 10) : targetBuffer.length - 1;
        const end = Math.min(requestedEnd, targetBuffer.length - 1);
        const chunk = targetBuffer.subarray(start, end + 1);

        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${targetBuffer.length}`,
          "Content-Length": chunk.length.toString(),
          "Content-Type": "video/mp4",
        });
        res.end(chunk);
        return;
      }

      res.writeHead(400);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }, 30000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("executes full selective-fetch tracer slice on faststart MP4, accounting for all network probe bytes", async () => {
    networkRequestLog = [];
    const videoUrl = `${serverUrl}/faststart.mp4`;
    const outputClipPath = path.join(tempDir, "clip_5_6.mp4");

    const result = await runSelectiveFetch({
      sourceUrl: videoUrl,
      timeRange: { startSeconds: 5.0, endSeconds: 6.0 },
      outputClipPath,
      workDir: tempDir,
    });

    expect(result.outputClipPath).toBe(outputClipPath);
    expect(result.plan.targetTimeRange).toEqual({ startSeconds: 5.0, endSeconds: 6.0 });
    expect(result.plan.isProvablePartial).toBe(true);

    // Total transferred network bytes includes 1-byte capability probe + head probe + media fetch
    expect(result.indexProbeResult.capabilityProbeBytesTransferred).toBe(1);
    expect(result.indexProbeResult.headProbeBytesTransferred).toBeGreaterThan(0);
    expect(result.transferredBytes).toBeGreaterThan(
      result.indexProbeResult.totalProbeBytesTransferred
    );
    expect(result.transferredBytes).toBeLessThan(faststartBuffer.length * 0.7);
    expect(result.savingsPercent).toBeGreaterThan(30);

    // ffprobe verified
    expect(result.probeResult.isValid).toBe(true);
    expect(result.probeResult.duration).toBeGreaterThanOrEqual(0.8);
    expect(result.probeResult.duration).toBeLessThanOrEqual(1.5);
    expect(result.probeResult.videoStream.codec).toBe("h264");
    expect(result.probeResult.audioStream?.codec).toBe("aac");
  });

  it("executes full selective-fetch tracer slice on tail-moov MP4 using accurate cached tail slice", async () => {
    networkRequestLog = [];
    const videoUrl = `${serverUrl}/tail.mp4`;
    const outputClipPath = path.join(tempDir, "clip_tail_5_6.mp4");

    const result = await runSelectiveFetch({
      sourceUrl: videoUrl,
      timeRange: { startSeconds: 5.0, endSeconds: 6.0 },
      outputClipPath,
      workDir: tempDir,
      options: { headProbeBytes: 1024, tailProbeBytes: 64 * 1024 },
    });

    expect(result.outputClipPath).toBe(outputClipPath);
    expect(result.index.hasMoovAtStart).toBe(false);
    expect(result.indexProbeResult.tailProbeBytesTransferred).toBeGreaterThan(0);
    expect(result.transferredBytes).toBeLessThan(tailBuffer.length * 0.8);

    // ffprobe verified
    expect(result.probeResult.isValid).toBe(true);
    expect(result.probeResult.duration).toBeGreaterThanOrEqual(0.8);
  });

  it("fails closed on tiny MP4 without issuing a full-file probe request", async () => {
    networkRequestLog = [];
    const videoUrl = `${serverUrl}/tiny.mp4`;
    const outputClipPath = path.join(tempDir, "failed_tiny.mp4");

    await expect(
      runSelectiveFetch({
        sourceUrl: videoUrl,
        timeRange: { startSeconds: 0.2, endSeconds: 0.8 },
        outputClipPath,
        workDir: tempDir,
      })
    ).rejects.toThrow(UnprovablePartialPlanError);

    // Verify network log: Stage A requested 0-0, Stage B requested bounded range < fileSize - 1
    // NEVER requested bytes=0-(fileSize-1) (full file)
    for (const req of networkRequestLog) {
      if (req.rangeHeader) {
        expect(req.rangeHeader).not.toBe(`bytes=0-${tinyBuffer.length - 1}`);
      }
    }
  });

  it("fails closed before media fetch when total expected network bytes spans full file", async () => {
    networkRequestLog = [];
    const videoUrl = `${serverUrl}/faststart.mp4`;
    const outputClipPath = path.join(tempDir, "failed_budget_exceeded.mp4");

    // Time range spanning 95% of video
    await expect(
      runSelectiveFetch({
        sourceUrl: videoUrl,
        timeRange: { startSeconds: 0.0, endSeconds: 14.5 },
        outputClipPath,
        workDir: tempDir,
      })
    ).rejects.toThrow(UnprovablePartialPlanError);

    // Ensure only capability probe (0-0) and head probe (0-headEnd) occurred; NO media payload fetch
    expect(networkRequestLog.length).toBeLessThanOrEqual(2);
    for (const req of networkRequestLog) {
      expect(req.rangeHeader).toMatch(/^bytes=0-/);
    }
  });

  it("fails closed when remote server returns 200 OK (no silent full-file fallback)", async () => {
    const videoUrl = `${serverUrl}/server-sends-200.mp4`;
    const outputClipPath = path.join(tempDir, "failed_clip.mp4");

    await expect(
      runSelectiveFetch({
        sourceUrl: videoUrl,
        timeRange: { startSeconds: 5.0, endSeconds: 8.0 },
        outputClipPath,
        workDir: tempDir,
      })
    ).rejects.toThrow(Http206RequiredError);
  });

  it("executes multi-segment selective fetch with budget tracking and merges segments into coherent verified output", async () => {
    networkRequestLog = [];
    const videoUrl = `${serverUrl}/faststart.mp4`;
    const outputClipPath = path.join(tempDir, "multi_clip_merged.mp4");

    const result = await runSelectiveFetch({
      sourceUrl: videoUrl,
      timeRanges: [
        { startSeconds: 2.0, endSeconds: 4.0 },
        { startSeconds: 9.0, endSeconds: 11.0 },
      ],
      outputClipPath,
      workDir: path.join(tempDir, "multi-sel-workdir"),
      options: {
        budgetMultiplier: 1.5,
      },
    });

    expect(result.outputClipPath).toBe(outputClipPath);
    expect(result.multiPlan).toBeDefined();
    expect(result.multiPlan?.discreteByteRanges.length).toBe(2);

    // Verify final merged probe
    expect(result.probeResult.isValid).toBe(true);
    expect(result.probeResult.duration).toBeGreaterThanOrEqual(3.5);
    expect(result.probeResult.duration).toBeLessThanOrEqual(5.0);
    expect(result.probeResult.videoStream.codec).toBe("h264");
    expect(result.savingsPercent).toBeGreaterThanOrEqual(10);
  });
});





