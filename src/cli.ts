#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { runTracerSlice, resumeJobWorkflow } from "./core/workflow.js";
import { launchAuthBrowser, resetAuthProfile } from "./core/session.js";
import type { QualityTargetOptions, VideoCodec } from "./types.js";

const VALID_CODECS: VideoCodec[] = ["av1", "h264", "hevc", "other"];

export function validateCodec(codecStr: string): VideoCodec {
  const normalized = codecStr.toLowerCase().trim() as VideoCodec;
  if (!VALID_CODECS.includes(normalized)) {
    throw new Error(
      `Invalid codec "${codecStr}". Supported codecs: ${VALID_CODECS.join(", ")}.`
    );
  }
  return normalized;
}

export function validateHeight(heightStr: string): number {
  const parsed = parseInt(heightStr, 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid height "${heightStr}". Expected a positive integer (e.g. 2160, 1440, 1080, 720).`
    );
  }
  return parsed;
}

export function validateBudgetMultiplier(multiplierStr: string): number {
  const parsed = parseFloat(multiplierStr);
  if (isNaN(parsed) || !Number.isFinite(parsed) || parsed < 1.0) {
    throw new Error(
      `Invalid budget multiplier "${multiplierStr}". Expected a finite number >= 1.0 (e.g. 1.5, 2.0).`
    );
  }
  return parsed;
}

async function isJobPath(p: string): Promise<boolean> {
  try {
    const resolved = path.resolve(p);
    const stat = await fs.stat(resolved);
    if (stat.isFile() && path.basename(resolved).toLowerCase() === "job.json") {
      return true;
    }
    if (stat.isDirectory()) {
      const innerJob = path.join(resolved, "job.json");
      const innerStat = await fs.stat(innerJob);
      return innerStat.isFile();
    }
  } catch {
    return false;
  }
  return false;
}

function createCliProgressReporter(label: string) {
  return (transferred: number, total?: number) => {
    if (total && total > 0) {
      const pct = ((transferred / total) * 100).toFixed(1);
      process.stdout.write(
        `\r${label}: ${pct}% (${(transferred / 1024 / 1024).toFixed(2)} MB / ${(total / 1024 / 1024).toFixed(2)} MB)`
      );
    } else {
      process.stdout.write(
        `\r${label}: ${(transferred / 1024 / 1024).toFixed(2)} MB transferred`
      );
    }
  };
}

function handleCliLog(msg: string) {
  if (msg.startsWith("\r")) {
    process.stdout.write(msg);
  } else {
    console.log(`\n${msg}`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage:
  # Ingestion mode (Slice 1):
  javr-sourcecut <eporner-url> [root-directory] [--cookies <cookies.txt>]

  # Resume mode (Slice 3/4):
  javr-sourcecut resume <job-directory-or-job.json> [options]

  # Dedicated browser authentication:
  javr-sourcecut auth eporner [--reset]

Options:
  --resume, resume         Resume an existing waiting-for-llc Job
  --llc <path>             Explicit path to LosslessCut .llc project file
  --cookies <path>         Path to Netscape/browser cookies.txt file
  --height <number>        Explicit target resolution height (e.g. 2160, 1440, 1080, 720)
  --quality <string>       Target quality resolution (e.g. 2160p, 1440p, max)
  --codec <string>         Preferred codec (av1, h264, hevc, other)
  --budget-multiplier <n>  Transfer budget multiplier (>= 1.0, default 1.5)
  --reset                  Reset dedicated browser profile (used with auth)
  --help, -h               Show this help message

Examples:
  javr-sourcecut auth eporner
  javr-sourcecut auth eporner --reset
  javr-sourcecut resume "./downloads/eporner-5n1ArXshUMZ"
  javr-sourcecut resume "./downloads/eporner-5n1ArXshUMZ" --cookies "./cookies.txt"
  javr-sourcecut resume "./downloads/eporner-5n1ArXshUMZ" --height 1080 --codec av1
  javr-sourcecut resume "./downloads/eporner-5n1ArXshUMZ" --budget-multiplier 2.0
`);
    process.exit(0);
  }

  // Handle auth command
  if (args[0] === "auth") {
    const provider = args[1]?.startsWith("-") ? "eporner" : (args[1] || "eporner");
    const isReset = args.includes("--reset");
    try {
      if (isReset) {
        await resetAuthProfile(provider);
      } else {
        await launchAuthBrowser(provider);
      }
      process.exit(0);
    } catch (err: any) {
      console.error(`\nAuth error: ${err.message}`);
      process.exit(1);
    }
  }

  let isResume = false;
  let jobPath = "";
  let llcPath: string | undefined;
  let cookiesPath: string | undefined;
  let budgetMultiplier: number | undefined;
  let sourceUrl = "";
  let rootDir = process.cwd();
  const qualityTarget: QualityTargetOptions = {};

  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "resume" || arg === "--resume") {
        isResume = true;
        if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
          jobPath = args[++i];
        }
      } else if (arg === "--llc" && i + 1 < args.length) {
        llcPath = args[++i];
      } else if (arg === "--cookies" && i + 1 < args.length) {
        cookiesPath = args[++i];
      } else if (
        (arg === "--budget-multiplier" || arg === "--budget") &&
        i + 1 < args.length
      ) {
        budgetMultiplier = validateBudgetMultiplier(args[++i]);
      } else if (arg === "--height" && i + 1 < args.length) {
        qualityTarget.height = validateHeight(args[++i]);
      } else if (arg === "--quality" && i + 1 < args.length) {
        const q = args[++i];
        if (q !== "max") {
          qualityTarget.resolution = q;
        }
      } else if (arg === "--codec" && i + 1 < args.length) {
        qualityTarget.codec = validateCodec(args[++i]);
      } else if (arg === "--format" && i + 1 < args.length) {
        qualityTarget.formatId = args[++i];
      } else if (arg === "--url" && i + 1 < args.length) {
        sourceUrl = args[++i];
      } else if (arg === "--root" && i + 1 < args.length) {
        rootDir = args[++i];
      } else if (!sourceUrl && !jobPath) {
        if (await isJobPath(arg)) {
          isResume = true;
          jobPath = arg;
        } else {
          sourceUrl = arg;
        }
      } else if (!rootDir) {
        rootDir = arg;
      }
    }
  } catch (err: any) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }

  if (isResume || jobPath) {
    if (!jobPath) {
      console.error("Error: Missing job directory or job.json path for resume mode.");
      process.exit(1);
    }

    try {
      console.log(`Resuming Job from: ${jobPath}...`);
      const result = await resumeJobWorkflow({
        jobPathOrDir: jobPath,
        llcPath,
        cookiesPath,
        budgetMultiplier,
        qualityTarget: Object.keys(qualityTarget).length > 0 ? qualityTarget : undefined,
        onProgress: createCliProgressReporter("Selective fetch"),
        onLog: handleCliLog,
      });

      console.log("\n=======================================================");
      console.log(" Resume E2E Result Summary");
      console.log("=======================================================");
      console.log(` Job ID:                 ${result.job.jobId}`);
      console.log(` Selected Rendition:     ${result.selectedHq.formatId} (${result.selectedHq.resolution}, ${result.selectedHq.vcodec.toUpperCase()})`);
      console.log(` Cut Segments:           ${result.timeRanges.length} segment(s)`);
      for (let sIdx = 0; sIdx < result.timeRanges.length; sIdx++) {
        const seg = result.timeRanges[sIdx];
        console.log(`   Segment ${sIdx + 1}:             ${seg.startSeconds.toFixed(3)}s -> ${seg.endSeconds.toFixed(3)}s (${(seg.endSeconds - seg.startSeconds).toFixed(3)}s)`);
      }
      console.log(` Output File:            ${result.outputClipPath}`);
      console.log(` Full File Size:         ${(result.selectiveFetchResult.fullFileBytes / 1024 / 1024).toFixed(2)} MB`);
      console.log(` Selective Fetch Stage:  ${(result.selectiveFetchBytes / 1024 / 1024).toFixed(2)} MB (${result.selectiveFetchSavingsPercent}% savings)`);
      console.log(` Total Lifecycle Bytes:  ${(result.totalHqLifecycleBytes / 1024 / 1024).toFixed(2)} MB (${result.lifecycleSavingsPercent}% savings)`);
      console.log("=======================================================\n");
    } catch (err: any) {
      console.error(`\nResume workflow failed: ${err.message || String(err)}`);
      process.exit(1);
    }

  } else {
    if (!sourceUrl) {
      console.error("Error: Missing video URL argument.");
      process.exit(1);
    }

    const resolvedRoot = path.resolve(rootDir);

    try {
      await runTracerSlice({
        sourceUrl,
        rootDir: resolvedRoot,
        cookiesPath,
        onProgress: createCliProgressReporter("Downloading proxy"),
        onLog: handleCliLog,
      });

      console.log("\n");
    } catch (err: any) {
      console.error(`\nWorkflow failed: ${err.message || String(err)}`);
      process.exit(1);
    }
  }
}

// Only execute main if run directly as CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.ts")) {
  main();
}
