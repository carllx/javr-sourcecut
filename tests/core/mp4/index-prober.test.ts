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
  let faststartBuffer: Buffer;
  let tailBuffer: Buffer;
  let server: http.Server;
  let serverUrl: string;
  let networkRequestLog: { url: string; rangeHeader?: string }[] = [];

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

    faststartBuffer = await fs.readFile(faststartMp4Path);
    tailBuffer = await fs.readFile(tailMp4Path);


    server = http.createServer((req, res) => {
      const url = req.url || "";
      const rangeHeader = req.headers.range;
      networkRequestLog.push({ url, rangeHeader });
      const targetBuffer = url.includes("tail") ? tailBuffer : faststartBuffer;
      const totalSize = targetBuffer.length;

      if (url.includes("ignore-range-200")) {
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": totalSize.toString(),
        });
        res.end(targetBuffer);
        return;
      }

      if (url.includes("missing-content-range")) {
        res.writeHead(206, {
          "Content-Type": "video/mp4",
          "Content-Length": "100",
        });
        res.end(targetBuffer.subarray(0, 100));
        return;
      }

      if (url.includes("wrong-start")) {
        const chunk = targetBuffer.subarray(50, 500);
        res.writeHead(206, {
          "Content-Type": "video/mp4",
          "Content-Range": `bytes 50-499/${totalSize}`,
          "Content-Length": chunk.length.toString(),
        });
        res.end(chunk);
        return;
      }

      if (url.includes("wrong-end")) {
        const chunk = targetBuffer.subarray(0, 200);
        res.writeHead(206, {
          "Content-Type": "video/mp4",
          "Content-Range": `bytes 0-199/${totalSize}`,
          "Content-Length": chunk.length.toString(),
        });
        res.end(chunk);
        return;
      }

      if (url.includes("malformed-content-range")) {
        res.writeHead(206, {
          "Content-Type": "video/mp4",
          "Content-Range": `invalid-content-range`,
          "Content-Length": "100",
        });
        res.end(targetBuffer.subarray(0, 100));
        return;
      }

      if (url.includes("wildcard-total")) {
        res.writeHead(206, {
          "Content-Type": "video/mp4",
          "Content-Range": `bytes 0-0/*`,
          "Content-Length": "1",
        });
        res.end(targetBuffer.subarray(0, 1));
        return;
      }

      if (url.includes("truncated-body")) {
        res.writeHead(206, {
          "Content-Type": "video/mp4",
          "Content-Range": `bytes 0-0/${totalSize}`,
        });
        res.write(Buffer.alloc(0));
        res.end();
        return;
      }

      if (url.includes("conflicting-head-total")) {
        if (rangeHeader === "bytes=0-0") {
          res.writeHead(206, {
            "Content-Type": "video/mp4",
            "Content-Range": `bytes 0-0/${totalSize}`,
            "Content-Length": "1",
          });
          res.end(targetBuffer.subarray(0, 1));
          return;
        }
        // Head probe (bytes=0-headEnd) returns a changed total file size
        res.writeHead(206, {
          "Content-Type": "video/mp4",
          "Content-Range": `bytes 0-100/${totalSize + 5000}`,
          "Content-Length": "101",
        });
        res.end(targetBuffer.subarray(0, 101));
        return;
      }

      if (url.includes("cap-vs-head-etag-mismatch")) {
        const etag = rangeHeader === "bytes=0-0" ? '"cap-strong-v1"' : '"head-strong-v2"';
        const match = rangeHeader ? rangeHeader.match(/bytes=(\d+)-(\d*)/) : null;
        const start = match ? parseInt(match[1], 10) : 0;
        const requestedEnd = match && match[2] ? parseInt(match[2], 10) : totalSize - 1;
        const end = Math.min(requestedEnd, totalSize - 1);
        const chunk = targetBuffer.subarray(start, end + 1);
        res.writeHead(206, {
          "Content-Type": "video/mp4",
          "Content-Range": `bytes ${start}-${end}/${totalSize}`,
          "Content-Length": chunk.length.toString(),
          "ETag": etag,
        });
        res.end(chunk);
        return;
      }

      if (url.includes("head-vs-tail-etag-mismatch")) {
        const isTail = rangeHeader && !rangeHeader.startsWith("bytes=0-");
        const etag = isTail ? '"tail-strong-v2"' : '"head-strong-v1"';
        const match = rangeHeader ? rangeHeader.match(/bytes=(\d+)-(\d*)/) : null;
        const start = match ? parseInt(match[1], 10) : 0;
        const requestedEnd = match && match[2] ? parseInt(match[2], 10) : totalSize - 1;
        const end = Math.min(requestedEnd, totalSize - 1);
        const chunk = targetBuffer.subarray(start, end + 1);
        res.writeHead(206, {
          "Content-Type": "video/mp4",
          "Content-Range": `bytes ${start}-${end}/${totalSize}`,
          "Content-Length": chunk.length.toString(),
          "ETag": etag,
        });
        res.end(chunk);
        return;
      }

      if (url.includes("aborted-head-stream")) {

        if (rangeHeader === "bytes=0-0") {
          res.writeHead(206, {
            "Content-Type": "video/mp4",
            "Content-Range": `bytes 0-0/${totalSize}`,
            "Content-Length": "1",
            "ETag": '"cap-strong-etag"',
          });
          res.end(targetBuffer.subarray(0, 1));
          return;
        }

        // Head probe: send partial 500 bytes of 1024, then abruptly destroy socket
        res.writeHead(206, {
          "Content-Type": "video/mp4",
          "Content-Range": `bytes 0-1023/${totalSize}`,
          "Content-Length": "1024",
          "ETag": '"cap-strong-etag"',
        });
        res.write(targetBuffer.subarray(0, 500));
        setTimeout(() => {
          req.socket.destroy();
        }, 20);
        return;
      }





      if (!rangeHeader) {
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": totalSize.toString(),
        });
        res.end(targetBuffer);
        return;
      }

      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (!match) {
        res.writeHead(416, { "Content-Range": `bytes */${totalSize}` });
        res.end();
        return;
      }

      const start = parseInt(match[1], 10);
      const requestedEnd = match[2] ? parseInt(match[2], 10) : totalSize - 1;
      const end = Math.min(requestedEnd, totalSize - 1);
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
  }, 30000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("probes index from faststart MP4 via 2-stage discovery and counts probe bytes", async () => {
    const result = await probeMP4Index(`${serverUrl}/faststart.mp4`, {
      headProbeBytes: 64 * 1024,
    });

    expect(result.index.hasMoovAtStart).toBe(true);
    expect(result.index.duration).toBeGreaterThanOrEqual(3.9);
    expect(result.capabilityProbeBytesTransferred).toBe(1);
    expect(result.headProbeBytesTransferred).toBeGreaterThan(0);
    expect(result.tailProbeBytesTransferred).toBe(0);
    expect(result.totalProbeBytesTransferred).toBe(1 + result.headProbeBytesTransferred);
    expect(result.cachedHead).toBeDefined();
    expect(result.cachedHead?.range.startByte).toBe(0);
  });

  it("probes index from tail MP4 and counts both head and tail transferred bytes when probe budgets are explicitly bounded", async () => {
    networkRequestLog = [];
    const result = await probeMP4Index(`${serverUrl}/tail.mp4`, {
      headProbeBytes: 1024, // head probe won't find moov
      tailProbeBytes: 64 * 1024,
    });

    expect(result.index.hasMoovAtStart).toBe(false);
    expect(result.index.duration).toBeGreaterThanOrEqual(3.9);
    expect(result.capabilityProbeBytesTransferred).toBe(1);
    expect(result.headProbeBytesTransferred).toBe(1024);
    expect(result.tailProbeBytesTransferred).toBeGreaterThan(0);
    expect(result.totalProbeBytesTransferred).toBe(
      1 + result.headProbeBytesTransferred + result.tailProbeBytesTransferred
    );
    expect(result.cachedTail).toBeDefined();
    expect(result.cachedTail?.range.endByte).toBe(result.index.fileSize - 1);
  });

  it("fails closed before issuing tail request when default probe budgets would cover full file on small tail MP4", async () => {
    networkRequestLog = [];
    await expect(
      probeMP4Index(`${serverUrl}/tail.mp4`) // uses default 512KB head + 2MB tail
    ).rejects.toThrow(UnprovablePartialPlanError);

    // Verify: Stage A capability (0-0) happened, Stage B head (0-headEnd) happened
    expect(networkRequestLog.length).toBe(2);
    expect(networkRequestLog[0].rangeHeader).toBe("bytes=0-0");
    expect(networkRequestLog[1].rangeHeader).toMatch(/^bytes=0-/);

    // Verify: Tail probe request was NEVER issued
    const tailRequests = networkRequestLog.filter((r) =>
      r.rangeHeader && !r.rangeHeader.startsWith("bytes=0-")
    );
    expect(tailRequests.length).toBe(0);
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

  it("fails closed with Http206RequiredError when Content-Range total is wildcard (*)", async () => {
    await expect(
      probeMP4Index(`${serverUrl}/wildcard-total.mp4`)
    ).rejects.toThrow(Http206RequiredError);
  });

  it("fails closed with RenditionVersionMismatchError when head probe returns conflicting total file size", async () => {
    const { RenditionVersionMismatchError } = await import("../../../src/core/mp4/types.js");
    await expect(
      probeMP4Index(`${serverUrl}/conflicting-head-total.mp4`)
    ).rejects.toThrow(RenditionVersionMismatchError);
  });

  it("fails closed with RenditionVersionMismatchError when capability vs head strong ETags mismatch", async () => {
    const { RenditionVersionMismatchError } = await import("../../../src/core/mp4/types.js");
    await expect(
      probeMP4Index(`${serverUrl}/cap-vs-head-etag-mismatch.mp4`)
    ).rejects.toThrow(RenditionVersionMismatchError);
  });

  it("fails closed with RenditionVersionMismatchError when head vs tail strong ETags mismatch", async () => {
    const { RenditionVersionMismatchError } = await import("../../../src/core/mp4/types.js");
    await expect(
      probeMP4Index(`${serverUrl}/head-vs-tail-etag-mismatch.mp4`, {
        headProbeBytes: 1024,
        tailProbeBytes: 64 * 1024,
      })
    ).rejects.toThrow(RenditionVersionMismatchError);
  });

  it("fails prospectively with BudgetExceededError before issuing probe requests when budget is exhausted", async () => {
    const { TransferBudgetTracker } = await import("../../../src/core/mp4/budget.js");
    const { BudgetExceededError } = await import("../../../src/core/mp4/types.js");

    const budgetTracker = new TransferBudgetTracker({
      estimatedBytes: 1000,
      budgetMultiplier: 1.5, // max: 1500
      historicalTransferredBytes: 1500, // already fully exhausted!
    });

    await expect(
      probeMP4Index(`${serverUrl}/faststart.mp4`, {
        budgetTracker,
      })
    ).rejects.toThrow(BudgetExceededError);
  });

  it("stream-records actual received bytes on partial/truncated probe failure, persisting them to ledger so restart accounts for them", async () => {
    const { TransferLedgerManager } = await import("../../../src/core/mp4/ledger.js");
    const { TransferBudgetTracker } = await import("../../../src/core/mp4/budget.js");
    const { BudgetExceededError } = await import("../../../src/core/mp4/types.js");

    const testWorkDir = path.join(tempDir, "truncated_probe_spend_test");
    await fs.mkdir(testWorkDir, { recursive: true });

    const rendition = {
      provider: "eporner",
      providerAssetId: "test-truncated-probe",
      formatId: "1080p",
      fullFileBytes: faststartBuffer.length,
      etag: '"cap-strong-etag"',
    };

    const ledgerManager = new TransferLedgerManager({
      workspaceDir: testWorkDir,
      rendition,
    });
    await ledgerManager.loadOrCreateLedger();

    const budgetTracker = new TransferBudgetTracker({
      estimatedBytes: 2000,
      budgetMultiplier: 1.0, // max budget: 2000
    });

    // Run 1: Attempt probe on endpoint that terminates head probe halfway through (after 500 bytes)
    await expect(
      probeMP4Index(`${serverUrl}/aborted-head-stream.mp4`, {
        headProbeBytes: 1024,
        budgetTracker,
        ledgerManager,
      })
    ).rejects.toThrow();

    // Verify: 1 byte from capability probe + 500 bytes from truncated head probe were permanently recorded
    expect(ledgerManager.cumulativeHistoricalSpentBytes).toBe(501);
    expect(budgetTracker.currentRunBytes).toBe(501);

    // Run 2: Restart simulation with new manager instance from disk
    const resumeManager = new TransferLedgerManager({
      workspaceDir: testWorkDir,
      rendition,
    });
    await resumeManager.loadOrCreateLedger();

    expect(resumeManager.cumulativeHistoricalSpentBytes).toBe(501);

    const resumeBudgetTracker = new TransferBudgetTracker({
      estimatedBytes: 2000,
      budgetMultiplier: 1.0,
      historicalTransferredBytes: resumeManager.cumulativeHistoricalSpentBytes,
    });

    // Remaining budget is now exactly 2000 - 501 = 1499 bytes (headroom reduced by failed attempt)
    expect(resumeBudgetTracker.remainingBudget).toBe(1499);

    // If budget envelope was set to 501, prospective check rejects further attempts immediately
    const exhaustedBudgetTracker = new TransferBudgetTracker({
      estimatedBytes: 501,
      budgetMultiplier: 1.0,
      historicalTransferredBytes: resumeManager.cumulativeHistoricalSpentBytes,
    });

    await expect(
      probeMP4Index(`${serverUrl}/faststart.mp4`, {
        budgetTracker: exhaustedBudgetTracker,
      })
    ).rejects.toThrow(BudgetExceededError);
  });

  it("verifies a successful probe counts every probe byte exactly once without double-counting", async () => {
    const { TransferLedgerManager } = await import("../../../src/core/mp4/ledger.js");
    const { TransferBudgetTracker } = await import("../../../src/core/mp4/budget.js");

    const testWorkDir = path.join(tempDir, "exact_probe_count_test");
    await fs.mkdir(testWorkDir, { recursive: true });

    const rendition = {
      provider: "eporner",
      providerAssetId: "test-exact-count",
      formatId: "1080p",
      fullFileBytes: faststartBuffer.length,
      etag: '"faststart-strong-etag"',
    };

    const ledgerManager = new TransferLedgerManager({
      workspaceDir: testWorkDir,
      rendition,
    });
    await ledgerManager.loadOrCreateLedger();

    const budgetTracker = new TransferBudgetTracker({
      estimatedBytes: 100000,
      budgetMultiplier: 1.5,
    });

    const result = await probeMP4Index(`${serverUrl}/faststart.mp4`, {
      budgetTracker,
      ledgerManager,
    });


    expect(result.totalProbeBytesTransferred).toBeGreaterThan(0);
    // Crucial: The ledger and budget tracker recorded exactly the probe bytes transferred, no more, no less
    expect(ledgerManager.cumulativeHistoricalSpentBytes).toBe(result.totalProbeBytesTransferred);
    expect(budgetTracker.currentRunBytes).toBe(result.totalProbeBytesTransferred);
  });
});



