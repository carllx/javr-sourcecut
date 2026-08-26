import type { MP4Index, SampleEntry, TrackIndex } from "./types.js";
import { UnprovablePartialPlanError } from "./types.js";

export interface BoxHeader {
  type: string;
  size: number;
  headerSize: number;
  offset: number; // offset within buffer
  fileOffset: number; // absolute offset in file
}

export function readUInt64BE(buffer: Buffer, offset: number): number {
  const high = buffer.readUInt32BE(offset);
  const low = buffer.readUInt32BE(offset + 4);
  return high * 2 ** 32 + low;
}

export function readBoxes(buffer: Buffer, baseFileOffset: number = 0): BoxHeader[] {
  const boxes: BoxHeader[] = [];
  let pos = 0;

  while (pos + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(pos);
    const type = buffer.toString("ascii", pos + 4, pos + 8);
    let headerSize = 8;

    if (size === 1) {
      if (pos + 16 > buffer.length) break;
      size = readUInt64BE(buffer, pos + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = buffer.length - pos;
    }

    if (size < headerSize || pos + size > buffer.length) {
      break;
    }

    boxes.push({
      type,
      size,
      headerSize,
      offset: pos,
      fileOffset: baseFileOffset + pos,
    });

    pos += size;
  }

  return boxes;
}

export function findBoxHeader(
  buffer: Buffer,
  targetType: string,
  baseFileOffset: number = 0
): BoxHeader | null {
  const boxes = readBoxes(buffer, baseFileOffset);
  const found = boxes.find((b) => b.type === targetType);
  if (found) {
    return found;
  }

  // If aligned scan didn't find the box (e.g. buffer starts in middle of mdat), scan by signature
  const targetBuf = Buffer.from(targetType, "ascii");
  let matchIdx = buffer.indexOf(targetBuf);

  while (matchIdx !== -1) {
    if (matchIdx >= 4) {
      const boxOffset = matchIdx - 4;
      let size = buffer.readUInt32BE(boxOffset);
      let headerSize = 8;

      if (size === 1 && boxOffset + 16 <= buffer.length) {
        size = readUInt64BE(buffer, boxOffset + 8);
        headerSize = 16;
      }

      if (size >= headerSize) {
        return {
          type: targetType,
          size,
          headerSize,
          offset: boxOffset,
          fileOffset: baseFileOffset + boxOffset,
        };
      }
    }
    matchIdx = buffer.indexOf(targetBuf, matchIdx + 1);
  }

  return null;
}

export function findBox(
  buffer: Buffer,
  targetType: string,
  baseFileOffset: number = 0
): { header: BoxHeader; data: Buffer } | null {
  const boxes = readBoxes(buffer, baseFileOffset);
  const found = boxes.find((b) => b.type === targetType);
  if (found) {
    const boxEnd = found.offset + found.size;
    if (boxEnd <= buffer.length) {
      const data = buffer.subarray(found.offset + found.headerSize, boxEnd);
      return { header: found, data };
    }
  }

  // If aligned scan didn't find the box (e.g. buffer starts in middle of mdat), scan by signature
  const targetBuf = Buffer.from(targetType, "ascii");
  let matchIdx = buffer.indexOf(targetBuf);

  while (matchIdx !== -1) {
    if (matchIdx >= 4) {
      const boxOffset = matchIdx - 4;
      let size = buffer.readUInt32BE(boxOffset);
      let headerSize = 8;

      if (size === 1 && boxOffset + 16 <= buffer.length) {
        size = readUInt64BE(buffer, boxOffset + 8);
        headerSize = 16;
      }

      if (size >= headerSize && boxOffset + size <= buffer.length) {
        const data = buffer.subarray(boxOffset + headerSize, boxOffset + size);
        return {
          header: {
            type: targetType,
            size,
            headerSize,
            offset: boxOffset,
            fileOffset: baseFileOffset + boxOffset,
          },
          data,
        };
      }
    }
    matchIdx = buffer.indexOf(targetBuf, matchIdx + 1);
  }

  return null;
}

export function parseMP4Buffer(
  buffer: Buffer,
  fileSize: number,
  bufferFileOffset: number = 0
): MP4Index {
  // Find moov box
  const moovBox = findBox(buffer, "moov", bufferFileOffset);
  if (!moovBox) {
    throw new UnprovablePartialPlanError(
      "moov atom not found in buffer. Bounded probe failed to locate MP4 index."
    );
  }

  const moovData = moovBox.data;
  const moovOffset = moovBox.header.fileOffset;
  const moovSize = moovBox.header.size;
  const hasMoovAtStart = bufferFileOffset === 0 && moovOffset < Math.max(1024 * 1024, fileSize / 2) && moovOffset < (fileSize - moovSize - 100);

  // Parse mvhd
  const mvhdBox = findBox(moovData, "mvhd", moovOffset + moovBox.header.headerSize);
  let movieTimescale = 1000;
  let movieDuration = 0;

  if (mvhdBox) {
    const version = mvhdBox.data.readUInt8(0);
    if (version === 1) {
      movieTimescale = mvhdBox.data.readUInt32BE(20);
      movieDuration = readUInt64BE(mvhdBox.data, 24) / movieTimescale;
    } else {
      movieTimescale = mvhdBox.data.readUInt32BE(12);
      const durationTicks = mvhdBox.data.readUInt32BE(16);
      movieDuration = durationTicks / movieTimescale;
    }
  }

  // Parse trak boxes
  const trakBoxes: BoxHeader[] = [];
  let pos = 0;
  while (pos + 8 <= moovData.length) {
    const size = moovData.readUInt32BE(pos);
    const type = moovData.toString("ascii", pos + 4, pos + 8);
    if (size < 8) break;
    if (type === "trak") {
      trakBoxes.push({
        type,
        size,
        headerSize: 8,
        offset: pos,
        fileOffset: moovOffset + moovBox.header.headerSize + pos,
      });
    }
    pos += size;
  }

  const tracks: TrackIndex[] = [];

  for (const trak of trakBoxes) {
    const trakData = moovData.subarray(trak.offset + trak.headerSize, trak.offset + trak.size);
    const track = parseTrack(trakData, trak.fileOffset + trak.headerSize, movieTimescale);
    if (track) {
      tracks.push(track);
    }
  }

  return {
    fileSize,
    moovOffset,
    moovSize,
    timescale: movieTimescale,
    duration: movieDuration,
    tracks,
    hasMoovAtStart,
  };
}

function parseTrack(
  trakData: Buffer,
  trakFileOffset: number,
  movieTimescale: number
): TrackIndex | null {
  // tkhd
  const tkhd = findBox(trakData, "tkhd", trakFileOffset);
  let trackId = 1;
  let width = 0;
  let height = 0;

  if (tkhd) {
    const version = tkhd.data.readUInt8(0);
    if (version === 1) {
      trackId = tkhd.data.readUInt32BE(20);
      width = tkhd.data.readUInt32BE(88) >> 16;
      height = tkhd.data.readUInt32BE(92) >> 16;
    } else {
      trackId = tkhd.data.readUInt32BE(12);
      width = tkhd.data.readUInt32BE(76) >> 16;
      height = tkhd.data.readUInt32BE(80) >> 16;
    }
  }

  // mdia
  const mdia = findBox(trakData, "mdia", trakFileOffset);
  if (!mdia) return null;

  // mdhd
  const mdhd = findBox(mdia.data, "mdhd");
  let trackTimescale = movieTimescale;
  let trackDuration = 0;

  if (mdhd) {
    const version = mdhd.data.readUInt8(0);
    if (version === 1) {
      trackTimescale = mdhd.data.readUInt32BE(20);
      trackDuration = readUInt64BE(mdhd.data, 24) / trackTimescale;
    } else {
      trackTimescale = mdhd.data.readUInt32BE(12);
      const durationTicks = mdhd.data.readUInt32BE(16);
      trackDuration = durationTicks / trackTimescale;
    }
  }

  // hdlr
  const hdlr = findBox(mdia.data, "hdlr");
  let trackType: "video" | "audio" | "hint" | "other" = "other";
  if (hdlr && hdlr.data.length >= 12) {
    const handlerType = hdlr.data.toString("ascii", 8, 12);
    if (handlerType === "vide") trackType = "video";
    else if (handlerType === "soun") trackType = "audio";
    else if (handlerType === "hint") trackType = "hint";
  }

  // minf -> stbl
  const minf = findBox(mdia.data, "minf");
  if (!minf) return null;

  const stbl = findBox(minf.data, "stbl");
  if (!stbl) return null;

  // stsd (Sample Description)
  let codec = "unknown";
  const stsd = findBox(stbl.data, "stsd");
  if (stsd && stsd.data.length >= 16) {
    codec = stsd.data.toString("ascii", 12, 16);
    if (trackType === "video" && stsd.data.length >= 36) {
      const visualWidth = stsd.data.readUInt16BE(24);
      const visualHeight = stsd.data.readUInt16BE(26);
      if (visualWidth > 0) width = visualWidth;
      if (visualHeight > 0) height = visualHeight;
    }
  }

  // stts (Time to Sample)
  const stts = findBox(stbl.data, "stts");
  const sampleDurations: number[] = [];
  if (stts && stts.data.length >= 8) {
    const entryCount = stts.data.readUInt32BE(4);
    let offset = 8;
    for (let i = 0; i < entryCount && offset + 8 <= stts.data.length; i++) {
      const count = stts.data.readUInt32BE(offset);
      const delta = stts.data.readUInt32BE(offset + 4);
      for (let j = 0; j < count; j++) {
        sampleDurations.push(delta);
      }
      offset += 8;
    }
  }

  const sampleCount = sampleDurations.length;
  if (sampleCount === 0) return null;

  // ctts (Composition Time Offset, optional)
  const ctts = findBox(stbl.data, "ctts");
  const samplePtsOffsets: number[] = new Array(sampleCount).fill(0);
  if (ctts && ctts.data.length >= 8) {
    const entryCount = ctts.data.readUInt32BE(4);
    let offset = 8;
    let sIdx = 0;
    for (let i = 0; i < entryCount && offset + 8 <= ctts.data.length; i++) {
      const count = ctts.data.readUInt32BE(offset);
      const ptsOffset = ctts.data.readInt32BE(offset + 4);
      for (let j = 0; j < count && sIdx < sampleCount; j++) {
        samplePtsOffsets[sIdx++] = ptsOffset;
      }
      offset += 8;
    }
  }

  // stss (Sync Samples / Keyframes)
  const stss = findBox(stbl.data, "stss");
  const keyframeSet = new Set<number>();
  if (stss && stss.data.length >= 8) {
    const entryCount = stss.data.readUInt32BE(4);
    let offset = 8;
    for (let i = 0; i < entryCount && offset + 4 <= stss.data.length; i++) {
      const sampleNumber = stss.data.readUInt32BE(offset);
      keyframeSet.add(sampleNumber - 1); // convert 1-indexed to 0-indexed
      offset += 4;
    }
  } else if (trackType === "audio" || !stss) {
    for (let i = 0; i < sampleCount; i++) {
      keyframeSet.add(i);
    }
  }

  // stsz (Sample Sizes)
  const stsz = findBox(stbl.data, "stsz");
  const sampleSizes: number[] = [];
  if (stsz && stsz.data.length >= 12) {
    const uniformSize = stsz.data.readUInt32BE(4);
    const count = stsz.data.readUInt32BE(8);
    if (uniformSize > 0) {
      for (let i = 0; i < count; i++) {
        sampleSizes.push(uniformSize);
      }
    } else {
      let offset = 12;
      for (let i = 0; i < count && offset + 4 <= stsz.data.length; i++) {
        sampleSizes.push(stsz.data.readUInt32BE(offset));
        offset += 4;
      }
    }
  }

  // stsc (Sample to Chunk)
  const stsc = findBox(stbl.data, "stsc");
  interface StscEntry {
    firstChunk: number;
    samplesPerChunk: number;
    sampleDescriptionIndex: number;
  }
  const stscEntries: StscEntry[] = [];
  if (stsc && stsc.data.length >= 8) {
    const entryCount = stsc.data.readUInt32BE(4);
    let offset = 8;
    for (let i = 0; i < entryCount && offset + 12 <= stsc.data.length; i++) {
      stscEntries.push({
        firstChunk: stsc.data.readUInt32BE(offset),
        samplesPerChunk: stsc.data.readUInt32BE(offset + 4),
        sampleDescriptionIndex: stsc.data.readUInt32BE(offset + 8),
      });
      offset += 12;
    }
  }

  // stco / co64 (Chunk Offsets)
  const chunkOffsets: number[] = [];
  const stco = findBox(stbl.data, "stco");
  const co64 = findBox(stbl.data, "co64");

  if (stco && stco.data.length >= 8) {
    const entryCount = stco.data.readUInt32BE(4);
    let offset = 8;
    for (let i = 0; i < entryCount && offset + 4 <= stco.data.length; i++) {
      chunkOffsets.push(stco.data.readUInt32BE(offset));
      offset += 4;
    }
  } else if (co64 && co64.data.length >= 8) {
    const entryCount = co64.data.readUInt32BE(4);
    let offset = 8;
    for (let i = 0; i < entryCount && offset + 8 <= co64.data.length; i++) {
      chunkOffsets.push(readUInt64BE(co64.data, offset));
      offset += 8;
    }
  }

  // Map each sample to its absolute file offset
  const sampleOffsets: number[] = new Array(sampleCount).fill(0);
  let currentSampleIdx = 0;

  for (let chunkIdx = 0; chunkIdx < chunkOffsets.length && currentSampleIdx < sampleCount; chunkIdx++) {
    const chunkNum = chunkIdx + 1; // 1-indexed
    let samplesInThisChunk = 1;

    for (let i = stscEntries.length - 1; i >= 0; i--) {
      if (chunkNum >= stscEntries[i].firstChunk) {
        samplesInThisChunk = stscEntries[i].samplesPerChunk;
        break;
      }
    }

    let currentOffsetInChunk = chunkOffsets[chunkIdx];
    for (let s = 0; s < samplesInThisChunk && currentSampleIdx < sampleCount; s++) {
      sampleOffsets[currentSampleIdx] = currentOffsetInChunk;
      const size = sampleSizes[currentSampleIdx] || 0;
      currentOffsetInChunk += size;
      currentSampleIdx++;
    }
  }

  // Construct complete SampleEntry list
  const samples: SampleEntry[] = [];
  let currentDtsTicks = 0;

  for (let i = 0; i < sampleCount; i++) {
    const delta = sampleDurations[i];
    const ptsOffset = samplePtsOffsets[i];
    const dtsSeconds = currentDtsTicks / trackTimescale;
    const ptsSeconds = (currentDtsTicks + ptsOffset) / trackTimescale;
    const durationSeconds = delta / trackTimescale;
    const size = sampleSizes[i] || 0;
    const offset = sampleOffsets[i] || 0;
    const isKeyframe = keyframeSet.has(i);

    samples.push({
      sampleIndex: i,
      dts: dtsSeconds,
      pts: ptsSeconds,
      duration: durationSeconds,
      isKeyframe,
      size,
      offset,
    });

    currentDtsTicks += delta;
  }

  return {
    trackId,
    type: trackType,
    timescale: trackTimescale,
    duration: trackDuration || currentDtsTicks / trackTimescale,
    codec,
    width: width > 0 ? width : undefined,
    height: height > 0 ? height : undefined,
    samples,
  };
}
