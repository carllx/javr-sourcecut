import type { MP4Index, MP4IndexProbeResult } from "./types.js";
import {
  Http206RequiredError,
  RenditionVersionMismatchError,
  UnprovablePartialPlanError,
} from "./types.js";
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
  const configuredHeadProbeBytes = options.headProbeBytes ?? 512 * 1024;
  const configuredTailProbeBytes = options.tailProbeBytes ?? 2 * 1024 * 1024;

  // =========================================================================
  // Stage A: 1-Byte Capability & File Size Probe (Range: bytes=0-0)
  // =========================================================================
  const capRes = await fetchFn(url, {
    headers: {
      Range: "bytes=0-0",
      ...options.headers,
    },
  });

  if (capRes.status === 200) {
    cancelResponseBody(capRes);
    throw new Http206RequiredError(
      `Server returned HTTP 200 OK instead of 206 Partial Content for capability probe on ${url}. Byte-range requests are unsupported or ignored.`
    );
  }

  if (capRes.status !== 206) {
    cancelResponseBody(capRes);
    throw new Http206RequiredError(
      `Capability probe failed with HTTP ${capRes.status} ${capRes.statusText} for ${url}`
    );
  }

  const capContentRange = capRes.headers.get("content-range");
  if (!capContentRange) {
    cancelResponseBody(capRes);
    throw new Http206RequiredError(
      `Missing Content-Range header on capability probe response from ${url}`
    );
  }

  const capMatch = capContentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!capMatch) {
    cancelResponseBody(capRes);
    throw new Http206RequiredError(
      `Malformed Content-Range header: "${capContentRange}" on ${url}`
    );
  }

  if (capMatch[3] === "*") {
    cancelResponseBody(capRes);
    throw new Http206RequiredError(
      `Content-Range total file size cannot be wildcard (*) on ${url}`
    );
  }

  const fileSize = parseInt(capMatch[3], 10);
  const capStart = parseInt(capMatch[1], 10);
  const capEnd = parseInt(capMatch[2], 10);

  if (isNaN(fileSize) || fileSize <= 0) {
    cancelResponseBody(capRes);
    throw new Http206RequiredError(
      `Invalid total file size "${capMatch[3]}" in Content-Range on ${url}`
    );
  }

  if (capStart !== 0 || capEnd !== 0) {
    cancelResponseBody(capRes);
    throw new Http206RequiredError(
      `Server returned mismatched capability range: expected 0-0, got ${capStart}-${capEnd}`
    );
  }

  const capArrayBuffer = await capRes.arrayBuffer();
  const capBuffer = Buffer.from(capArrayBuffer);
  if (capBuffer.length !== 1) {
    throw new Http206RequiredError(
      `Capability probe body length mismatch: expected 1 byte, received ${capBuffer.length} bytes`
    );
  }

  const capabilityProbeBytesTransferred = capBuffer.length;

  // =========================================================================
  // Stage B: Bounded Head Probe
  // Calculate head probe boundary strictly < fileSize (never download full file)
  // =========================================================================
  const headBudget = Math.min(configuredHeadProbeBytes, Math.floor(fileSize * 0.5));
  const headEnd = Math.max(0, headBudget - 1);

  if (headEnd >= fileSize - 1 || headBudget < 8) {
    throw new UnprovablePartialPlanError(
      `File size (${fileSize}B) is too small to execute a bounded partial head probe without requesting the full file. Refusing full-file probe.`
    );
  }

  const headRes = await fetchFn(url, {
    headers: {
      Range: `bytes=0-${headEnd}`,
      ...options.headers,
    },
  });

  if (headRes.status === 200) {
    cancelResponseBody(headRes);
    throw new Http206RequiredError(
      `Server returned HTTP 200 OK instead of 206 Partial Content for head probe on ${url}`
    );
  }

  if (headRes.status !== 206) {
    cancelResponseBody(headRes);
    throw new Http206RequiredError(
      `Head probe failed with HTTP ${headRes.status} ${headRes.statusText} for ${url}`
    );
  }

  const headContentRange = headRes.headers.get("content-range");
  if (!headContentRange) {
    cancelResponseBody(headRes);
    throw new Http206RequiredError(
      `Missing Content-Range header on head probe response from ${url}`
    );
  }

  const headMatch = headContentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!headMatch || headMatch[3] === "*") {
    cancelResponseBody(headRes);
    throw new Http206RequiredError(
      `Invalid or wildcard Content-Range on head probe: "${headContentRange}" on ${url}`
    );
  }

  const returnedHeadStart = parseInt(headMatch[1], 10);
  const returnedHeadEnd = parseInt(headMatch[2], 10);
  const returnedHeadTotal = parseInt(headMatch[3], 10);

  if (returnedHeadTotal !== fileSize) {
    cancelResponseBody(headRes);
    throw new RenditionVersionMismatchError(
      `Head probe returned conflicting total file size: ${returnedHeadTotal} vs initial ${fileSize}`
    );
  }


  if (returnedHeadStart !== 0 || returnedHeadEnd !== headEnd) {
    cancelResponseBody(headRes);
    throw new Http206RequiredError(
      `Server returned mismatched head probe byte range: expected 0-${headEnd}, got ${returnedHeadStart}-${returnedHeadEnd}`
    );
  }

  const headArrayBuffer = await headRes.arrayBuffer();
  const headBuffer = Buffer.from(headArrayBuffer);
  const expectedHeadLength = headEnd + 1;

  if (headBuffer.length !== expectedHeadLength) {
    throw new Http206RequiredError(
      `Head probe response body length mismatch: expected ${expectedHeadLength} bytes, received ${headBuffer.length} bytes`
    );
  }

  const headProbeBytesTransferred = headBuffer.length;
  const observedEtag = headRes.headers.get("etag") || undefined;

  // Try parsing from head probe buffer
  try {
    const index = parseMP4Buffer(headBuffer, fileSize, 0);
    return {
      index,
      capabilityProbeBytesTransferred,
      headProbeBytesTransferred,
      tailProbeBytesTransferred: 0,
      totalProbeBytesTransferred: capabilityProbeBytesTransferred + headProbeBytesTransferred,
      etag: observedEtag,
      cachedHead: {
        buffer: headBuffer,
        range: { startByte: 0, endByte: headEnd },
      },
    };
  } catch (err: any) {
    if (!(err instanceof UnprovablePartialPlanError)) {
      throw err;
    }
  }


  // =========================================================================
  // Stage C: Bounded Tail Probe (if moov not in head)
  // Ensure tail probe does not overlap head probe and aggregate probes stay strictly within partial budget
  // =========================================================================
  const tailBudget = Math.min(configuredTailProbeBytes, Math.floor(fileSize * 0.5));
  const tailStart = fileSize - tailBudget;
  const tailEnd = fileSize - 1;

  const prospectiveProbeBytes =
    capabilityProbeBytesTransferred + headProbeBytesTransferred + tailBudget;
  const prospectiveProbeRatio = prospectiveProbeBytes / fileSize;

  if (
    tailStart <= headEnd ||
    tailStart <= 0 ||
    prospectiveProbeBytes >= fileSize ||
    prospectiveProbeRatio > 0.95 ||
    (1 - prospectiveProbeRatio) <= 0.05
  ) {
    throw new UnprovablePartialPlanError(
      `Cannot execute bounded tail probe for ${url}: aggregate prospective probe transfer (${prospectiveProbeBytes}B) would consume ${(prospectiveProbeRatio * 100).toFixed(1)}% of total file size (${fileSize}B), violating the no-full-file probe invariant and partial budget threshold. Refusing full-file probe.`
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
  if (!tailCrMatch || tailCrMatch[3] === "*") {
    cancelResponseBody(tailRes);
    throw new Http206RequiredError(
      `Malformed or wildcard Content-Range on tail probe: "${tailContentRange}" from ${url}`
    );
  }

  const returnedTailStart = parseInt(tailCrMatch[1], 10);
  const returnedTailEnd = parseInt(tailCrMatch[2], 10);
  const returnedTailTotal = parseInt(tailCrMatch[3], 10);

  if (returnedTailTotal !== fileSize) {
    cancelResponseBody(tailRes);
    throw new RenditionVersionMismatchError(
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
      capabilityProbeBytesTransferred,
      headProbeBytesTransferred,
      tailProbeBytesTransferred,
      totalProbeBytesTransferred:
        capabilityProbeBytesTransferred + headProbeBytesTransferred + tailProbeBytesTransferred,
      etag: tailRes.headers.get("etag") || observedEtag,
      cachedHead: {
        buffer: headBuffer,
        range: { startByte: 0, endByte: headEnd },
      },
      cachedTail: {
        buffer: tailBuffer,
        range: { startByte: tailStart, endByte: tailEnd },
      },
    };
  } catch (err: any) {

    throw new UnprovablePartialPlanError(
      `Could not locate complete moov atom within bounded head (${headBudget}B) or tail (${tailBudget}B) probes for ${url}. Refusing unbounded full-file download.`
    );
  }
}
