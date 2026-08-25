#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { runTracerSlice, resumeJobWorkflow } from "./core/workflow.js";

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
  javr-sourcecut <eporner-url> [root-directory]

  # Resume mode (Slice 3):
  javr-sourcecut resume <job-directory-or-job.json> [--llc <losslesscut-file>]

Options:
  --resume, resume  Resume an existing waiting-for-llc Job
  --llc <path>      Explicit path to LosslessCut .llc project file
  --help, -h        Show this help message

Examples:
  javr-sourcecut "https://www.eporner.com/video-5n1ArXshUMZ/sample-video/" "./downloads"
  javr-sourcecut resume "./downloads/eporner-5n1ArXshUMZ"
`);
    process.exit(0);
  }

  let isResume = false;
  let jobPath = "";
  let llcPath: string | undefined;
  let sourceUrl = "";
  let rootDir = process.cwd();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "resume" || arg === "--resume") {
      isResume = true;
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        jobPath = args[++i];
      }
    } else if (arg === "--llc" && i + 1 < args.length) {
      llcPath = args[++i];
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
        onProgress: createCliProgressReporter("Selective fetch"),
        onLog: handleCliLog,
      });

      console.log("\n=======================================================");
      console.log(" Resume E2E Result Summary");
      console.log("=======================================================");
      console.log(` Job ID:              ${result.job.jobId}`);
      console.log(` Selected Rendition:  ${result.selectedHq.formatId} (${result.selectedHq.resolution}, ${result.selectedHq.vcodec.toUpperCase()})`);
      console.log(` Cut Segment:         ${result.timeRange.startSeconds.toFixed(3)}s -> ${result.timeRange.endSeconds.toFixed(3)}s`);
      console.log(` Output File:         ${result.outputClipPath}`);
      console.log(` Full File Size:      ${(result.selectiveFetchResult.fullFileBytes / 1024 / 1024).toFixed(2)} MB`);
      console.log(` Network Transferred: ${(result.selectiveFetchResult.transferredBytes / 1024 / 1024).toFixed(2)} MB`);
      console.log(` Bandwidth Savings:   ${result.selectiveFetchResult.savingsPercent}%`);
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

main();
