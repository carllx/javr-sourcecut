import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parseMP4Buffer } from "../../../src/core/mp4/box-parser.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

describe("MP4 Box & Sample Table Parser", () => {
  let tempDir: string;
  let faststartMp4Path: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-mp4-test-"));
    faststartMp4Path = path.join(tempDir, "faststart.mp4");

    // Generate a 5s faststart MP4 fixture with 30fps video (keyframe every 30 frames = 1s) and AAC audio
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=5:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=5",
      "-c:v", "libx264", "-g", "30", "-keyint_min", "30",
      "-c:a", "aac",
      "-movflags", "+faststart",
      faststartMp4Path,
    ]);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("parses moov box and extracts video and audio tracks with sample tables", async () => {
    const fileBuffer = await fs.readFile(faststartMp4Path);
    const index = parseMP4Buffer(fileBuffer, fileBuffer.length, 0);

    expect(index).toBeDefined();
    expect(index.duration).toBeGreaterThanOrEqual(4.9);
    expect(index.tracks.length).toBe(2);

    const videoTrack = index.tracks.find((t) => t.type === "video");
    expect(videoTrack).toBeDefined();
    expect(videoTrack?.width).toBe(320);
    expect(videoTrack?.height).toBe(240);
    expect(videoTrack?.samples.length).toBe(150); // 5s * 30fps = 150 frames

    // Check keyframes (sample 0, 30, 60, 90, 120 should be keyframes)
    const keyframes = videoTrack?.samples.filter((s) => s.isKeyframe);
    expect(keyframes?.length).toBe(5);
    expect(keyframes?.[0].sampleIndex).toBe(0);
    expect(keyframes?.[1].sampleIndex).toBe(30);

    // Check sample byte offsets and sizes are valid positive values
    for (const sample of videoTrack!.samples) {
      expect(sample.size).toBeGreaterThan(0);
      expect(sample.offset).toBeGreaterThan(0);
      expect(sample.dts).toBeGreaterThanOrEqual(0);
      expect(sample.pts).toBeGreaterThanOrEqual(0);
    }

    const audioTrack = index.tracks.find((t) => t.type === "audio");
    expect(audioTrack).toBeDefined();
    expect(audioTrack?.samples.length).toBeGreaterThan(100);
  });
});
