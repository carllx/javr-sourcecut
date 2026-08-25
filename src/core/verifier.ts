import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";

const execFileAsync = promisify(execFile);

export interface VideoStreamInfo {
  codec: string;
  width: number;
  height: number;
  fps?: number;
}

export interface AudioStreamInfo {
  codec: string;
  channels?: number;
  sampleRate?: number;
}

export interface FfprobeProbeResult {
  isValid: boolean;
  duration: number;
  videoStream: VideoStreamInfo;
  audioStream?: AudioStreamInfo;
  rawFormat?: any;
}

export function parseFfprobeOutput(
  rawJson: string,
  options: { requireAudio?: boolean } = { requireAudio: true }
): FfprobeProbeResult {
  let data: any;
  try {
    data = JSON.parse(rawJson);
  } catch (err: any) {
    throw new Error(`Failed to parse ffprobe JSON output: ${err.message}`);
  }

  const format = data.format || {};
  const duration = parseFloat(format.duration || "0");
  if (!duration || duration <= 0 || isNaN(duration)) {
    throw new Error(`Proxy media verification failed: invalid duration (${format.duration || "0"}s)`);
  }

  const streams: any[] = Array.isArray(data.streams) ? data.streams : [];
  const videoStreamData = streams.find((s) => s.codec_type === "video");
  if (!videoStreamData) {
    throw new Error("Proxy media verification failed: missing video stream");
  }

  const width = parseInt(videoStreamData.width || "0", 10);
  const height = parseInt(videoStreamData.height || "0", 10);
  if (!width || !height || width <= 0 || height <= 0) {
    throw new Error(`Proxy media verification failed: invalid video dimensions (${width}x${height})`);
  }

  let fps: number | undefined;
  if (videoStreamData.r_frame_rate && typeof videoStreamData.r_frame_rate === "string") {
    const [num, den] = videoStreamData.r_frame_rate.split("/").map(Number);
    if (num && den && den > 0) {
      fps = Math.round(num / den);
    }
  }

  const videoStream: VideoStreamInfo = {
    codec: videoStreamData.codec_name || "unknown",
    width,
    height,
    fps,
  };

  const audioStreamData = streams.find((s) => s.codec_type === "audio");
  if (options.requireAudio && !audioStreamData) {
    throw new Error("Proxy media verification failed: missing audio stream");
  }

  let audioStream: AudioStreamInfo | undefined;
  if (audioStreamData) {
    audioStream = {
      codec: audioStreamData.codec_name || "unknown",
      channels: audioStreamData.channels ? parseInt(audioStreamData.channels, 10) : undefined,
      sampleRate: audioStreamData.sample_rate ? parseInt(audioStreamData.sample_rate, 10) : undefined,
    };
  }

  return {
    isValid: true,
    duration,
    videoStream,
    audioStream,
    rawFormat: format,
  };
}

export async function verifyMediaFile(
  filePath: string,
  options: { requireAudio?: boolean } = { requireAudio: true }
): Promise<FfprobeProbeResult> {
  const stat = await fs.stat(filePath);
  if (stat.size === 0) {
    throw new Error(`Proxy media verification failed: empty file (0 bytes) at ${filePath}`);
  }

  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,channels,sample_rate,duration",
      "-of",
      "json",
      filePath,
    ]);

    return parseFfprobeOutput(stdout, options);
  } catch (err: any) {
    if (err.message && err.message.includes("Proxy media verification failed")) {
      throw err;
    }
    throw new Error(`ffprobe execution failed on ${filePath}: ${err.message || String(err)}`);
  }
}
