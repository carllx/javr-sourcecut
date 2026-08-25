import type { MP4Index, MP4IndexProbeResult } from "./types.js";
import { Http206RequiredError, UnprovablePartialPlanError } from "./types.js";
import { parseMP4Buffer } from "./box-parser.js";

export interface IndexProbeOptions {
  fetchFn?: typeof fetch;
  headProbeBytes?: number;
  tailProbeBytes?: number;
  headers?: Record<string, string>;
}

function cancelResponseBody(response: Response) {
  try {
    if (response.body) {
      const reader = response.body.getReader();
      reader.cancel().catch(() => {});
    }
  } catch {}
}

export async function probeMP4Index(
  url: string,
  options: IndexProbeOptions = {}
): Promise<MP4IndexProbeResult> {
  const fetchFn = options.fetchFn || fetch;
  const headProbeBytes = options.headProbeBytes ?? 512 * 1024;
  const tailProbeBytes = options.tailProbeBytes ?? 2 * 1024 * 1024;

  // 1. Bounded Head Probe (0..headProbeBytes-1)
  const requestedHeadStart = 0;
  const requestedHeadEnd = headProbeBytes - 1;

  const headRes = await fetchFn(url, {
    headers: {
      Range: `bytes=${requestedHeadStart}-${requestedHeadEnd}`,
      ...options.headers,
    },
  });

  if (headRes.status === 200) {
    cancelResponseBody(headRes);
    throw new Http206RequiredError(
      `Server returned HTTP 200 OK instead of 206 Partial Content for range probe on ${url}. Byte-range requests are unsupported or ignored.`
    );
  }

  if (headRes.status !== 206) {
    cancelResponseBody(headRes);
    throw new Http206RequiredError(
      `Range probe failed with HTTP ${headRes.status} ${headRes.statusText} for ${url}`
    );
  }

  const contentRange = headRes.headers.get("content-range");
  if (!contentRange) {
    cancelResponseBody(headRes);
    throw new Http206RequiredError(
      `Missing Content-Range response header from server for range probe on ${url}`
    );
  }

  const crMatch = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!crMatch) {
    cancelResponseBody(headRes);
    throw new Http206RequiredError(
      `Malformed Content-Range header: "${contentRange}" on ${url}`
    );
  }

  if (crMatch[3] === "*") {
    cancelResponseBody(headRes);
    throw new Http206RequiredError(
      `Content-Range total file size cannot be wildcard (*) on ${url}`
    );
  }

  const fileSize = parseInt(crMatch[3], 10);
  const returnedHeadStart = parseInt(crMatch[1], 10);
  const returnedHeadEnd = parseInt(crMatch[2], 10);

  if (isNaN(fileSize) || fileSize <= 0) {
    cancelResponseBody(headRes);
    throw new Http206RequiredError(
      `Invalid total file size "${crMatch[3]}" in Content-Range on ${url}`
    );
  }

  const expectedHeadEnd = Math.min(requestedHeadEnd, fileSize - 1);
  if (returnedHeadStart !== requestedHeadStart) {
    cancelResponseBody(headRes);
    throw new Http206RequiredError(
      `Server returned mismatched head probe start byte: expected ${requestedHeadStart}, got ${returnedHeadStart}`
    );
  }

  if (returnedHeadEnd !== expectedHeadEnd) {
    cancelResponseBody(headRes);
    throw new Http206RequiredError(
      `Server returned mismatched head probe end byte: expected ${expectedHeadEnd}, got ${returnedHeadEnd}`
    );
  }

  const headArrayBuffer = await headRes.arrayBuffer();
  const headBuffer = Buffer.from(headArrayBuffer);
  const expectedHeadBodyLength = returnedHeadEnd - returnedHeadStart + 1;

  if (headBuffer.length !== expectedHeadBodyLength) {
    throw new Http206RequiredError(
      `Head probe response body length mismatch: expected ${expectedHeadBodyLength} bytes, received ${headBuffer.length} bytes`
    );
  }

  const headProbeBytesTransferred = headBuffer.length;

  // Try parsing from head probe buffer
  try {
    const index = parseMP4Buffer(headBuffer, fileSize, 0);
    return {
      index,
      headProbeBytesTransferred,
      tailProbeBytesTransferred: 0,
      totalProbeBytesTransferred: headProbeBytesTransferred,
      cachedHeadBuffer: headBuffer,
    };
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
    cancelResponseBody(tailRes);
    throw new Http206RequiredError(
      `Server returned HTTP 200 OK instead of 206 Partial Content during tail probe on ${url}`
    );
  }

  if (tailRes.status !== 206) {
    cancelResponseBody(tailRes);
    throw new Http206RequiredError(
      `Tail probe failed with HTTP ${tailRes.status} ${tailRes.statusText} for ${url}`
    );
  }

  const tailContentRange = tailRes.headers.get("content-range");
  if (!tailContentRange) {
    cancelResponseBody(tailRes);
    throw new Http206RequiredError(
      `Missing Content-Range header on tail probe response from ${url}`
    );
  }

  const tailCrMatch = tailContentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!tailCrMatch) {
    cancelResponseBody(tailRes);
    throw new Http206RequiredError(
      `Malformed Content-Range header on tail probe: "${tailContentRange}" from ${url}`
    );
  }

  if (tailCrMatch[3] === "*") {
    cancelResponseBody(tailRes);
    throw new Http206RequiredError(
      `Tail Content-Range total size cannot be wildcard (*) on ${url}`
    );
  }

  const returnedTailStart = parseInt(tailCrMatch[1], 10);
  const returnedTailEnd = parseInt(tailCrMatch[2], 10);
  const returnedTailTotal = parseInt(tailCrMatch[3], 10);

  if (returnedTailTotal !== fileSize) {
    cancelResponseBody(tailRes);
    throw new Http206RequiredError(
      `Tail probe returned conflicting total file size: ${returnedTailTotal} vs initial ${fileSize}`
    );
  }

  if (returnedTailStart !== tailStart || returnedTailEnd !== tailEnd) {
    cancelResponseBody(tailRes);
    throw new Http206RequiredError(
      `Server returned mismatched tail probe byte range: expected ${tailStart}-${tailEnd}, got ${returnedTailStart}-${returnedTailEnd}`
    );
  }

  const tailArrayBuffer = await tailRes.arrayBuffer();
  const tailBuffer = Buffer.from(tailArrayBuffer);
  const expectedTailBodyLength = tailEnd - tailStart + 1;

  if (tailBuffer.length !== expectedTailBodyLength) {
    throw new Http206RequiredError(
      `Tail probe response body length mismatch: expected ${expectedTailBodyLength} bytes, received ${tailBuffer.length} bytes`
    );
  }

  const tailProbeBytesTransferred = tailBuffer.length;

  try {
    const index = parseMP4Buffer(tailBuffer, fileSize, tailStart);
    return {
      index,
      headProbeBytesTransferred,
      tailProbeBytesTransferred,
      totalProbeBytesTransferred: headProbeBytesTransferred + tailProbeBytesTransferred,
      cachedHeadBuffer: headBuffer,
      cachedTailBuffer: tailBuffer,
    };
  } catch (err: any) {
    throw new UnprovablePartialPlanError(
      `Could not locate complete moov atom within bounded head (${headProbeBytes}B) or tail (${tailProbeBytes}B) probes for ${url}. Refusing unbounded full-file download.`
    );
  }
}
