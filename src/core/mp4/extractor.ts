import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ByteRange,
  ByteRangeFetchPlan,
  CachedBufferWithRange,
  MP4Index,
  MultiSegmentFetchPlan,
  TimeRange,
} from "./types.js";
import {
  fetchByteRange,
  fetchPlannedByteRangesWithLedger,
  DEFAULT_MAX_CHUNK_SIZE,
} from "./partial-fetcher.js";
import type { TransferLedgerManager } from "./ledger.js";
import type { TransferBudgetTracker } from "./budget.js";
import { verifyMediaFile, type FfprobeProbeResult } from "../verifier.js";

const execFileAsync = promisify(execFile);

export interface ExtractClipParams {
  plan: ByteRangeFetchPlan | MultiSegmentFetchPlan;
  index: MP4Index;
  outputClipPath: string;
  workDir: string;
  cachedHead?: CachedBufferWithRange;
  cachedTail?: CachedBufferWithRange;
  ledgerManager?: TransferLedgerManager;
  budgetTracker?: TransferBudgetTracker;
  maxChunkSize?: number;
  fetchFn?: typeof fetch;
  onProgress?: (transferredBytes: number, totalExpectedBytes: number) => void;
}

export interface ExtractClipResult {
  outputClipPath: string;
  bytesFetched: number;
  probeResult: FfprobeProbeResult;
}

