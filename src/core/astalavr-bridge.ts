import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { verifyMediaFile, type FfprobeProbeResult } from "./verifier.js";

export const ASTALAVR_BRIDGE_PORT = 38815;

export interface AstalaVrBridgeJobOptions {
  assetId: string;
  outputPath: string;
  port?: number;
  onProgress?: (bytesWritten: number, totalBytes?: number) => void;
  onLog?: (message: string) => void;
}

export interface AstalaVrBridgeJobResult {
  pass: boolean;
  assetId: string;
  rendition: string;
  outputPath: string;
  bytesWritten: number;
  totalBytes: number;
  ffprobePass: boolean;
  probeResult?: FfprobeProbeResult;
  failureKind?:
    | "PORT_IN_USE"
    | "OUT_OF_ORDER_OFFSET"
    | "TRANSFER_ABORTED"
    | "BODY_LENGTH_MISMATCH"
    | "FFPROBE_FAILED"
    | "SERVER_ERROR";
}

export class AstalaVrBridgeServer {
  private server: http.Server | null = null;
  private currentJob: {
    assetId: string;
    outputPath: string;
    partPath: string;
    fileHandle: fsp.FileHandle | null;
    bytesWritten: number;
    totalBytes: number | null;
    failed: boolean;
    failureKind?: AstalaVrBridgeJobResult["failureKind"];
    onProgress?: (bytesWritten: number, totalBytes?: number) => void;
    onLog?: (message: string) => void;
    resolve: (result: AstalaVrBridgeJobResult) => void;
    reject: (err: any) => void;
  } | null = null;

