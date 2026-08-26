import type { MP4Index, MP4IndexProbeResult } from "./types.js";
import {
  Http206RequiredError,
  RenditionVersionMismatchError,
  UnprovablePartialPlanError,
} from "./types.js";
import { parseMP4Buffer } from "./box-parser.js";
import { isStrongEtag, type TransferLedgerManager } from "./ledger.js";
import type { TransferBudgetTracker } from "./budget.js";

export interface IndexProbeOptions {
  fetchFn?: typeof fetch;
  headProbeBytes?: number;
  tailProbeBytes?: number;
  headers?: Record<string, string>;
  budgetTracker?: TransferBudgetTracker;
  ledgerManager?: TransferLedgerManager;
}

function cancelResponseBody(response: Response) {
  try {
    if (response.body) {
      const reader = response.body.getReader();
      reader.cancel().catch(() => {});
    }
  } catch {}
}

async function readResponseBodyStream(
  response: Response,
  options?: {
    budgetTracker?: TransferBudgetTracker;
    ledgerManager?: TransferLedgerManager;
  }
): Promise<Buffer> {
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        chunks.push(value);
        options?.budgetTracker?.recordBytes(value.length);
        if (options?.ledgerManager) {
          await options.ledgerManager.recordNetworkSpend(value.length);
        }
      }
    }
    return Buffer.concat(chunks);
  } catch (err) {
    // If stream errors/truncates/aborts, all received chunks have already been
    // recorded into budgetTracker and persisted into ledgerManager.cumulativeHistoricalSpentBytes.
    throw err;
  }
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
  // Prospective budget check before capability probe
  options.budgetTracker?.checkProspectiveBudget(1);

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

  const capEtag = capRes.headers.get("etag") || undefined;

  // Stream-read capability probe body and record bytes incrementally
  const capBuffer = await readResponseBodyStream(capRes, {
    budgetTracker: options.budgetTracker,
    ledgerManager: options.ledgerManager,
  });

  if (capBuffer.length !== 1) {
    throw new Http206RequiredError(
      `Capability probe body length mismatch: expected 1 byte, received ${capBuffer.length} bytes`
    );
  }

  const capabilityProbeBytesTransferred = capBuffer.length;

  if (options.ledgerManager) {
    await options.ledgerManager.updateAuthoritativeFileSize(fileSize);
    if (capEtag) {
      await options.ledgerManager.updateRenditionEtag(capEtag);
    }
  }

  // =========================================================================
  // Stage B: Bounded Head Probe
  // Calculate head probe boundary strictly < fileSize (never download full file)
  // =========================================================================
  const headBudget = Math.min(configuredHeadProbeBytes, Math.floor(fileSize * 0.5));
  const headEnd = Math.max(0, headBudget - 1);
  const expectedHeadLength = headEnd + 1;

  if (headEnd >= fileSize - 1 || headBudget < 8) {
    throw new UnprovablePartialPlanError(
      `File size (${fileSize}B) is too small to execute a bounded partial head probe without requesting the full file. Refusing full-file probe.`
    );
  }

  // Prospective budget check before head probe
  options.budgetTracker?.checkProspectiveBudget(expectedHeadLength);

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
      `Head probe returned conflicting total file size: ${returnedHeadTotal} vs capability probe ${fileSize} on ${url}`
    );
  }

  if (returnedHeadStart !== 0 || returnedHeadEnd !== headEnd) {
    cancelResponseBody(headRes);
    throw new Http206RequiredError(
      `Server returned mismatched head probe byte range: expected 0-${headEnd}, got ${returnedHeadStart}-${returnedHeadEnd}`
    );
  }

  const headEtag = headRes.headers.get("etag") || undefined;

  // Source-version strong ETag consistency: capability vs head
  if (isStrongEtag(capEtag) && isStrongEtag(headEtag) && capEtag !== headEtag) {
    cancelResponseBody(headRes);
    throw new RenditionVersionMismatchError(
      `Head probe returned conflicting strong ETag: "${headEtag}" vs capability probe strong ETag "${capEtag}" on ${url}`
    );
  }

  // Stream-read head probe body and record bytes incrementally
  const headBuffer = await readResponseBodyStream(headRes, {
    budgetTracker: options.budgetTracker,
    ledgerManager: options.ledgerManager,
  });

  if (headBuffer.length !== expectedHeadLength) {
    throw new Http206RequiredError(
      `Head probe response body length mismatch: expected ${expectedHeadLength} bytes, received ${headBuffer.length} bytes`
    );
  }

  const headProbeBytesTransferred = headBuffer.length;

  const establishedEtag =
    (isStrongEtag(capEtag) ? capEtag : undefined) ||
    (isStrongEtag(headEtag) ? headEtag : undefined) ||
    headEtag ||
    capEtag;

  if (options.ledgerManager && establishedEtag) {
    await options.ledgerManager.updateRenditionEtag(establishedEtag);
  }

  // Try parsing from head probe buffer
  try {
    const index = parseMP4Buffer(headBuffer, fileSize, 0);
    return {
      index,
      capabilityProbeBytesTransferred,
      headProbeBytesTransferred,
      tailProbeBytesTransferred: 0,
      totalProbeBytesTransferred: capabilityProbeBytesTransferred + headProbeBytesTransferred,
      etag: establishedEtag,
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
  const expectedTailBodyLength = tailEnd - tailStart + 1;

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

  // Prospective budget check before tail probe
  options.budgetTracker?.checkProspectiveBudget(expectedTailBodyLength);

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
      `Tail probe returned conflicting total file size: ${returnedTailTotal} vs initial ${fileSize} on ${url}`
    );
  }

  if (returnedTailStart !== tailStart || returnedTailEnd !== tailEnd) {
    cancelResponseBody(tailRes);
    throw new Http206RequiredError(
      `Server returned mismatched tail probe byte range: expected ${tailStart}-${tailEnd}, got ${returnedTailStart}-${returnedTailEnd}`
    );
  }

  const tailEtag = tailRes.headers.get("etag") || undefined;

  // Source-version strong ETag consistency: established probe strong ETag vs tail
  const priorStrongEtag =
    (isStrongEtag(capEtag) ? capEtag : undefined) ||
    (isStrongEtag(headEtag) ? headEtag : undefined);

  if (priorStrongEtag && isStrongEtag(tailEtag) && tailEtag !== priorStrongEtag) {
    cancelResponseBody(tailRes);
    throw new RenditionVersionMismatchError(
      `Tail probe returned conflicting strong ETag: "${tailEtag}" vs established probe strong ETag "${priorStrongEtag}" on ${url}`
    );
  }

  // Stream-read tail probe body and record bytes incrementally
  const tailBuffer = await readResponseBodyStream(tailRes, {
    budgetTracker: options.budgetTracker,
    ledgerManager: options.ledgerManager,
  });

  if (tailBuffer.length !== expectedTailBodyLength) {
    throw new Http206RequiredError(
      `Tail probe response body length mismatch: expected ${expectedTailBodyLength} bytes, received ${tailBuffer.length} bytes`
    );
  }

  const tailProbeBytesTransferred = tailBuffer.length;

  const finalEffectiveEtag =
    priorStrongEtag ||
    (isStrongEtag(tailEtag) ? tailEtag : undefined) ||
    tailEtag ||
    establishedEtag;

  if (options.ledgerManager && finalEffectiveEtag) {
    await options.ledgerManager.updateRenditionEtag(finalEffectiveEtag);
  }

  try {
    const index = parseMP4Buffer(tailBuffer, fileSize, tailStart);
    return {
      index,
      capabilityProbeBytesTransferred,
      headProbeBytesTransferred,
      tailProbeBytesTransferred,
      totalProbeBytesTransferred:
        capabilityProbeBytesTransferred + headProbeBytesTransferred + tailProbeBytesTransferred,
      etag: finalEffectiveEtag,
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


