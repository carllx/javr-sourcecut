import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createByteRangeFetchPlan } from "../../../src/core/mp4/fetch-plan.js";
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

  it("constructs structurally proven fetch plan for a 5s-8s time range", async () => {
    const { parseMP4Buffer } = await import("../../../src/core/mp4/box-parser.js");
    const index = parseMP4Buffer(fileBuffer, fileBuffer.length, 0);

    const plan = createByteRangeFetchPlan(
      index,
      { startSeconds: 5.5, endSeconds: 8.2 },
      "http://example.com/video.mp4"
    );

    expect(plan.targetTimeRange).toEqual({ startSeconds: 5.5, endSeconds: 8.2 });
    // Keyframe start time must be <= target startSeconds (5.5s)
    expect(plan.keyframeAlignedTimeRange.startSeconds).toBeLessThanOrEqual(5.5);
    expect(plan.keyframeAlignedTimeRange.startSeconds).toBeGreaterThanOrEqual(4.5);
    expect(plan.keyframeAlignedTimeRange.endSeconds).toBeGreaterThanOrEqual(8.2);

    expect(plan.videoByteRange.startByte).toBeGreaterThan(0);
    expect(plan.videoByteRange.endByte).toBeGreaterThan(plan.videoByteRange.startByte);

    expect(plan.combinedByteRange.startByte).toBeGreaterThan(0);
    expect(plan.combinedByteRange.endByte).toBeLessThan(fileBuffer.length);

    // Total bytes to fetch must be significantly smaller than full file (< 35% of 20s file)
    expect(plan.totalBytesToFetch).toBeLessThan(fileBuffer.length * 0.4);
    expect(plan.savingsRatio).toBeGreaterThan(0.6);
  });
});
