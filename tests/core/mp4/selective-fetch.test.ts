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
  let testMp4Path: string;
  let server: http.Server;
  let serverUrl: string;
  let fileBuffer: Buffer;
  let networkRequestLog: { url: string; rangeHeader?: string }[] = [];

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-orchestrator-test-"));
    testMp4Path = path.join(tempDir, "source_20s.mp4");

    // 20s test video with 30fps and GOP 30
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=20:size=480x360:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=20",
      "-c:v", "libx264", "-g", "30", "-keyint_min", "30",
      "-c:a", "aac",
      "-movflags", "+faststart",
      testMp4Path,
    ]);

    fileBuffer = await fs.readFile(testMp4Path);

    server = http.createServer((req, res) => {
      const url = req.url || "";
      const rangeHeader = req.headers.range;
      networkRequestLog.push({ url, rangeHeader });

      if (url.includes("server-sends-200")) {
        res.writeHead(200, {
          "Content-Length": fileBuffer.length.toString(),
          "Content-Type": "video/mp4",
        });
        res.end(fileBuffer);
        return;
      }

      if (!rangeHeader) {
        res.writeHead(200, {
          "Content-Length": fileBuffer.length.toString(),
          "Content-Type": "video/mp4",
        });
        res.end(fileBuffer);
        return;
      }

      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const requestedEnd = match[2] ? parseInt(match[2], 10) : fileBuffer.length - 1;
        const end = Math.min(requestedEnd, fileBuffer.length - 1);
        const chunk = fileBuffer.subarray(start, end + 1);

        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${fileBuffer.length}`,
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
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("executes full selective-fetch tracer slice, accounts for probe bytes, and verifies output clip with ffprobe", async () => {
    networkRequestLog = [];
    const videoUrl = `${serverUrl}/video.mp4`;
    const outputClipPath = path.join(tempDir, "clip_10_13.mp4");

    const result = await runSelectiveFetch({
      sourceUrl: videoUrl,
      timeRange: { startSeconds: 10.0, endSeconds: 13.5 },
      outputClipPath,
      workDir: tempDir,
      options: { headProbeBytes: 64 * 1024 },
    });

    expect(result.outputClipPath).toBe(outputClipPath);
    expect(result.plan.targetTimeRange).toEqual({ startSeconds: 10.0, endSeconds: 13.5 });
    expect(result.plan.isProvablePartial).toBe(true);

    // Total transferred network bytes includes head probe + media fetch
    expect(result.indexProbeResult.headProbeBytesTransferred).toBeGreaterThan(0);
    expect(result.transferredBytes).toBeGreaterThan(
      result.indexProbeResult.totalProbeBytesTransferred
    );
    expect(result.transferredBytes).toBeLessThan(fileBuffer.length * 0.5);
    expect(result.savingsPercent).toBeGreaterThan(50);

    // ffprobe verified
    expect(result.probeResult.isValid).toBe(true);
    expect(result.probeResult.duration).toBeGreaterThanOrEqual(3.3);
    expect(result.probeResult.duration).toBeLessThanOrEqual(4.0);
    expect(result.probeResult.videoStream.codec).toBe("h264");
    expect(result.probeResult.audioStream?.codec).toBe("aac");
  });

  it("fails closed before media fetch when time range spans full file (not provably partial)", async () => {
    networkRequestLog = [];
    const videoUrl = `${serverUrl}/full-span-video.mp4`;
    const outputClipPath = path.join(tempDir, "failed_full_span.mp4");

    // Full 20s span
    await expect(
      runSelectiveFetch({
        sourceUrl: videoUrl,
        timeRange: { startSeconds: 0.0, endSeconds: 20.0 },
        outputClipPath,
        workDir: tempDir,
      })
    ).rejects.toThrow(UnprovablePartialPlanError);

    // Ensure only head probe occurred; NO media payload fetch was performed
    expect(networkRequestLog.length).toBe(1);
    expect(networkRequestLog[0].rangeHeader).toMatch(/bytes=0-/);
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
});
