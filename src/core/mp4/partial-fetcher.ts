import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ByteRange } from "./types.js";
import { Http206RequiredError } from "./types.js";

export interface PartialFetchOptions {
  fetchFn?: typeof fetch;
  headers?: Record<string, string>;
  onProgress?: (transferredBytes: number, totalExpectedBytes: number) => void;
  allowOverwrite?: boolean;
}

export interface PartialFetchResult {
  destinationPath: string;
  bytesDownloaded: number;
  startByte: number;
  endByte: number;
  totalFileSize: number;
  contentType?: string;
}

export async function fetchByteRange(
  url: string,
  range: ByteRange,
  destinationPath: string,
  options: PartialFetchOptions = {}
): Promise<PartialFetchResult> {
  const fetchFn = options.fetchFn || fetch;
  const partPath = `${destinationPath}.part`;
  const expectedBytes = range.endByte - range.startByte + 1;

  if (range.startByte < 0 || range.endByte < range.startByte) {
    throw new Error(`Invalid byte range: ${range.startByte}-${range.endByte}`);
  }

  // Ensure destination directory exists
  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });

  if (!options.allowOverwrite) {
    try {
      const stat = await fsp.stat(destinationPath);
      if (stat.size > 0) {
        throw new Error(
          `Destination file already exists and overwrite is disabled: ${destinationPath}`
        );
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        Range: `bytes=${range.startByte}-${range.endByte}`,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        ...options.headers,
      },
    });
  } catch (err: any) {
    throw new Error(`Partial fetch network request failed for ${url}: ${err.message || String(err)}`);
  }

  // Strict Fail-Closed Check 1: Must be HTTP 206
  if (response.status === 200) {
    // Abort reading stream immediately to prevent full file download
    try {
      if (response.body) {
        const reader = response.body.getReader();
        reader.cancel().catch(() => {});
      }
    } catch {}
    throw new Http206RequiredError(
      `Server returned HTTP 200 OK instead of 206 Partial Content for range ${range.startByte}-${range.endByte} on ${url}. Byte-range requests are ignored or unsupported by server.`
    );
  }

  if (response.status !== 206) {
    throw new Http206RequiredError(
      `Partial fetch failed with HTTP ${response.status} ${response.statusText} for ${url}`
    );
  }

  // Strict Fail-Closed Check 2: Must have Content-Range
  const contentRange = response.headers.get("content-range");
  if (!contentRange) {
    throw new Http206RequiredError(
      `Missing Content-Range header in response from ${url}`
    );
  }

  const crMatch = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
  if (!crMatch) {
    throw new Http206RequiredError(
      `Malformed Content-Range header: "${contentRange}" on ${url}`
    );
  }

  const returnedStart = parseInt(crMatch[1], 10);
  const returnedEnd = parseInt(crMatch[2], 10);
  const totalFileSize = crMatch[3] !== "*" ? parseInt(crMatch[3], 10) : -1;

  if (returnedStart !== range.startByte || returnedEnd !== range.endByte) {
    throw new Http206RequiredError(
      `Server returned mismatched byte range: expected ${range.startByte}-${range.endByte}, received ${returnedStart}-${returnedEnd}`
    );
  }

  if (!response.body) {
    throw new Error(`Response body is empty for range ${range.startByte}-${range.endByte} on ${url}`);
  }

  let transferredBytes = 0;
  const writeStream = fs.createWriteStream(partPath);

  try {
    const nodeReadable = Readable.fromWeb(response.body as any);

    nodeReadable.on("data", (chunk: Buffer) => {
      transferredBytes += chunk.length;
      if (options.onProgress) {
        options.onProgress(transferredBytes, expectedBytes);
      }
    });

    await pipeline(nodeReadable, writeStream);

    await fsp.rename(partPath, destinationPath);

    return {
      destinationPath,
      bytesDownloaded: transferredBytes,
      startByte: returnedStart,
      endByte: returnedEnd,
      totalFileSize,
      contentType: response.headers.get("content-type") || undefined,
    };
  } catch (err: any) {
    writeStream.destroy();
    await fsp.rm(partPath, { force: true }).catch(() => {});
    throw err;
  }
}
