import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ByteRange } from "./types.js";
import {
  Http206RequiredError,
  RenditionVersionMismatchError,
} from "./types.js";
import { isStrongEtag, type TransferLedgerManager } from "./ledger.js";
import type { TransferBudgetTracker } from "./budget.js";

export const DEFAULT_MAX_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB bounded transfer chunk

export interface PartialFetchOptions {
  fetchFn?: typeof fetch;
  headers?: Record<string, string>;
  onProgress?: (transferredBytes: number, totalExpectedBytes: number) => void;
  allowOverwrite?: boolean;
  budgetTracker?: TransferBudgetTracker;
  expectedTotalFileSize?: number;
  expectedEtag?: string;
}

export interface PartialFetchResult {
  destinationPath: string;
  bytesDownloaded: number;
  startByte: number;
  endByte: number;
  totalFileSize: number;
  contentType?: string;
  etag?: string;
  lastModified?: string;
}

function cancelResponseBody(response: Response) {
  try {
    if (response.body) {
      const reader = response.body.getReader();
      reader.cancel().catch(() => {});
    }
  } catch {}
}

export function partitionByteRangeIntoChunks(
  range: ByteRange,
  maxChunkSize: number = DEFAULT_MAX_CHUNK_SIZE
): ByteRange[] {
  if (maxChunkSize <= 0) {
    throw new Error("maxChunkSize must be a positive integer");
  }

  const chunks: ByteRange[] = [];
  let currentStart = range.startByte;

  while (currentStart <= range.endByte) {
    const currentEnd = Math.min(currentStart + maxChunkSize - 1, range.endByte);
    chunks.push({
      startByte: currentStart,
      endByte: currentEnd,
    });
    currentStart = currentEnd + 1;
  }

  return chunks;
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

  // Prospective budget check BEFORE issuing network request
  if (options.budgetTracker) {
    options.budgetTracker.checkProspectiveBudget(expectedBytes);
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
    cancelResponseBody(response);
    throw new Http206RequiredError(
      `Server returned HTTP 200 OK instead of 206 Partial Content for range ${range.startByte}-${range.endByte} on ${url}. Byte-range requests are ignored or unsupported by server.`
    );
  }

  if (response.status !== 206) {
    cancelResponseBody(response);
    throw new Http206RequiredError(
      `Partial fetch failed with HTTP ${response.status} ${response.statusText} for ${url}`
    );
  }

  // Strict Fail-Closed Check 2: Content-Range format & bounds
  const contentRange = response.headers.get("content-range");
  if (!contentRange) {
    cancelResponseBody(response);
    throw new Http206RequiredError(
      `Missing Content-Range header in response from ${url}`
    );
  }

  const crMatch = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!crMatch) {
    cancelResponseBody(response);
    throw new Http206RequiredError(
      `Malformed Content-Range header: "${contentRange}" on ${url}`
    );
  }

  if (crMatch[3] === "*") {
    cancelResponseBody(response);
    throw new Http206RequiredError(
      `Content-Range total file size cannot be wildcard (*) on ${url}`
    );
  }

  const returnedStart = parseInt(crMatch[1], 10);
  const returnedEnd = parseInt(crMatch[2], 10);
  const totalFileSize = parseInt(crMatch[3], 10);

  if (isNaN(totalFileSize) || totalFileSize <= 0) {
    cancelResponseBody(response);
    throw new Http206RequiredError(
      `Invalid total file size "${crMatch[3]}" in Content-Range on ${url}`
    );
  }

  // Strict Fail-Closed Check 3: Content-Range TOTAL must exactly match authoritative index fileSize
  if (
    options.expectedTotalFileSize !== undefined &&
    totalFileSize !== options.expectedTotalFileSize
  ) {
    cancelResponseBody(response);
    throw new RenditionVersionMismatchError(
      `Authoritative total file size changed during transfer: expected ${options.expectedTotalFileSize} bytes, received ${totalFileSize} bytes in Content-Range on ${url}`
    );
  }

  if (returnedStart !== range.startByte || returnedEnd !== range.endByte) {
    cancelResponseBody(response);
    throw new Http206RequiredError(
      `Server returned mismatched byte range: expected ${range.startByte}-${range.endByte}, received ${returnedStart}-${returnedEnd}`
    );
  }

  // Strict Fail-Closed Check 4: Authoritative strong ETag must be present and match on every chunk
  const responseEtag = response.headers.get("etag") || undefined;
  if (options.expectedEtag && isStrongEtag(options.expectedEtag)) {
    if (!responseEtag) {
      cancelResponseBody(response);
      throw new RenditionVersionMismatchError(
        `Authoritative strong ETag "${options.expectedEtag}" is required, but chunk response for ${url} (bytes ${range.startByte}-${range.endByte}) is missing an ETag header.`
      );
    }
    if (!isStrongEtag(responseEtag)) {
      cancelResponseBody(response);
      throw new RenditionVersionMismatchError(
        `Authoritative strong ETag "${options.expectedEtag}" is required, but chunk response for ${url} (bytes ${range.startByte}-${range.endByte}) returned a weak ETag: "${responseEtag}".`
      );
    }
    if (responseEtag !== options.expectedEtag) {
      cancelResponseBody(response);
      throw new RenditionVersionMismatchError(
        `Strong ETag changed during transfer for ${url}: expected "${options.expectedEtag}", received "${responseEtag}". Aborting without assembly.`
      );
    }
  } else if (
    options.expectedEtag &&
    responseEtag &&
    isStrongEtag(responseEtag) &&
    responseEtag !== options.expectedEtag
  ) {
    cancelResponseBody(response);
    throw new RenditionVersionMismatchError(
      `Strong ETag changed during transfer: expected ${options.expectedEtag}, received ${responseEtag} from ${url}`
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
      if (options.budgetTracker) {
        options.budgetTracker.recordBytes(chunk.length);
      }
      if (options.onProgress) {
        options.onProgress(transferredBytes, expectedBytes);
      }
    });

    await pipeline(nodeReadable, writeStream);

    // Strict Fail-Closed Check 5: Transferred body bytes must exactly match expected bytes
    if (transferredBytes !== expectedBytes) {
      await fsp.rm(partPath, { force: true }).catch(() => {});
      throw new Http206RequiredError(
        `Partial fetch body length mismatch: expected ${expectedBytes} bytes, received ${transferredBytes} bytes`
      );
    }

    await fsp.rename(partPath, destinationPath);

    return {
      destinationPath,
      bytesDownloaded: transferredBytes,
      startByte: returnedStart,
      endByte: returnedEnd,
      totalFileSize,
      contentType: response.headers.get("content-type") || undefined,
      etag: responseEtag,
      lastModified: response.headers.get("last-modified") || undefined,
    };
  } catch (err: any) {
    writeStream.destroy();
    await fsp.rm(partPath, { force: true }).catch(() => {});
    throw err;
  }
}

