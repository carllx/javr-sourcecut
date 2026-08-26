import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type {
  ByteRange,
  LedgerChunkEntry,
  LedgerRenditionIdentity,
  TransferLedger,
} from "./types.js";

export function isStrongEtag(etag?: string): boolean {
  if (!etag || typeof etag !== "string") return false;
  const trimmed = etag.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.toLowerCase().startsWith("w/")) return false;
  return true;
}

export function computeLogicalRenditionId(rendition: LedgerRenditionIdentity): string {
  return `${rendition.provider}:${rendition.providerAssetId}:${rendition.formatId}:${rendition.fullFileBytes}`;
}

export async function computeFileSha256(filePath: string): Promise<string> {
  const fileBuffer = await fsp.readFile(filePath);
  return crypto.createHash("sha256").update(fileBuffer).digest("hex");
}

export interface TransferLedgerManagerOptions {
  workspaceDir: string;
  rendition: LedgerRenditionIdentity;
}

export class TransferLedgerManager {
  readonly workspaceDir: string;
  readonly rendition: LedgerRenditionIdentity;
  readonly logicalRenditionId: string;
  readonly ledgerPath: string;
  readonly chunksDir: string;
  private _ledger: TransferLedger | null = null;

  constructor(options: TransferLedgerManagerOptions) {
    this.workspaceDir = path.resolve(options.workspaceDir);
    this.rendition = options.rendition;
    this.logicalRenditionId = computeLogicalRenditionId(options.rendition);
    this.ledgerPath = path.join(this.workspaceDir, "transfer-ledger.json");
    this.chunksDir = path.join(this.workspaceDir, "chunks");
  }

  get ledger(): TransferLedger {
    if (!this._ledger) {
      throw new Error("Ledger has not been initialized. Call loadOrCreateLedger() first.");
    }
    return this._ledger;
  }

  get cumulativeFailedBytes(): number {
    return this._ledger?.cumulativeFailedBytes || 0;
  }

  get cumulativeHistoricalSpentBytes(): number {
    return this._ledger?.cumulativeHistoricalSpentBytes || 0;
  }

  /**
   * Cumulative historical network bytes across all successful, failed, and probe attempts for this logical transfer.
   * Monotonically persists across restarts and cache invalidations.
   */
  get cumulativeHistoricalNetworkBytes(): number {
    if (!this._ledger) return 0;
    if (typeof this._ledger.cumulativeHistoricalSpentBytes === "number") {
      return this._ledger.cumulativeHistoricalSpentBytes;
    }
    const completedTxBytes = this._ledger.transactions.reduce(
      (sum, tx) => sum + (tx.transferredNetworkBytes || 0),
      0
    );
    return completedTxBytes + (this._ledger.cumulativeFailedBytes || 0);
  }

  /**
   * Monotonically records network bytes spent (e.g. probes or chunk downloads) for this logical transfer.
   */
  async recordNetworkSpend(bytes: number): Promise<void> {
    if (bytes <= 0) return;
    if (!this._ledger) {
      await this.loadOrCreateLedger();
    }
    this.ledger.cumulativeHistoricalSpentBytes =
      (this.ledger.cumulativeHistoricalSpentBytes || 0) + bytes;
    await this.saveLedger();
  }

  async loadOrCreateLedger(): Promise<TransferLedger> {
    await fsp.mkdir(this.workspaceDir, { recursive: true });
    await fsp.mkdir(this.chunksDir, { recursive: true });

    let existingLedger: TransferLedger | null = null;

    try {
      const raw = await fsp.readFile(this.ledgerPath, "utf-8");
      existingLedger = JSON.parse(raw) as TransferLedger;
    } catch {
      // File does not exist or is invalid JSON
    }

    const preservedHistoricalSpentBytes =
      existingLedger?.cumulativeHistoricalSpentBytes ??
      ((existingLedger?.transactions || []).reduce(
        (sum, tx) => sum + (tx.transferredNetworkBytes || 0),
        0
      ) + (existingLedger?.cumulativeFailedBytes || 0));
    const preservedFailedBytes = existingLedger?.cumulativeFailedBytes || 0;

    if (existingLedger && existingLedger.logicalRenditionId === this.logicalRenditionId) {
      this._ledger = existingLedger;
      this._ledger.cumulativeHistoricalSpentBytes = preservedHistoricalSpentBytes;

      // Check if remote strong ETag has changed
      const existingEtag = existingLedger.rendition.etag;
      const currentEtag = this.rendition.etag;

      if (
        isStrongEtag(existingEtag) &&
        isStrongEtag(currentEtag) &&
        existingEtag !== currentEtag
      ) {
        // Strong ETag changed -> invalidate cached chunk transactions, but PRESERVE monotonic historical spend
        this._ledger.transactions = [];
        this._ledger.rendition = this.rendition;
        this._ledger.cumulativeHistoricalSpentBytes = preservedHistoricalSpentBytes;
        this._ledger.cumulativeFailedBytes = preservedFailedBytes;
        this._ledger.updatedAt = new Date().toISOString();
        await this.saveLedger();
      } else if (currentEtag && existingLedger.rendition.etag !== currentEtag) {
        this._ledger.rendition.etag = currentEtag;
        this._ledger.updatedAt = new Date().toISOString();
        await this.saveLedger();
      }
    } else {
      this._ledger = {
        version: 1,
        logicalRenditionId: this.logicalRenditionId,
        rendition: this.rendition,
        transactions: [],
        cumulativeHistoricalSpentBytes: preservedHistoricalSpentBytes,
        cumulativeFailedBytes: preservedFailedBytes,
        updatedAt: new Date().toISOString(),
      };
      await this.saveLedger();
    }

    return this._ledger;
  }

