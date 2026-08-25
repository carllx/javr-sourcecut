import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { probeMP4Index } from "../../../src/core/mp4/index-prober.js";
import { Http206RequiredError, UnprovablePartialPlanError } from "../../../src/core/mp4/types.js";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

describe("Bounded MP4 Index Prober", () => {
  let tempDir: string;
  let faststartMp4Path: string;
  let tailMp4Path: string;
  let server: http.Server;
  let serverUrl: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-prober-test-"));
    faststartMp4Path = path.join(tempDir, "faststart.mp4");
    tailMp4Path = path.join(tempDir, "tail.mp4");

    // 1. Faststart MP4 (moov at start)
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=4",
      "-c:v", "libx264", "-g", "30", "-keyint_min", "30",
      "-c:a", "aac",
      "-movflags", "+faststart",
      faststartMp4Path,
    ]);

    // 2. Tail MP4 (moov at tail)
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=4",
      "-c:v", "libx264", "-g", "30", "-keyint_min", "30",
      "-c:a", "aac",
      tailMp4Path,
    ]);

    const faststartBuffer = await fs.readFile(faststartMp4Path);
    const tailBuffer = await fs.readFile(tailMp4Path);

    server = http.createServer((req, res) => {
      const url = req.url || "";
      const targetBuffer = url.includes("tail") ? tailBuffer : faststartBuffer;
      const totalSize = targetBuffer.length;

      if (url.includes("ignore-range-200")) {
        // Server ignores Range and sends 200 OK
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": totalSize.toString(),
        });
        res.end(targetBuffer);
        return;
      }

      if (url.includes("missing-content-range")) {
        // Server sends 206 but omits Content-Range
        res.writeHead(206, {
          "Content-Type": "video/mp4",
          "Content-Length": "100",
        });
        res.end(targetBuffer.subarray(0, 100));
        return;
      }

      const rangeHeader = req.headers.range;
      if (!rangeHeader) {
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": totalSize.toString(),
        });
        res.end(targetBuffer);
        return;
      }

      // Parse range: bytes=start-end
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (!match) {
        res.writeHead(416, { "Content-Range": `bytes */${totalSize}` });
        res.end();
        return;
      }

      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
      const chunk = targetBuffer.subarray(start, end + 1);

      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes ${start}-${end}/${totalSize}`,
        "Content-Length": chunk.length.toString(),
      });
      res.end(chunk);
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

  it("probes index from faststart MP4 via single bounded head probe", async () => {
    const index = await probeMP4Index(`${serverUrl}/faststart.mp4`, {
      headProbeBytes: 64 * 1024,
    });

    expect(index.hasMoovAtStart).toBe(true);
    expect(index.duration).toBeGreaterThanOrEqual(3.9);
    expect(index.tracks.length).toBe(2);
    expect(index.tracks.find((t) => t.type === "video")).toBeDefined();
  });

  it("probes index from tail MP4 via bounded tail probe", async () => {
    const index = await probeMP4Index(`${serverUrl}/tail.mp4`, {
      headProbeBytes: 1024, // head probe won't find moov
      tailProbeBytes: 64 * 1024,
    });

    expect(index.hasMoovAtStart).toBe(false);
    expect(index.duration).toBeGreaterThanOrEqual(3.9);
    expect(index.tracks.length).toBe(2);
  });

  it("fails closed with Http206RequiredError when server returns 200 OK", async () => {
    await expect(
      probeMP4Index(`${serverUrl}/ignore-range-200.mp4`)
    ).rejects.toThrow(Http206RequiredError);
  });

  it("fails closed with Http206RequiredError when Content-Range header is missing", async () => {
    await expect(
      probeMP4Index(`${serverUrl}/missing-content-range.mp4`)
    ).rejects.toThrow(Http206RequiredError);
  });
});
