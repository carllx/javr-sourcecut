import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { extractClipFromPlan } from "../../../src/core/mp4/extractor.js";
import { probeMP4Index } from "../../../src/core/mp4/index-prober.js";
import { createByteRangeFetchPlan } from "../../../src/core/mp4/fetch-plan.js";
import { verifyMediaFile } from "../../../src/core/verifier.js";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

describe("FFmpeg Clip Extraction from Partial Fetch", () => {
  let tempDir: string;
  let faststartMp4Path: string;
  let tailMp4Path: string;
  let server: http.Server;
  let serverUrl: string;
  let faststartBuffer: Buffer;
  let tailBuffer: Buffer;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-extract-test-"));
    faststartMp4Path = path.join(tempDir, "faststart_video.mp4");
    tailMp4Path = path.join(tempDir, "tail_video.mp4");

    // 1. Create 15s faststart test video (moov at start)
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=15:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=15",
      "-c:v", "libx264", "-g", "30", "-keyint_min", "30",
      "-c:a", "aac",
      "-movflags", "+faststart",
      faststartMp4Path,
    ]);

    // 2. Create 15s non-faststart test video (moov at tail)
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=15:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=15",
      "-c:v", "libx264", "-g", "30", "-keyint_min", "30",
      "-c:a", "aac",
      tailMp4Path,
    ]);

    faststartBuffer = await fs.readFile(faststartMp4Path);
    tailBuffer = await fs.readFile(tailMp4Path);

    server = http.createServer((req, res) => {
      const url = req.url || "";
      const fileBuffer = url.includes("tail") ? tailBuffer : faststartBuffer;

      const rangeHeader = req.headers.range;
      if (!rangeHeader) {
        res.writeHead(200, { "Content-Length": fileBuffer.length.toString() });
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
  }, 30000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("fetches partial bytes and extracts verified clip of 4.0s - 7.5s from faststart MP4", async () => {
    const videoUrl = `${serverUrl}/faststart.mp4`;
    const probeResult = await probeMP4Index(videoUrl, { headProbeBytes: 64 * 1024 });
    const index = probeResult.index;
    const targetRange = { startSeconds: 4.0, endSeconds: 7.5 };
    const plan = createByteRangeFetchPlan(index, targetRange, videoUrl);

    const outputClipPath = path.join(tempDir, "extracted_faststart_clip.mp4");

    const result = await extractClipFromPlan({
      plan,
      index,
      outputClipPath,
      workDir: tempDir,
      cachedHead: probeResult.cachedHead,
    });

    expect(result.outputClipPath).toBe(outputClipPath);
    expect(result.bytesFetched).toBeLessThan(faststartBuffer.length * 0.5);

    // Verify extracted clip with ffprobe
    const probe = await verifyMediaFile(outputClipPath);
    expect(probe.isValid).toBe(true);
    expect(probe.duration).toBeGreaterThanOrEqual(3.3);
    expect(probe.duration).toBeLessThanOrEqual(4.0);
    expect(probe.videoStream.codec).toBe("h264");
    expect(probe.audioStream?.codec).toBe("aac");
  });

  it("extracts verified clip from tail-moov MP4 using relative cached tail moov slice", async () => {
    const videoUrl = `${serverUrl}/tail.mp4`;
    const probeResult = await probeMP4Index(videoUrl, {
      headProbeBytes: 1024,
      tailProbeBytes: 64 * 1024,
    });
    const index = probeResult.index;
    expect(index.hasMoovAtStart).toBe(false);
    expect(probeResult.cachedTail).toBeDefined();

    // Verify that tailProbeStart is strictly earlier than index.moovOffset
    expect(probeResult.cachedTail!.range.startByte).toBeLessThan(index.moovOffset);

    const targetRange = { startSeconds: 4.0, endSeconds: 7.5 };
    const plan = createByteRangeFetchPlan(index, targetRange, videoUrl);

    const outputClipPath = path.join(tempDir, "extracted_tail_clip.mp4");

    const result = await extractClipFromPlan({
      plan,
      index,
      outputClipPath,
      workDir: tempDir,
      cachedHead: probeResult.cachedHead,
      cachedTail: probeResult.cachedTail,
    });

    expect(result.outputClipPath).toBe(outputClipPath);
    expect(result.bytesFetched).toBeLessThan(tailBuffer.length * 0.5);

    // Verify extracted clip with ffprobe
    const probe = await verifyMediaFile(outputClipPath);
    expect(probe.isValid).toBe(true);
    expect(probe.duration).toBeGreaterThanOrEqual(3.3);
    expect(probe.duration).toBeLessThanOrEqual(4.0);
    expect(probe.videoStream.codec).toBe("h264");
    expect(probe.audioStream?.codec).toBe("aac");
  });
});
