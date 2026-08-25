import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { extractClipFromPlan } from "../../../src/core/mp4/extractor.js";
import { probeMP4Index } from "../../../src/core/mp4/index-prober.js";
import { createByteRangeFetchPlan } from "../../../src/core/mp4/fetch-plan.js";
import { fetchByteRange } from "../../../src/core/mp4/partial-fetcher.js";
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
  let testMp4Path: string;
  let server: http.Server;
  let serverUrl: string;
  let fileBuffer: Buffer;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-extract-test-"));
    testMp4Path = path.join(tempDir, "source_video.mp4");

    // Create 15s test video (GOP 30, 30fps)
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=15:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=15",
      "-c:v", "libx264", "-g", "30", "-keyint_min", "30",
      "-c:a", "aac",
      "-movflags", "+faststart",
      testMp4Path,
    ]);

    fileBuffer = await fs.readFile(testMp4Path);

    server = http.createServer((req, res) => {
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
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("fetches partial bytes and extracts verified clip of 4.0s - 7.5s", async () => {
    const videoUrl = `${serverUrl}/source.mp4`;
    const probeResult = await probeMP4Index(videoUrl);
    const index = probeResult.index;
    const targetRange = { startSeconds: 4.0, endSeconds: 7.5 };
    const plan = createByteRangeFetchPlan(index, targetRange, videoUrl);

    const outputClipPath = path.join(tempDir, "extracted_clip.mp4");

    const result = await extractClipFromPlan({
      plan,
      index,
      outputClipPath,
      workDir: tempDir,
      cachedHeadBuffer: probeResult.cachedHeadBuffer,
    });

    expect(result.outputClipPath).toBe(outputClipPath);
    expect(result.bytesFetched).toBeLessThan(fileBuffer.length * 0.5);

    // Verify extracted clip with ffprobe
    const probe = await verifyMediaFile(outputClipPath);
    expect(probe.isValid).toBe(true);
    expect(probe.duration).toBeGreaterThanOrEqual(3.3);
    expect(probe.duration).toBeLessThanOrEqual(4.0);
    expect(probe.videoStream.codec).toBe("h264");
    expect(probe.audioStream?.codec).toBe("aac");
  });
});
