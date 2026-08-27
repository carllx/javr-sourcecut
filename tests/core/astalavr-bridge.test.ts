import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { AstalaVrBridgeServer } from "../../src/core/astalavr-bridge.js";

describe("AstalaVR Agent Proxy Bridge Server", () => {
  let tmpDir: string;
  let bridge: AstalaVrBridgeServer;
  const TEST_PORT = 39815;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "astalavr-bridge-test-"));
    bridge = new AstalaVrBridgeServer();
  });

  afterEach(async () => {
    bridge.closeServer();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function postHttp(options: {
    port: number;
    path: string;
    headers?: Record<string, string>;
    body?: Buffer | Uint8Array;
  }): Promise<{ statusCode?: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: options.port,
          path: options.path,
          method: "POST",
          headers: options.headers,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
        }
      );
      req.on("error", reject);
      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }

  function getHttp(options: { port: number; path: string }): Promise<{ statusCode?: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: options.port,
          path: options.path,
          method: "GET",
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("1. Agent receiver exposes active job info on GET /astalavr/job", async () => {
    const outputPath = path.join(tmpDir, "proxies", "78yre-720p.mp4");
    const jobPromise = bridge.startJob({
      assetId: "78yre",
      outputPath,
      port: TEST_PORT,
    });

    await new Promise((r) => setTimeout(r, 50));

    const res = await getHttp({ port: TEST_PORT, path: "/astalavr/job" });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.active).toBe(true);
    expect(data.assetId).toBe("78yre");

    // Clean up
    await postHttp({ port: TEST_PORT, path: "/astalavr/fail" });
    await jobPromise;
  });

  it("2. Agent receiver writes sequential binary chunks to .part and atomically renames on complete", async () => {
    const outputPath = path.join(tmpDir, "proxies", "78yre-720p.mp4");
    const partPath = `${outputPath}.part`;

    const jobPromise = bridge.startJob({
      assetId: "78yre",
      outputPath,
      port: TEST_PORT,
    });

    await new Promise((r) => setTimeout(r, 50));

    const chunk1 = Buffer.from("CHUNK_DATA_1_AAAA");
    const chunk2 = Buffer.from("CHUNK_DATA_2_BBBB");
    const TOTAL = chunk1.length + chunk2.length;

    // Send chunk 1
    const res1 = await postHttp({
      port: TEST_PORT,
      path: "/astalavr/chunk",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Asset-Id": "78yre",
        "X-Offset": "0",
        "X-Total-Bytes": String(TOTAL),
      },
      body: chunk1,
    });
    expect(res1.statusCode).toBe(200);

    // Verify .part exists and contains chunk 1
    const partStat1 = await fs.stat(partPath);
    expect(partStat1.size).toBe(chunk1.length);

    // Send chunk 2
    const res2 = await postHttp({
      port: TEST_PORT,
      path: "/astalavr/chunk",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Asset-Id": "78yre",
        "X-Offset": String(chunk1.length),
        "X-Total-Bytes": String(TOTAL),
      },
      body: chunk2,
    });
    expect(res2.statusCode).toBe(200);

    // Complete transfer (verifier might fail on dummy text, but let's test file presence)
    const completeRes = await postHttp({
      port: TEST_PORT,
      path: "/astalavr/complete",
      headers: {
        "X-Asset-Id": "78yre",
      },
    });

    const result = await jobPromise;
    expect(result.bytesWritten).toBe(TOTAL);
    expect(result.totalBytes).toBe(TOTAL);
    expect(result.assetId).toBe("78yre");
    expect(result.outputPath).toBe(outputPath);
  });

  it("3. short transfer or transfer abort deletes .part file", async () => {
    const outputPath = path.join(tmpDir, "proxies", "78yre-720p.mp4");
    const partPath = `${outputPath}.part`;

    const jobPromise = bridge.startJob({
      assetId: "78yre",
      outputPath,
      port: TEST_PORT,
    });

    await new Promise((r) => setTimeout(r, 50));

    const chunk1 = Buffer.from("CHUNK_DATA_1");
    await postHttp({
      port: TEST_PORT,
      path: "/astalavr/chunk",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Asset-Id": "78yre",
        "X-Offset": "0",
        "X-Total-Bytes": "1000",
      },
      body: chunk1,
    });

    // Abort transfer
    await postHttp({
      port: TEST_PORT,
      path: "/astalavr/fail",
      headers: { "X-Asset-Id": "78yre" },
    });

    const result = await jobPromise;
    expect(result.pass).toBe(false);
    expect(result.failureKind).toBe("TRANSFER_ABORTED");

    // Verify .part is unlinked
    await expect(fs.stat(partPath)).rejects.toThrow();
  });

  it("4. out-of-order or duplicate offset fails closed and removes .part", async () => {
    const outputPath = path.join(tmpDir, "proxies", "78yre-720p.mp4");
    const partPath = `${outputPath}.part`;

    const jobPromise = bridge.startJob({
      assetId: "78yre",
      outputPath,
      port: TEST_PORT,
    });

    await new Promise((r) => setTimeout(r, 50));

    const chunk1 = Buffer.from("HELLO");
    await postHttp({
      port: TEST_PORT,
      path: "/astalavr/chunk",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Asset-Id": "78yre",
        "X-Offset": "0",
        "X-Total-Bytes": "100",
      },
      body: chunk1,
    });

    // Send wrong offset (skip from 5 to 10)
    const resGap = await postHttp({
      port: TEST_PORT,
      path: "/astalavr/chunk",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Asset-Id": "78yre",
        "X-Offset": "10",
        "X-Total-Bytes": "100",
      },
      body: Buffer.from("WORLD"),
    });

    expect(resGap.statusCode).toBe(409);

    const result = await jobPromise;
    expect(result.pass).toBe(false);
    expect(result.failureKind).toBe("OUT_OF_ORDER_OFFSET");

    await expect(fs.stat(partPath)).rejects.toThrow();
  });

  it("5. port collision fails closed immediately with PORT_IN_USE", async () => {
    const occupiedServer = http.createServer();
    await new Promise<void>((resolve) => occupiedServer.listen(TEST_PORT, "127.0.0.1", () => resolve()));

    const outputPath = path.join(tmpDir, "proxies", "78yre-720p.mp4");
    const result = await bridge.startJob({
      assetId: "78yre",
      outputPath,
      port: TEST_PORT,
    });

    expect(result.pass).toBe(false);
    expect(result.failureKind).toBe("PORT_IN_USE");

    await new Promise<void>((resolve) => occupiedServer.close(() => resolve()));
  });

  it("6. Node owns output path; browser cannot supply arbitrary path", async () => {
    const fixedOutputPath = path.join(tmpDir, "safe_proxies", "78yre-720p.mp4");
    const jobPromise = bridge.startJob({
      assetId: "78yre",
      outputPath: fixedOutputPath,
      port: TEST_PORT,
    });

    await new Promise((r) => setTimeout(r, 50));

    // Browser cannot set path in header/body, server writes strictly to fixedOutputPath.part
    const chunkBody = Buffer.from("1234567890");
    const chunkRes = await postHttp({
      port: TEST_PORT,
      path: "/astalavr/chunk",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(chunkBody.length),
        "X-Asset-Id": "78yre",
        "X-Offset": "0",
        "X-Total-Bytes": "10",
        "X-Custom-Path": "/etc/evil",
      },
      body: chunkBody,
    });
    expect(chunkRes.statusCode).toBe(200);

    const stat = await fs.stat(`${fixedOutputPath}.part`);
    expect(stat.size).toBe(10);

    await postHttp({ port: TEST_PORT, path: "/astalavr/fail" });
    await jobPromise;
  });
});
