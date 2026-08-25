import type { MP4Index } from "./types.js";
import { Http206RequiredError, UnprovablePartialPlanError } from "./types.js";
import { parseMP4Buffer } from "./box-parser.js";

export interface IndexProbeOptions {
  fetchFn?: typeof fetch;
  headProbeBytes?: number;
  tailProbeBytes?: number;
  headers?: Record<string, string>;
}

export async function probeMP4Index(
  url: string,
  options: IndexProbeOptions = {}
): Promise<MP4Index> {
  const fetchFn = options.fetchFn || fetch;
  const headProbeBytes = options.headProbeBytes ?? 512 * 1024;
  const tailProbeBytes = options.tailProbeBytes ?? 2 * 1024 * 1024;

  // 1. Bounded Head Probe (0..headProbeBytes-1)
  const headRes = await fetchFn(url, {
    headers: {
      Range: `bytes=0-${headProbeBytes - 1}`,
      ...options.headers,
    },
  });

  if (headRes.status === 200) {
    throw new Http206RequiredError(
      `Server returned HTTP 200 OK instead of 206 Partial Content for range probe on ${url}. Byte-range requests are unsupported or ignored.`
    );
  }

  if (headRes.status !== 206) {
    throw new Http206RequiredError(
      `Range probe failed with HTTP ${headRes.status} ${headRes.statusText} for ${url}`
    );
  }

  const contentRange = headRes.headers.get("content-range");
  if (!contentRange) {
    throw new Http206RequiredError(
      `Missing Content-Range response header from server for range probe on ${url}`
    );
  }

  const crMatch = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
  if (!crMatch || crMatch[3] === "*") {
    throw new Http206RequiredError(
      `Invalid or incomplete Content-Range header: "${contentRange}" on ${url}`
    );
  }

  const fileSize = parseInt(crMatch[3], 10);
  const headArrayBuffer = await headRes.arrayBuffer();
  const headBuffer = Buffer.from(headArrayBuffer);

  // Try parsing from head probe buffer
  try {
    const index = parseMP4Buffer(headBuffer, fileSize, 0);
    return index;
  } catch (err: any) {
    if (!(err instanceof UnprovablePartialPlanError)) {
      throw err;
    }
  }

  // 2. Bounded Tail Probe
  const tailStart = Math.max(0, fileSize - tailProbeBytes);
  const tailEnd = fileSize - 1;

  if (tailStart >= fileSize) {
    throw new UnprovablePartialPlanError(
      `Invalid tail probe range: start ${tailStart} >= fileSize ${fileSize}`
    );
  }

  const tailRes = await fetchFn(url, {
    headers: {
      Range: `bytes=${tailStart}-${tailEnd}`,
      ...options.headers,
    },
  });

  if (tailRes.status === 200) {
    throw new Http206RequiredError(
      `Server returned HTTP 200 OK instead of 206 Partial Content during tail probe on ${url}`
    );
  }

  if (tailRes.status !== 206) {
    throw new Http206RequiredError(
      `Tail probe failed with HTTP ${tailRes.status} ${tailRes.statusText} for ${url}`
    );
  }

  const tailContentRange = tailRes.headers.get("content-range");
  if (!tailContentRange) {
    throw new Http206RequiredError(
      `Missing Content-Range header on tail probe response from ${url}`
    );
  }

  const tailArrayBuffer = await tailRes.arrayBuffer();
  const tailBuffer = Buffer.from(tailArrayBuffer);

  try {
    const index = parseMP4Buffer(tailBuffer, fileSize, tailStart);
    return index;
  } catch (err: any) {
    throw new UnprovablePartialPlanError(
      `Could not locate complete moov atom within bounded head (${headProbeBytes}B) or tail (${tailProbeBytes}B) probes for ${url}. Refusing unbounded full-file download.`
    );
  }
}
