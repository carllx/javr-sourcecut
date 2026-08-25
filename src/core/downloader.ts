import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface DownloadOptions {
  onProgress?: (transferredBytes: number, totalBytes?: number) => void;
  fetchFn?: typeof fetch;
  headers?: Record<string, string>;
}

export interface DownloadResult {
  destinationPath: string;
  bytesDownloaded: number;
  contentType?: string;
}

export async function downloadFile(
  url: string,
  destinationPath: string,
  options: DownloadOptions = {}
): Promise<DownloadResult> {
  const fetchFn = options.fetchFn || fetch;
  const partPath = `${destinationPath}.part`;

  // Ensure parent directory exists
  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });

  let response: Response;
  try {
    response = await fetchFn(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        ...options.headers,
      },
    });
  } catch (err: any) {
    throw new Error(`Download request failed for ${url}: ${err.message || String(err)}`);
  }

  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status} ${response.statusText} for ${url}`);
  }

  if (!response.body) {
    throw new Error(`Response body is empty for ${url}`);
  }

  const contentLengthHeader = response.headers.get("content-length");
  const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : undefined;
  const contentType = response.headers.get("content-type") || undefined;

  let transferredBytes = 0;
  const writeStream = fs.createWriteStream(partPath);

  try {
    const nodeReadable = Readable.fromWeb(response.body as any);

    nodeReadable.on("data", (chunk: Buffer) => {
      transferredBytes += chunk.length;
      if (options.onProgress) {
        options.onProgress(transferredBytes, totalBytes);
      }
    });

    await pipeline(nodeReadable, writeStream);

    // Atomically move .part to final destination
    await fsp.rename(partPath, destinationPath);

    return {
      destinationPath,
      bytesDownloaded: transferredBytes,
      contentType,
    };
  } catch (err: any) {
    writeStream.destroy();
    // Clean up partial file
    await fsp.rm(partPath, { force: true }).catch(() => {});
    throw err;
  }
}
