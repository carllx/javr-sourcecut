import type { ByteRange, ByteRangeFetchPlan, MP4Index, TimeRange } from "./types.js";
import { UnprovablePartialPlanError } from "./types.js";

export function createByteRangeFetchPlan(
  index: MP4Index,
  targetTimeRange: TimeRange,
  sourceUrl: string
): ByteRangeFetchPlan {
  const { startSeconds, endSeconds } = targetTimeRange;

  if (startSeconds < 0 || endSeconds <= startSeconds) {
    throw new UnprovablePartialPlanError(
      `Invalid target time range: start=${startSeconds}s, end=${endSeconds}s`
    );
  }

  // 1. Locate video track and samples
  const videoTrack = index.tracks.find((t) => t.type === "video");
  if (!videoTrack || videoTrack.samples.length === 0) {
    throw new UnprovablePartialPlanError(
      "Cannot build byte range fetch plan: no video track with sample table in MP4 index."
    );
  }

  const vSamples = videoTrack.samples;

  // 2. Find keyframe sample at or immediately preceding startSeconds
  let startKeyframeIdx = -1;
  for (let i = 0; i < vSamples.length; i++) {
    const s = vSamples[i];
    if (s.pts <= startSeconds && s.isKeyframe) {
      startKeyframeIdx = i;
    } else if (s.pts > startSeconds && startKeyframeIdx !== -1) {
      break;
    }
  }

  // If startSeconds is before first keyframe, or no keyframe <= startSeconds, take the first keyframe
  if (startKeyframeIdx === -1) {
    const firstKey = vSamples.find((s) => s.isKeyframe);
    if (!firstKey) {
      throw new UnprovablePartialPlanError("No keyframe found in video track.");
    }
    startKeyframeIdx = firstKey.sampleIndex;
  }

  // 3. Find end sample at or immediately following endSeconds
  let endSampleIdx = vSamples.length - 1;
  for (let i = startKeyframeIdx; i < vSamples.length; i++) {
    const s = vSamples[i];
    if (s.pts + s.duration >= endSeconds) {
      endSampleIdx = i;
      break;
    }
  }

  const startVideoSample = vSamples[startKeyframeIdx];
  const endVideoSample = vSamples[endSampleIdx];

  const keyframeAlignedTimeRange: TimeRange = {
    startSeconds: startVideoSample.pts,
    endSeconds: endVideoSample.pts + endVideoSample.duration,
  };

  // 4. Structurally determine video byte range
  const videoIncludedSamples = vSamples.slice(startKeyframeIdx, endSampleIdx + 1);
  const videoStartByte = Math.min(...videoIncludedSamples.map((s) => s.offset));
  const videoEndByte = Math.max(...videoIncludedSamples.map((s) => s.offset + s.size - 1));

  const videoByteRange: ByteRange = {
    startByte: videoStartByte,
    endByte: videoEndByte,
  };

  // 5. Locate matching audio samples if audio track is present
  const audioTrack = index.tracks.find((t) => t.type === "audio");
  let audioByteRange: ByteRange | undefined;

  if (audioTrack && audioTrack.samples.length > 0) {
    const aSamples = audioTrack.samples;
    const aStart = aSamples.find((s) => s.pts + s.duration >= keyframeAlignedTimeRange.startSeconds) || aSamples[0];
    const aEnd = aSamples.find((s) => s.pts + s.duration >= keyframeAlignedTimeRange.endSeconds) || aSamples[aSamples.length - 1];

    const aStartIdx = Math.min(aStart.sampleIndex, aEnd.sampleIndex);
    const aEndIdx = Math.max(aStart.sampleIndex, aEnd.sampleIndex);

    const audioIncludedSamples = aSamples.slice(aStartIdx, aEndIdx + 1);
    const audioStartByte = Math.min(...audioIncludedSamples.map((s) => s.offset));
    const audioEndByte = Math.max(...audioIncludedSamples.map((s) => s.offset + s.size - 1));

    audioByteRange = {
      startByte: audioStartByte,
      endByte: audioEndByte,
    };
  }

  // 6. Combine continuous media byte range
  const combinedStart = Math.min(videoByteRange.startByte, audioByteRange ? audioByteRange.startByte : videoByteRange.startByte);
  const combinedEnd = Math.max(videoByteRange.endByte, audioByteRange ? audioByteRange.endByte : videoByteRange.endByte);

  const combinedByteRange: ByteRange = {
    startByte: combinedStart,
    endByte: combinedEnd,
  };

  // 7. Moov header range
  const moovByteRange: ByteRange = {
    startByte: index.moovOffset,
    endByte: index.moovOffset + index.moovSize - 1,
  };

  const mediaBytes = combinedByteRange.endByte - combinedByteRange.startByte + 1;
  const totalBytesToFetch = mediaBytes;
  const fullFileBytes = index.fileSize;
  const savingsRatio = Math.max(0, 1 - totalBytesToFetch / fullFileBytes);
  const isProvablePartial = savingsRatio > 0 && totalBytesToFetch < fullFileBytes;

  return {
    sourceUrl,
    targetTimeRange,
    keyframeAlignedTimeRange,
    videoByteRange,
    audioByteRange,
    combinedByteRange,
    segmentRanges: [combinedByteRange],
    totalBytesToFetch,
    fullFileBytes,
    savingsRatio,
    isProvablePartial,
    moovByteRange,
  };
}