export async function extractClipFromPlan(
  params: ExtractClipParams
): Promise<ExtractClipResult> {
  const {
    plan,
    index,
    outputClipPath,
    workDir,
    cachedHead,
    cachedTail,
    ledgerManager,
    budgetTracker,
    maxChunkSize = DEFAULT_MAX_CHUNK_SIZE,
    fetchFn = fetch,
    onProgress,
  } = params;

  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(path.dirname(outputClipPath), { recursive: true });

  const discreteRanges: ByteRange[] =
    "discreteByteRanges" in plan ? plan.discreteByteRanges : [plan.combinedByteRange];
  const targetSegments: TimeRange[] =
    "targetTimeRanges" in plan ? plan.targetTimeRanges : [plan.targetTimeRange];

  const headPath = path.join(workDir, "head_ftyp.bin");
  const tailMoovPath = path.join(workDir, "tail_moov.bin");
  const sparseMp4Path = path.join(workDir, "sparse_source.mp4");
  const concatListPath = path.join(workDir, "concat_list.txt");

  let totalBytesFetched = 0;

  // 1. Fetch Media Payload Ranges using Bounded Chunks & Ledger
  const chunkFetchResult = await fetchPlannedByteRangesWithLedger({
    url: plan.sourceUrl,
    ranges: discreteRanges,
    workDir,
    maxChunkSize,
    ledgerManager,
    budgetTracker,
    fetchFn,
    onProgress,
  });
  totalBytesFetched += chunkFetchResult.totalNetworkBytes;

  // 2. Obtain Header / Container Metadata (use cached or fetch)
  const headEndByte = index.hasMoovAtStart
    ? index.moovOffset + index.moovSize - 1
    : Math.min(index.fileSize - 1, 1024);

  let headBuffer: Buffer;
  if (
    cachedHead &&
    cachedHead.range.startByte === 0 &&
    cachedHead.range.endByte >= headEndByte &&
    cachedHead.buffer.length >= headEndByte + 1
  ) {
    headBuffer = cachedHead.buffer.subarray(0, headEndByte + 1);
  } else {
    const headFetch = await fetchByteRange(
      plan.sourceUrl,
      { startByte: 0, endByte: headEndByte },
      headPath,
      { fetchFn, budgetTracker, allowOverwrite: true }
    );
    totalBytesFetched += headFetch.bytesDownloaded;
    headBuffer = await fs.readFile(headPath);
  }

  let moovBuffer: Buffer | undefined;
  if (!index.hasMoovAtStart) {
    const moovStart = index.moovOffset;
    const moovEnd = index.moovOffset + index.moovSize - 1;

    if (
      cachedTail &&
      moovStart >= cachedTail.range.startByte &&
      moovEnd <= cachedTail.range.endByte
    ) {
      const relStart = moovStart - cachedTail.range.startByte;
      const relEnd = relStart + index.moovSize;

      if (relStart >= 0 && relEnd <= cachedTail.buffer.length) {
        moovBuffer = cachedTail.buffer.subarray(relStart, relEnd);
      }
    }

    if (!moovBuffer) {
      const tailFetch = await fetchByteRange(
        plan.sourceUrl,
        { startByte: moovStart, endByte: moovEnd },
        tailMoovPath,
        { fetchFn, budgetTracker, allowOverwrite: true }
      );
      totalBytesFetched += tailFetch.bytesDownloaded;
      moovBuffer = await fs.readFile(tailMoovPath);
    }
  }

  // 3. Assemble sparse MP4 with original absolute offsets preserved
  const fileHandle = await fs.open(sparseMp4Path, "w+");
  try {
    // Write head buffer at offset 0 (ftyp + moov if at start)
    await fileHandle.write(headBuffer, 0, headBuffer.length, 0);

    // If moov is at tail, write extracted moovBuffer at exact moovOffset
    if (!index.hasMoovAtStart && moovBuffer) {
      await fileHandle.write(moovBuffer, 0, moovBuffer.length, index.moovOffset);
    }

    // Write all fetched chunk buffers at their exact original file offsets
    for (const chunk of chunkFetchResult.chunks) {
      const chunkBuffer = await fs.readFile(chunk.filePath);
      await fileHandle.write(
        chunkBuffer,
        0,
        chunkBuffer.length,
        chunk.range.startByte
      );
    }

    // Ensure total file size matches original container
    await fileHandle.truncate(index.fileSize);
  } finally {
    await fileHandle.close();
  }

  // 4. Extract target segments via FFmpeg stream-copy
  const tempSegmentPaths: string[] = [];

  try {
    for (let i = 0; i < targetSegments.length; i++) {
      const seg = targetSegments[i];
      const startSec = seg.startSeconds;
      const durationSec = seg.endSeconds - seg.startSeconds;

      const segOutputPath =
        targetSegments.length === 1
          ? outputClipPath
          : path.join(workDir, `segment_${i}.mp4`);

      try {
        await execFileAsync("ffmpeg", [
          "-y",
          "-ss", startSec.toString(),
          "-i", sparseMp4Path,
          "-t", durationSec.toString(),
          "-c", "copy",
          "-movflags", "+faststart",
          segOutputPath,
        ]);
      } catch (copyErr: any) {
        throw new Error(
          `FFmpeg stream-copy extraction failed: ${copyErr.message || copyErr}. Refusing to fallback to re-encoding.`
        );
      }

      const segProbe = await verifyMediaFile(segOutputPath);
      if (!segProbe.isValid) {
        throw new Error(`Extracted segment ${i} failed container verification.`);
      }

      if (targetSegments.length > 1) {
        tempSegmentPaths.push(segOutputPath);
      }
    }

    // 5. If multi-segment, merge via FFmpeg concat demuxer
    if (targetSegments.length > 1) {
      const concatLines = tempSegmentPaths.map(
        (p) => `file '${p.replace(/'/g, "'\\''").replace(/\\/g, "/")}'`
      );
      await fs.writeFile(concatListPath, concatLines.join("\n"), "utf-8");

      try {
        await execFileAsync("ffmpeg", [
          "-y",
          "-f", "concat",
          "-safe", "0",
          "-i", concatListPath,
          "-c", "copy",
          "-movflags", "+faststart",
          outputClipPath,
        ]);
      } catch (concatErr: any) {
        throw new Error(
          `FFmpeg stream-copy concat merge failed: ${concatErr.message || concatErr}. Refusing to fallback to re-encoding.`
        );
      }
    }

    // 6. Authoritative verify of final output clip via ffprobe
    const probeResult = await verifyMediaFile(outputClipPath);

    return {
      outputClipPath,
      bytesFetched: totalBytesFetched,
      probeResult,
    };
  } finally {
    // Clean temporary reconstruction files (preserve chunk files in chunksDir)
    await fs.rm(headPath, { force: true }).catch(() => {});
    await fs.rm(tailMoovPath, { force: true }).catch(() => {});
    await fs.rm(sparseMp4Path, { force: true }).catch(() => {});
    await fs.rm(concatListPath, { force: true }).catch(() => {});
    for (const segPath of tempSegmentPaths) {
      await fs.rm(segPath, { force: true }).catch(() => {});
    }
  }
}