  /**
   * Updates remote rendition ETag if observed during index probing or HTTP response.
   */
  async updateRenditionEtag(currentEtag?: string): Promise<void> {
    if (!this._ledger || !currentEtag) return;

    const existingEtag = this._ledger.rendition.etag;
    if (
      isStrongEtag(existingEtag) &&
      isStrongEtag(currentEtag) &&
      existingEtag !== currentEtag
    ) {
      // Strong ETag changed -> invalidate cached transactions, preserving monotonic historical spend
      this._ledger.transactions = [];
      this._ledger.rendition.etag = currentEtag;
      await this.saveLedger();
    } else if (existingEtag !== currentEtag) {
      this._ledger.rendition.etag = currentEtag;
      await this.saveLedger();
    }
  }


  /**
   * Updates authoritative full file size if resolved from HTTP 206 Content-Range / MP4 index probe.
   */
  async updateAuthoritativeFileSize(authoritativeFileSize: number): Promise<void> {
    if (!this._ledger || !authoritativeFileSize || authoritativeFileSize <= 0) return;
    if (this._ledger.rendition.fullFileBytes === authoritativeFileSize) return;

    this._ledger.rendition.fullFileBytes = authoritativeFileSize;
    this._ledger.logicalRenditionId = computeLogicalRenditionId(this._ledger.rendition);
    this._ledger.updatedAt = new Date().toISOString();
    await this.saveLedger();
  }

  /**
   * Persists transfer-ledger.json atomically via write to tmp file, fsync, and rename.
   */
  async saveLedger(): Promise<void> {
    if (!this._ledger) return;

    this._ledger.updatedAt = new Date().toISOString();
    const content = JSON.stringify(this._ledger, null, 2);
    const tmpPath = path.join(
      this.workspaceDir,
      `transfer-ledger.json.tmp.${Date.now()}_${Math.random().toString(36).slice(2)}`
    );

    const handle = await fsp.open(tmpPath, "w");
    try {
      await handle.writeFile(content, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fsp.rename(tmpPath, this.ledgerPath);
  }

  /**
   * Checks if a completed chunk exists for the exact byte range, with strong ETag and valid SHA-256.
   */
  async getValidCompletedChunk(range: ByteRange): Promise<LedgerChunkEntry | null> {
    if (!this._ledger) {
      await this.loadOrCreateLedger();
    }

    // Cross-run cache reuse strictly requires:
    // 1. Current remote rendition must have a strong ETag
    if (!isStrongEtag(this.rendition.etag)) {
      return null;
    }

    const expectedLength = range.endByte - range.startByte + 1;
    const entry = this.ledger.transactions.find(
      (tx) =>
        tx.status === "completed" &&
        tx.range.startByte === range.startByte &&
        tx.range.endByte === range.endByte
    );

    if (!entry) {
      return null;
    }

    // 2. Cached entry itself must have a strong ETag
    // 3. Cached entry ETag must match the current rendition strong ETag
    if (
      !isStrongEtag(entry.etag) ||
      entry.etag !== this.rendition.etag
    ) {
      return null;
    }

    // 4. Exact byteLength in entry
    if (entry.byteLength !== expectedLength) {
      return null;
    }

    // Verify chunk file on disk
    try {
      const stat = await fsp.stat(entry.filePath);
      if (!stat.isFile() || stat.size !== expectedLength) {
        // Size mismatch or missing file
        return null;
      }

      if (entry.sha256) {
        const actualSha = await computeFileSha256(entry.filePath);
        if (actualSha !== entry.sha256) {
          // Checksum mismatch -> corrupt
          return null;
        }
      }

      return entry;
    } catch {
      return null;
    }
  }


  /**
   * Atomically records a completed chunk transaction into the ledger.
   */
  async recordCompletedChunk(params: {
    range: ByteRange;
    byteLength: number;
    filePath: string;
    sha256?: string;
    etag?: string;
    transferredNetworkBytes: number;
  }): Promise<LedgerChunkEntry> {
    if (!this._ledger) {
      await this.loadOrCreateLedger();
    }

    const chunkId = `chunk_${params.range.startByte}_${params.range.endByte}`;
    const entry: LedgerChunkEntry = {
      chunkId,
      range: params.range,
      byteLength: params.byteLength,
      sha256: params.sha256,
      filePath: params.filePath,
      etag: params.etag,
      status: "completed",
      transferredNetworkBytes: params.transferredNetworkBytes,
      completedAt: new Date().toISOString(),
    };

    // Remove existing entry for the same range if any
    this.ledger.transactions = this.ledger.transactions.filter(
      (tx) =>
        !(tx.range.startByte === params.range.startByte && tx.range.endByte === params.range.endByte)
    );

    this.ledger.transactions.push(entry);
    this.ledger.cumulativeHistoricalSpentBytes =
      (this.ledger.cumulativeHistoricalSpentBytes || 0) + params.transferredNetworkBytes;
    await this.saveLedger();
    return entry;
  }

  /**
   * Records failed attempt bytes into cumulativeFailedBytes and cumulativeHistoricalSpentBytes and persists atomically.
   */
  async recordFailedAttempt(bytes: number): Promise<void> {
    if (bytes <= 0) return;
    if (!this._ledger) {
      await this.loadOrCreateLedger();
    }

    this.ledger.cumulativeFailedBytes += bytes;
    this.ledger.cumulativeHistoricalSpentBytes =
      (this.ledger.cumulativeHistoricalSpentBytes || 0) + bytes;
    await this.saveLedger();
  }
}

