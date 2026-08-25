#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { runTracerSlice } from "./core/workflow.js";

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage:
  javr-sourcecut <eporner-url> [root-directory]

Options:
  --help, -h       Show this help message

Example:
  javr-sourcecut "https://www.eporner.com/video-5n1ArXshUMZ/sample-video/" "./downloads"
`);
    process.exit(0);
  }

  let sourceUrl = "";
  let rootDir = process.cwd();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--url" && i + 1 < args.length) {
      sourceUrl = args[++i];
    } else if (arg === "--root" && i + 1 < args.length) {
      rootDir = args[++i];
    } else if (!sourceUrl) {
      sourceUrl = arg;
    } else {
      rootDir = arg;
    }
  }

  if (!sourceUrl) {
    console.error("Error: Missing video URL argument.");
    process.exit(1);
  }

  const resolvedRoot = path.resolve(rootDir);

  try {
    const result = await runTracerSlice({
      sourceUrl,
      rootDir: resolvedRoot,
      onProgress: (transferred, total) => {
        if (total) {
          const pct = ((transferred / total) * 100).toFixed(1);
          process.stdout.write(`\rDownloading proxy: ${pct}% (${(transferred / 1024 / 1024).toFixed(1)} MB / ${(total / 1024 / 1024).toFixed(1)} MB)`);
        } else {
          process.stdout.write(`\rDownloading proxy: ${(transferred / 1024 / 1024).toFixed(1)} MB transferred`);
        }
      },
      onLog: (msg) => {
        if (msg.startsWith("\r")) {
          process.stdout.write(msg);
        } else {
          console.log(`\n${msg}`);
        }
      },
    });

    console.log("\n");
  } catch (err: any) {
    console.error(`\nWorkflow failed: ${err.message || String(err)}`);
    process.exit(1);
  }
}

main();
