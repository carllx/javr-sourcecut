import { describe, it, expect } from "vitest";
import { verifyMediaFile, parseFfprobeOutput } from "../../src/core/verifier.js";

describe("FFprobe Media Verifier", () => {
  it("parses valid ffprobe output correctly with audio and video streams", () => {
    const rawFfprobeJson = JSON.stringify({
      streams: [
        {
          index: 0,
          codec_name: "av01",
          codec_type: "video",
          width: 854,
          height: 480,
          r_frame_rate: "30/1",
          duration: "904.5",
        },
        {
          index: 1,
          codec_name: "aac",
          codec_type: "audio",
          channels: 2,
          sample_rate: "48000",
          duration: "904.5",
        },
      ],
      format: {
        duration: "904.5",
        size: "63753420",
        bit_rate: "564000",
      },
    });

    const result = parseFfprobeOutput(rawFfprobeJson);
    expect(result.isValid).toBe(true);
    expect(result.duration).toBeCloseTo(904.5);
    expect(result.videoStream.codec).toBe("av01");
    expect(result.videoStream.width).toBe(854);
    expect(result.videoStream.height).toBe(480);
    expect(result.audioStream?.codec).toBe("aac");
    expect(result.audioStream?.channels).toBe(2);
    expect(result.audioStream?.sampleRate).toBe(48000);
  });

  it("fails verification if duration is 0 or missing", () => {
    const rawFfprobeJson = JSON.stringify({
      streams: [
        {
          index: 0,
          codec_name: "h264",
          codec_type: "video",
          width: 854,
          height: 480,
        },
        {
          index: 1,
          codec_name: "aac",
          codec_type: "audio",
        },
      ],
      format: {
        duration: "0",
        size: "1000",
      },
    });

    expect(() => parseFfprobeOutput(rawFfprobeJson)).toThrow("invalid duration");
  });

  it("fails verification if video stream is missing", () => {
    const rawFfprobeJson = JSON.stringify({
      streams: [
        {
          index: 0,
          codec_name: "aac",
          codec_type: "audio",
          duration: "100",
        },
      ],
      format: {
        duration: "100",
        size: "1000",
      },
    });

    expect(() => parseFfprobeOutput(rawFfprobeJson)).toThrow("missing video stream");
  });

  it("fails verification if audio stream is missing when required", () => {
    const rawFfprobeJson = JSON.stringify({
      streams: [
        {
          index: 0,
          codec_name: "h264",
          codec_type: "video",
          width: 854,
          height: 480,
        },
      ],
      format: {
        duration: "100",
        size: "1000",
      },
    });

    expect(() => parseFfprobeOutput(rawFfprobeJson, { requireAudio: true })).toThrow("missing audio stream");
  });

  it("fails if file does not exist", async () => {
    await expect(verifyMediaFile("C:/non/existent/video.mp4")).rejects.toThrow();
  });
});
