import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { downloadFile } from "../../src/core/downloader.js";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("Downloader", () => {
  let server: http.Server;
  let serverUrl: string;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-downloader-test-"));
    server = http.createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: `${serverUrl}/data` });
        res.end();
        return;
      }
      if (req.url === "/data") {
        const payload = Buffer.from("FAKE_VIDEO_STREAM_DATA_1234567890");
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": payload.length.toString(),
        });
        res.end(payload);
        return;
      }
      if (req.url === "/error") {
        res.writeHead(500);
        res.end("Internal Server Error");
        return;
      }
      res.writeHead(404);
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

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("downloads file and follows redirects successfully", async () => {
    const targetFile = path.join(tempDir, "sample.mp4");
    let progressCalls = 0;

    const result = await downloadFile(`${serverUrl}/redirect`, targetFile, {
      onProgress: (transferred, total) => {
        progressCalls++;
        expect(transferred).toBeGreaterThan(0);
      },
    });

    expect(result.bytesDownloaded).toBe(Buffer.from("FAKE_VIDEO_STREAM_DATA_1234567890").length);
    expect(progressCalls).toBeGreaterThan(0);

    const fileContent = await fs.readFile(targetFile, "utf-8");
    expect(fileContent).toBe("FAKE_VIDEO_STREAM_DATA_1234567890");
  });

  it("cleans up partial file on HTTP error", async () => {
    const targetFile = path.join(tempDir, "failed.mp4");
    await expect(downloadFile(`${serverUrl}/error`, targetFile)).rejects.toThrow("500");

    const exists = await fs.access(targetFile).then(() => true).catch(() => false);
    const partExists = await fs.access(`${targetFile}.part`).then(() => true).catch(() => false);
    expect(exists).toBe(false);
    expect(partExists).toBe(false);
  });
});