  async startJob(options: AstalaVrBridgeJobOptions): Promise<AstalaVrBridgeJobResult> {
    const port = options.port || ASTALAVR_BRIDGE_PORT;
    const resolvedOutput = path.resolve(options.outputPath);
    const partPath = `${resolvedOutput}.part`;

    await fsp.mkdir(path.dirname(resolvedOutput), { recursive: true });

    // Clean up any stale .part file
    try {
      await fsp.unlink(partPath);
    } catch {}

    const fileHandle = await fsp.open(partPath, "w");

    return new Promise<AstalaVrBridgeJobResult>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server = server;

      this.currentJob = {
        assetId: options.assetId,
        outputPath: resolvedOutput,
        partPath,
        fileHandle,
        bytesWritten: 0,
        totalBytes: null,
        failed: false,
        onProgress: options.onProgress,
        onLog: options.onLog,
        resolve: (result) => {
          this.closeServer();
          resolve(result);
        },
        reject: (err) => {
          this.closeServer();
          reject(err);
        },
      };

      server.on("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
          this.cleanupFailedJob("PORT_IN_USE");
          resolve({
            pass: false,
            assetId: options.assetId,
            rendition: "720p",
            outputPath: resolvedOutput,
            bytesWritten: 0,
            totalBytes: 0,
            ffprobePass: false,
            failureKind: "PORT_IN_USE",
          });
        } else {
          this.cleanupFailedJob("SERVER_ERROR");
          reject(err);
        }
      });

      server.listen(port, "127.0.0.1", () => {
        if (options.onLog) {
          options.onLog(`AstalaVR Agent Bridge listening on 127.0.0.1:${port}`);
        }
      });
    });
  }

  public closeServer(): void {
    if (this.server) {
      try {
        this.server.close();
      } catch {}
      this.server = null;
    }
  }

  private async cleanupFailedJob(failureKind: AstalaVrBridgeJobResult["failureKind"]) {
    if (!this.currentJob) return;
    this.currentJob.failed = true;
    this.currentJob.failureKind = failureKind;

    if (this.currentJob.fileHandle) {
      try {
        await this.currentJob.fileHandle.close();
      } catch {}
      this.currentJob.fileHandle = null;
    }

    try {
      await fsp.unlink(this.currentJob.partPath);
    } catch {}
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS headers for loopback / Tampermonkey compatibility
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Asset-Id, X-Offset, X-Total-Bytes");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "GET" && parsedUrl.pathname === "/astalavr/job") {
      if (!this.currentJob || this.currentJob.failed) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ active: false }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          active: true,
          assetId: this.currentJob.assetId,
          bytesWritten: this.currentJob.bytesWritten,
          totalBytes: this.currentJob.totalBytes,
        })
      );
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/astalavr/chunk") {
      if (!this.currentJob || this.currentJob.failed) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "NO_ACTIVE_JOB" }));
        return;
      }

      const reqAssetId = req.headers["x-asset-id"] as string;
      const offsetHeader = req.headers["x-offset"] as string;
      const totalHeader = req.headers["x-total-bytes"] as string;

      if (reqAssetId !== this.currentJob.assetId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "ASSET_ID_MISMATCH" }));
        return;
      }

      const offset = parseInt(offsetHeader, 10);
      const totalBytes = parseInt(totalHeader, 10);

      if (isNaN(offset) || isNaN(totalBytes) || totalBytes <= 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "INVALID_OFFSET_OR_TOTAL" }));
        return;
      }

      // Enforce monotonically increasing offset: next chunk MUST match bytesWritten exactly
      if (offset !== this.currentJob.bytesWritten) {
        this.cleanupFailedJob("OUT_OF_ORDER_OFFSET").then(() => {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "OUT_OF_ORDER_OFFSET" }));
          if (this.currentJob) {
            this.currentJob.resolve({
              pass: false,
              assetId: this.currentJob.assetId,
              rendition: "720p",
              outputPath: this.currentJob.outputPath,
              bytesWritten: this.currentJob.bytesWritten,
              totalBytes: this.currentJob.totalBytes || totalBytes,
              ffprobePass: false,
              failureKind: "OUT_OF_ORDER_OFFSET",
            });
          }
        });
        return;
      }

      this.currentJob.totalBytes = totalBytes;

      const chunks: Buffer[] = [];
      let receivedBytes = 0;

      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        receivedBytes += chunk.length;
      });

      req.on("end", async () => {
        if (!this.currentJob || this.currentJob.failed) return;

        const body = Buffer.concat(chunks);
        if (body.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "EMPTY_BODY" }));
          return;
        }

        // Check if write would exceed TOTAL
        if (this.currentJob.bytesWritten + body.length > totalBytes) {
          await this.cleanupFailedJob("BODY_LENGTH_MISMATCH");
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "EXCEEDS_TOTAL_BYTES" }));
          if (this.currentJob) {
            this.currentJob.resolve({
              pass: false,
              assetId: this.currentJob.assetId,
              rendition: "720p",
              outputPath: this.currentJob.outputPath,
              bytesWritten: this.currentJob.bytesWritten,
              totalBytes,
              ffprobePass: false,
              failureKind: "BODY_LENGTH_MISMATCH",
            });
          }
          return;
        }

        try {
          if (this.currentJob.fileHandle) {
            await this.currentJob.fileHandle.write(body);
            await this.currentJob.fileHandle.sync();
          }

          this.currentJob.bytesWritten += body.length;

          if (this.currentJob.onProgress) {
            this.currentJob.onProgress(this.currentJob.bytesWritten, totalBytes);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "OK",
              bytesWritten: this.currentJob.bytesWritten,
              totalBytes,
            })
          );
        } catch {
          await this.cleanupFailedJob("SERVER_ERROR");
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "WRITE_ERROR" }));
        }
      });
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/astalavr/complete") {
      if (!this.currentJob || this.currentJob.failed) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "NO_ACTIVE_JOB" }));
        return;
      }

      const reqAssetId = req.headers["x-asset-id"] as string;
      if (reqAssetId !== this.currentJob.assetId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "ASSET_ID_MISMATCH" }));
        return;
      }

      const job = this.currentJob;

      if (!job.totalBytes || job.bytesWritten !== job.totalBytes) {
        this.cleanupFailedJob("BODY_LENGTH_MISMATCH");
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "TOTAL_BYTES_MISMATCH" }));
        job.resolve({
          pass: false,
          assetId: job.assetId,
          rendition: "720p",
          outputPath: job.outputPath,
          bytesWritten: job.bytesWritten,
          totalBytes: job.totalBytes || job.bytesWritten,
          ffprobePass: false,
          failureKind: "BODY_LENGTH_MISMATCH",
        });
        return;
      }

      // Finalize fileHandle
      (async () => {
        try {
          if (job.fileHandle) {
            await job.fileHandle.close();
            job.fileHandle = null;
          }

          // Atomic rename .part -> final outputPath
          await fsp.rename(job.partPath, job.outputPath);

          // Verify with ffprobe
          let probeResult: FfprobeProbeResult | undefined;
          let ffprobePass = false;
          try {
            probeResult = await verifyMediaFile(job.outputPath, { requireAudio: false });
            ffprobePass = Boolean(probeResult && probeResult.isValid && probeResult.duration > 0);
          } catch {
            ffprobePass = false;
          }

          if (!ffprobePass) {
            try {
              await fsp.unlink(job.outputPath);
            } catch {}

            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "FFPROBE_FAILED" }));
            job.resolve({
              pass: false,
              assetId: job.assetId,
              rendition: "720p",
              outputPath: job.outputPath,
              bytesWritten: job.bytesWritten,
              totalBytes: job.totalBytes!,
              ffprobePass: false,
              failureKind: "FFPROBE_FAILED",
            });
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "COMPLETE", ffprobePass: true }));

          job.resolve({
            pass: true,
            assetId: job.assetId,
            rendition: "720p",
            outputPath: job.outputPath,
            bytesWritten: job.bytesWritten,
            totalBytes: job.totalBytes!,
            ffprobePass: true,
            probeResult,
          });
        } catch (err: any) {
          await this.cleanupFailedJob("SERVER_ERROR");
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message || "FINALIZE_ERROR" }));
          job.resolve({
            pass: false,
            assetId: job.assetId,
            rendition: "720p",
            outputPath: job.outputPath,
            bytesWritten: job.bytesWritten,
            totalBytes: job.totalBytes!,
            ffprobePass: false,
            failureKind: "SERVER_ERROR",
          });
        }
      })();
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/astalavr/fail") {
      if (!this.currentJob || this.currentJob.failed) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ALREADY_INACTIVE" }));
        return;
      }

      const job = this.currentJob;
      this.cleanupFailedJob("TRANSFER_ABORTED").then(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ABORTED" }));
        job.resolve({
          pass: false,
          assetId: job.assetId,
          rendition: "720p",
          outputPath: job.outputPath,
          bytesWritten: job.bytesWritten,
          totalBytes: job.totalBytes || job.bytesWritten,
          ffprobePass: false,
          failureKind: "TRANSFER_ABORTED",
        });
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "NOT_FOUND" }));
  }
}