export interface FetchPlannedByteRangesParams {
  url: string;
  ranges: ByteRange[];
  workDir: string;
  maxChunkSize?: number;
  ledgerManager?: TransferLedgerManager;
  budgetTracker?: TransferBudgetTracker;
  fetchFn?: typeof fetch;
  headers?: Record<string, string>;
  expectedTotalFileSize?: number;
  expectedEtag?: string;
  onProgress?: (transferredBytes: number, totalExpectedBytes: number) => void;
}


export interface ChunkFetchSummary {
  range: ByteRange;
  filePath: string;
  byteLength: number;
  fromCache: boolean;
  etag?: string;
  sha256?: string;
}

export interface FetchPlannedByteRangesResult {
  chunks: ChunkFetchSummary[];
  totalNetworkBytes: number;
  totalPayloadBytes: number;
  etag?: string;
}

export async function fetchPlannedByteRangesWithLedger(
  params: FetchPlannedByteRangesParams
): Promise<FetchPlannedByteRangesResult> {
  const {
    url,
    ranges,
    workDir,
    maxChunkSize = DEFAULT_MAX_CHUNK_SIZE,
    ledgerManager,
    budgetTracker,
    fetchFn,
    headers,
    onProgress,
  } = params;

  const chunksDir = path.join(workDir, "chunks");
  await fsp.mkdir(chunksDir, { recursive: true });

  const partitionedChunks = ranges.flatMap((r) =>
    partitionByteRangeIntoChunks(r, maxChunkSize)
  );

  const totalPayloadBytes = partitionedChunks.reduce(
    (sum, c) => sum + (c.endByte - c.startByte + 1),
    0
  );

  let cumulativeNetworkBytes = 0;
  let observedEtag: string | undefined;
  const chunkSummaries: ChunkFetchSummary[] = [];

  for (const chunk of partitionedChunks) {
    const chunkId = `chunk_${chunk.startByte}_${chunk.endByte}`;
    const chunkPath = path.join(chunksDir, `${chunkId}.bin`);
    const chunkExpectedLength = chunk.endByte - chunk.startByte + 1;

    // 1. Check ledger for cached, valid completed chunk
    let validEntry = null;
    if (ledgerManager) {
      validEntry = await ledgerManager.getValidCompletedChunk(chunk);
    }

    if (validEntry) {
      chunkSummaries.push({
        range: chunk,
        filePath: validEntry.filePath,
        byteLength: validEntry.byteLength,
        fromCache: true,
        etag: validEntry.etag,
        sha256: validEntry.sha256,
      });
      observedEtag = observedEtag || validEntry.etag;
      onProgress?.(cumulativeNetworkBytes, totalPayloadBytes);
      continue;
    }

    // 2. Fetch missing chunk over HTTP 206
    let chunkBytesTransferredThisAttempt = 0;
    try {
      const activeStrongEtag = isStrongEtag(observedEtag)
        ? observedEtag
        : isStrongEtag(params.expectedEtag)
        ? params.expectedEtag
        : undefined;

      const fetchRes = await fetchByteRange(url, chunk, chunkPath, {
        fetchFn,
        headers,
        allowOverwrite: true,
        budgetTracker,
        expectedTotalFileSize: params.expectedTotalFileSize,
        expectedEtag: activeStrongEtag,
        onProgress: (chunkTransferred) => {
          chunkBytesTransferredThisAttempt = chunkTransferred;
          onProgress?.(cumulativeNetworkBytes + chunkTransferred, totalPayloadBytes);
        },
      });

      cumulativeNetworkBytes += fetchRes.bytesDownloaded;
      chunkBytesTransferredThisAttempt = 0;

      if (fetchRes.etag && isStrongEtag(fetchRes.etag)) {
        if (observedEtag && isStrongEtag(observedEtag) && fetchRes.etag !== observedEtag) {
          throw new RenditionVersionMismatchError(
            `Strong ETag changed midway through transfer: expected ${observedEtag}, received ${fetchRes.etag}`
          );
        }
        observedEtag = fetchRes.etag;
      } else if (!observedEtag && fetchRes.etag) {
        observedEtag = fetchRes.etag;
      }

      // 3. Compute sha256 checksum for local integrity
      const chunkBuffer = await fsp.readFile(chunkPath);
      const sha256 = crypto.createHash("sha256").update(chunkBuffer).digest("hex");

      // 4. Immediately record completed chunk in ledger

      if (ledgerManager) {
        await ledgerManager.recordCompletedChunk({
          range: chunk,
          byteLength: fetchRes.bytesDownloaded,
          filePath: chunkPath,
          sha256,
          etag: fetchRes.etag,
          transferredNetworkBytes: fetchRes.bytesDownloaded,
        });
      }

      chunkSummaries.push({
        range: chunk,
        filePath: chunkPath,
        byteLength: fetchRes.bytesDownloaded,
        fromCache: false,
        etag: fetchRes.etag,
        sha256,
      });
    } catch (err: any) {
      // Record in-flight failed attempt bytes in ledger so restart accounts for wasted bytes against budget
      if (ledgerManager && chunkBytesTransferredThisAttempt > 0) {
        await ledgerManager.recordFailedAttempt(chunkBytesTransferredThisAttempt);
      }
      throw err;
    }
  }


  return {
    chunks: chunkSummaries,
    totalNetworkBytes: cumulativeNetworkBytes,
    totalPayloadBytes,
    etag: observedEtag,
  };
}
