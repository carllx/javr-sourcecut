import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ByteRange, ByteRangeFetchPlan, CachedBufferWithRange, MP4Index } from "./types.js";
import { fetchByteRange } from "./partial-fetcher.js";
import { verifyMediaFile, type FfprobeProbeResult } from "../verifier.js";

const execFileAsync = promisify(execFile);

export interface ExtractClipParams {
  plan: ByteRangeFetchPlan;
  index: MP4Index;
  outputClipPath: string;
  workDir: string;
  cachedHead?: CachedBufferWithRange;
  cachedTail?: CachedBufferWithRange;
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
    fetchFn = fetch,
    onProgress,
  } = params;

  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(path.dirname(outputClipPath), { recursive: true });

  const mediaChunkPath = path.join(
    workDir,
    `media_range_${plan.combinedByteRange.startByte}_${plan.combinedByteRange.endByte}.bin`
  );
  const headPath = path.join(workDir, "head_ftyp.bin");
  const tailMoovPath = path.join(workDir, "tail_moov.bin");
  const sparseMp4Path = path.join(workDir, "sparse_source.mp4");

  let totalBytesFetched = 0;

  // 1. Fetch Media Payload Range (HTTP 206)
  const mediaFetch = await fetchByteRange(
    plan.sourceUrl,
    plan.combinedByteRange,
    mediaChunkPath,
    { fetchFn, onProgress, allowOverwrite: true }
  );
  totalBytesFetched += mediaFetch.bytesDownloaded;

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
      { fetchFn, allowOverwrite: true }
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
        { fetchFn, allowOverwrite: true }
      );
      totalBytesFetched += tailFetch.bytesDownloaded;
      moovBuffer = await fs.readFile(tailMoovPath);
    }
  }

  // 3. Assemble sparse MP4 with original absolute offsets preserved
  const mediaBuffer = await fs.readFile(mediaChunkPath);

  const fileHandle = await fs.open(sparseMp4Path, "w+");
  try {
    // Write head buffer at offset 0 (ftyp + moov if at start)
    await fileHandle.write(headBuffer, 0, headBuffer.length, 0);

    // If moov is at tail, write extracted moovBuffer at exact moovOffset
    if (!index.hasMoovAtStart && moovBuffer) {
      await fileHandle.write(moovBuffer, 0, moovBuffer.length, index.moovOffset);
    }

    // Write media buffer at its exact original file offset
    await fileHandle.write(
      mediaBuffer,
      0,
      mediaBuffer.length,
      plan.combinedByteRange.startByte
    );

    // Ensure total file size matches original container
    await fileHandle.truncate(index.fileSize);
  } finally {
    await fileHandle.close();
  }

  // 4. Extract target segment via FFmpeg stream-copy
  const startSec = plan.targetTimeRange.startSeconds;
  const durationSec = plan.targetTimeRange.endSeconds - plan.targetTimeRange.startSeconds;

  try {
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-ss", startSec.toString(),
        "-i", sparseMp4Path,
        "-t", durationSec.toString(),
        "-c", "copy",
        "-movflags", "+faststart",
        outputClipPath,
      ]);
    } catch (copyErr: any) {
      throw new Error(
        `FFmpeg stream-copy extraction failed: ${copyErr.message || copyErr}. Refusing to fallback to re-encoding.`
      );
    }

    // 5. Verify extracted clip via ffprobe
    const probeResult = await verifyMediaFile(outputClipPath);

    return {
      outputClipPath,
      bytesFetched: totalBytesFetched,
      probeResult,
    };
  } finally {
    // Clean temporary reconstruction files
    await fs.rm(mediaChunkPath, { force: true }).catch(() => {});
    await fs.rm(headPath, { force: true }).catch(() => {});
    await fs.rm(tailMoovPath, { force: true }).catch(() => {});
    await fs.rm(sparseMp4Path, { force: true }).catch(() => {});
  }
}
