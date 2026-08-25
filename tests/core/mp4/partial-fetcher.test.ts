import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fetchByteRange } from "../../../src/core/mp4/partial-fetcher.js";
import { Http206RequiredError } from "../../../src/core/mp4/types.js";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("Strict HTTP 206 Partial Fetcher", () => {
  let server: http.Server;
  let serverUrl: string;
  let tempDir: string;
  const mockPayload = Buffer.from("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-fetcher-test-"));

    server = http.createServer((req, res) => {
      const url = req.url || "";

      if (url.includes("server-sends-200")) {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": mockPayload.length.toString(),
        });
        res.end(mockPayload);
        return;
      }

      if (url.includes("missing-content-range")) {
        res.writeHead(206, {
          "Content-Type": "application/octet-stream",
          "Content-Length": "10",
        });
        res.end(mockPayload.subarray(0, 10));
        return;
      }

      if (url.includes("wrong-start")) {
        const chunk = mockPayload.subarray(0, 10);
        res.writeHead(206, {
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes 0-9/${mockPayload.length}`,
          "Content-Length": "10",
        });
        res.end(chunk);
        return;
      }

      if (url.includes("wrong-end")) {
        const chunk = mockPayload.subarray(10, 15);
        res.writeHead(206, {
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes 10-14/${mockPayload.length}`,
          "Content-Length": "5",
        });
        res.end(chunk);
        return;
      }

      if (url.includes("wildcard-total")) {
        const chunk = mockPayload.subarray(10, 21);
        res.writeHead(206, {
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes 10-20/*`,
          "Content-Length": chunk.length.toString(),
        });
        res.end(chunk);
        return;
      }

      if (url.includes("truncated-body")) {
        // Content-Range says 10-20 (11 bytes), but only sends 4 bytes without Content-Length
        res.writeHead(206, {
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes 10-20/${mockPayload.length}`,
        });
        res.write(mockPayload.subarray(10, 14));
        res.end();
        return;
      }

      if (url.includes("oversized-body")) {
        // Content-Range says 10-20 (11 bytes), but sends 20 bytes
        res.writeHead(206, {
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes 10-20/${mockPayload.length}`,
          "Content-Length": "20",
        });
        res.end(mockPayload.subarray(10, 30));
        return;
      }

      const rangeHeader = req.headers.range;
      if (!rangeHeader) {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": mockPayload.length.toString(),
        });
        res.end(mockPayload);
        return;
      }

      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const requestedEnd = match[2] ? parseInt(match[2], 10) : mockPayload.length - 1;
        const end = Math.min(requestedEnd, mockPayload.length - 1);
        const chunk = mockPayload.subarray(start, end + 1);

        res.writeHead(206, {
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes ${start}-${end}/${mockPayload.length}`,
          "Content-Length": chunk.length.toString(),
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

  it("fetches byte range successfully when server returns 206 with valid Content-Range", async () => {
    const dest = path.join(tempDir, "range_10_20.bin");
    const result = await fetchByteRange(
      `${serverUrl}/valid-video.mp4`,
      { startByte: 10, endByte: 20 },
      dest
    );

    expect(result.bytesDownloaded).toBe(11);
    expect(result.startByte).toBe(10);
    expect(result.endByte).toBe(20);
    expect(result.totalFileSize).toBe(mockPayload.length);

    const saved = await fs.readFile(dest);
    expect(saved.toString()).toBe("ABCDEFGHIJK");
  });

  it("fails closed with Http206RequiredError when server returns 200 OK", async () => {
    const dest = path.join(tempDir, "failed_200.bin");
    await expect(
      fetchByteRange(`${serverUrl}/server-sends-200.mp4`, { startByte: 5, endByte: 10 }, dest)
    ).rejects.toThrow(Http206RequiredError);

    // Ensure no residual destination or part file remained
    expect(await fs.access(dest).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.access(`${dest}.part`).then(() => true).catch(() => false)).toBe(false);
  });

  it("fails closed with Http206RequiredError when Content-Range is missing", async () => {
    const dest = path.join(tempDir, "failed_missing_cr.bin");
    await expect(
      fetchByteRange(`${serverUrl}/missing-content-range.mp4`, { startByte: 0, endByte: 9 }, dest)
    ).rejects.toThrow(Http206RequiredError);

    expect(await fs.access(dest).then(() => true).catch(() => false)).toBe(false);
  });

  it("fails closed with Http206RequiredError when server returns wrong start byte", async () => {
    const dest = path.join(tempDir, "failed_wrong_start.bin");
    await expect(
      fetchByteRange(`${serverUrl}/wrong-start.mp4`, { startByte: 10, endByte: 20 }, dest)
    ).rejects.toThrow(Http206RequiredError);

    expect(await fs.access(dest).then(() => true).catch(() => false)).toBe(false);
  });

  it("fails closed with Http206RequiredError when server returns wrong end byte", async () => {
    const dest = path.join(tempDir, "failed_wrong_end.bin");
    await expect(
      fetchByteRange(`${serverUrl}/wrong-end.mp4`, { startByte: 10, endByte: 20 }, dest)
    ).rejects.toThrow(Http206RequiredError);

    expect(await fs.access(dest).then(() => true).catch(() => false)).toBe(false);
  });

  it("fails closed with Http206RequiredError when Content-Range total is wildcard (*)", async () => {
    const dest = path.join(tempDir, "failed_wildcard.bin");
    await expect(
      fetchByteRange(`${serverUrl}/wildcard-total.mp4`, { startByte: 10, endByte: 20 }, dest)
    ).rejects.toThrow(Http206RequiredError);

    expect(await fs.access(dest).then(() => true).catch(() => false)).toBe(false);
  });

  it("fails closed and cleans up .part when response body is truncated", async () => {
    const dest = path.join(tempDir, "failed_truncated.bin");
    await expect(
      fetchByteRange(`${serverUrl}/truncated-body.mp4`, { startByte: 10, endByte: 20 }, dest)
    ).rejects.toThrow(Http206RequiredError);

    expect(await fs.access(dest).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.access(`${dest}.part`).then(() => true).catch(() => false)).toBe(false);
  });

  it("fails closed and cleans up .part when response body is oversized", async () => {
    const dest = path.join(tempDir, "failed_oversized.bin");
    await expect(
      fetchByteRange(`${serverUrl}/oversized-body.mp4`, { startByte: 10, endByte: 20 }, dest)
    ).rejects.toThrow(Http206RequiredError);

    expect(await fs.access(dest).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.access(`${dest}.part`).then(() => true).catch(() => false)).toBe(false);
  });
});
