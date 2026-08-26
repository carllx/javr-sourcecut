import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createByteRangeFetchPlan,
  createMultiSegmentFetchPlan,
  mergeDiscreteByteRanges,
} from "../../../src/core/mp4/fetch-plan.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

describe("Structurally Proven ByteRange Fetch Plan", () => {
  let tempDir: string;
  let testMp4Path: string;
  let fileBuffer: Buffer;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-plan-test-"));
    testMp4Path = path.join(tempDir, "long_video.mp4");

    // Create a 20s test video with 30fps and GOP size of 30 (keyframe every 1s)
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=20:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=20",
      "-c:v", "libx264", "-g", "30", "-keyint_min", "30",
      "-c:a", "aac",
      "-movflags", "+faststart",
      testMp4Path,
    ]);

    fileBuffer = await fs.readFile(testMp4Path);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("mergeDiscreteByteRanges", () => {
    it("merges overlapping and adjacent byte ranges without creating gaps", () => {
      const input = [
        { startByte: 100, endByte: 200 },
        { startByte: 201, endByte: 300 }, // adjacent
        { startByte: 250, endByte: 400 }, // overlapping
        { startByte: 600, endByte: 700 }, // distant
      ];

      const merged = mergeDiscreteByteRanges(input);
      expect(merged).toEqual([
        { startByte: 100, endByte: 400 },
        { startByte: 600, endByte: 700 },
      ]);
    });

    it("handles unordered input and empty input", () => {
      expect(mergeDiscreteByteRanges([])).toEqual([]);
      const input = [
        { startByte: 500, endByte: 600 },
        { startByte: 100, endByte: 200 },
      ];
      expect(mergeDiscreteByteRanges(input)).toEqual([
        { startByte: 100, endByte: 200 },
        { startByte: 500, endByte: 600 },
      ]);
    });
  });

  it("constructs structurally proven fetch plan for a single 5s-8s time range", async () => {
    const { parseMP4Buffer } = await import("../../../src/core/mp4/box-parser.js");
    const index = parseMP4Buffer(fileBuffer, fileBuffer.length, 0);

    const plan = createByteRangeFetchPlan(
      index,
      { startSeconds: 5.5, endSeconds: 8.2 },
      "http://example.com/video.mp4"
    );

    expect(plan.targetTimeRange).toEqual({ startSeconds: 5.5, endSeconds: 8.2 });
    expect(plan.keyframeAlignedTimeRange.startSeconds).toBeLessThanOrEqual(5.5);
    expect(plan.keyframeAlignedTimeRange.startSeconds).toBeGreaterThanOrEqual(4.5);
    expect(plan.keyframeAlignedTimeRange.endSeconds).toBeGreaterThanOrEqual(8.2);

    expect(plan.videoByteRange.startByte).toBeGreaterThan(0);
    expect(plan.videoByteRange.endByte).toBeGreaterThan(plan.videoByteRange.startByte);

    expect(plan.combinedByteRange.startByte).toBeGreaterThan(0);
    expect(plan.combinedByteRange.endByte).toBeLessThan(fileBuffer.length);

    expect(plan.totalBytesToFetch).toBeLessThan(fileBuffer.length * 0.4);
    expect(plan.savingsRatio).toBeGreaterThan(0.6);
  });

  it("constructs multi-segment fetch plan with discrete ranges for non-contiguous cuts (no large bounding fetch across gap)", async () => {
    const { parseMP4Buffer } = await import("../../../src/core/mp4/box-parser.js");
    const index = parseMP4Buffer(fileBuffer, fileBuffer.length, 0);

    const targetTimeRanges = [
      { startSeconds: 2.0, endSeconds: 4.0 },
      { startSeconds: 15.0, endSeconds: 17.0 },
    ];

    const multiPlan = createMultiSegmentFetchPlan(
      index,
      targetTimeRanges,
      "http://example.com/video.mp4"
    );

    expect(multiPlan.targetTimeRanges).toEqual(targetTimeRanges);
    expect(multiPlan.segmentPlans).toHaveLength(2);

    // Two distant segments must yield two discrete byte ranges
    expect(multiPlan.discreteByteRanges).toHaveLength(2);
    expect(multiPlan.discreteByteRanges[0].endByte).toBeLessThan(
      multiPlan.discreteByteRanges[1].startByte
    );

    // Verify that totalBytesToFetch is the exact sum of the discrete ranges
    const expectedSum =
      multiPlan.discreteByteRanges[0].endByte -
      multiPlan.discreteByteRanges[0].startByte +
      1 +
      (multiPlan.discreteByteRanges[1].endByte -
        multiPlan.discreteByteRanges[1].startByte +
        1);
    expect(multiPlan.totalBytesToFetch).toBe(expectedSum);

    // Bounding range across both would be much larger
    const boundingBytes =
      multiPlan.discreteByteRanges[1].endByte -
      multiPlan.discreteByteRanges[0].startByte +
      1;
    expect(multiPlan.totalBytesToFetch).toBeLessThan(boundingBytes);
    expect(multiPlan.savingsRatio).toBeGreaterThan(0.5);
    expect(multiPlan.isProvablePartial).toBe(true);
  });

  it("merges adjacent or overlapping segments in multi-segment fetch plan", async () => {
    const { parseMP4Buffer } = await import("../../../src/core/mp4/box-parser.js");
    const index = parseMP4Buffer(fileBuffer, fileBuffer.length, 0);

    const targetTimeRanges = [
      { startSeconds: 3.0, endSeconds: 5.5 },
      { startSeconds: 5.0, endSeconds: 7.0 },
    ];

    const multiPlan = createMultiSegmentFetchPlan(
      index,
      targetTimeRanges,
      "http://example.com/video.mp4"
    );

    expect(multiPlan.segmentPlans).toHaveLength(2);
    // Overlapping segments merge into 1 discrete byte range
    expect(multiPlan.discreteByteRanges).toHaveLength(1);
  });
});
