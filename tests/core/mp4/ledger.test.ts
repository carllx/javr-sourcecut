import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { TransferLedgerManager, isStrongEtag } from "../../../src/core/mp4/ledger.js";
import type { LedgerRenditionIdentity } from "../../../src/core/mp4/types.js";

describe("TransferLedgerManager", () => {
  let tmpDir: string;
  const sampleRendition: LedgerRenditionIdentity = {
    provider: "eporner",
    providerAssetId: "vid123",
    formatId: "2160p-av1",
    fullFileBytes: 50_000_000,
    etag: '"strong-etag-12345"',
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "javr-ledger-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("isStrongEtag", () => {
    it("recognizes strong ETags", () => {
      expect(isStrongEtag('"abcdef123"')).toBe(true);
      expect(isStrongEtag('1234567890')).toBe(true);
    });

    it("rejects weak or missing ETags", () => {
      expect(isStrongEtag('W/"abcdef123"')).toBe(false);
      expect(isStrongEtag('w/"abcdef123"')).toBe(false);
      expect(isStrongEtag(undefined)).toBe(false);
      expect(isStrongEtag("")).toBe(false);
    });
  });

  it("initializes fresh ledger when none exists on disk", async () => {
    const manager = new TransferLedgerManager({
      workspaceDir: tmpDir,
      rendition: sampleRendition,
    });

    const ledger = await manager.loadOrCreateLedger();
    expect(ledger.version).toBe(1);
    expect(ledger.logicalRenditionId).toBe("eporner:vid123:2160p-av1:50000000");
    expect(ledger.transactions).toEqual([]);
    expect(ledger.cumulativeFailedBytes).toBe(0);
  });

  it("persists and atomically reloads ledger from disk", async () => {
    const manager = new TransferLedgerManager({
      workspaceDir: tmpDir,
      rendition: sampleRendition,
    });

    await manager.loadOrCreateLedger();

    // Create a dummy chunk file
    const chunkData = Buffer.from("test chunk bytes 1234567890");
    const chunkSha = crypto.createHash("sha256").update(chunkData).digest("hex");
    const chunkPath = path.join(tmpDir, "chunks", "chunk_0_27.bin");
    await fs.mkdir(path.dirname(chunkPath), { recursive: true });
    await fs.writeFile(chunkPath, chunkData);

    await manager.recordCompletedChunk({
      range: { startByte: 0, endByte: 27 },
      byteLength: chunkData.length,
      sha256: chunkSha,
      filePath: chunkPath,
      etag: '"strong-etag-12345"',
      transferredNetworkBytes: chunkData.length,
    });

    // Create new manager instance for the same workspace
    const manager2 = new TransferLedgerManager({
      workspaceDir: tmpDir,
      rendition: sampleRendition,
    });

    const loadedLedger = await manager2.loadOrCreateLedger();
    expect(loadedLedger.transactions.length).toBe(1);
    expect(loadedLedger.transactions[0].chunkId).toBe("chunk_0_27");
    expect(loadedLedger.transactions[0].byteLength).toBe(chunkData.length);
    expect(loadedLedger.transactions[0].sha256).toBe(chunkSha);
  });

  it("validates and returns completed chunk when on-disk file and checksum match", async () => {
    const manager = new TransferLedgerManager({
      workspaceDir: tmpDir,
      rendition: sampleRendition,
    });

    await manager.loadOrCreateLedger();

    const chunkData = Buffer.from("sample media chunk payload");
    const chunkSha = crypto.createHash("sha256").update(chunkData).digest("hex");
    const chunkPath = path.join(tmpDir, "chunks", "chunk_100_125.bin");
    await fs.mkdir(path.dirname(chunkPath), { recursive: true });
    await fs.writeFile(chunkPath, chunkData);

    await manager.recordCompletedChunk({
      range: { startByte: 100, endByte: 125 },
      byteLength: chunkData.length,
      sha256: chunkSha,
      filePath: chunkPath,
      etag: '"strong-etag-12345"',
      transferredNetworkBytes: chunkData.length,
    });

    const validEntry = await manager.getValidCompletedChunk({ startByte: 100, endByte: 125 });
    expect(validEntry).not.toBeNull();
    expect(validEntry?.chunkId).toBe("chunk_100_125");
    expect(validEntry?.filePath).toBe(chunkPath);
  });

  it("rejects cached chunk if file on disk is truncated or corrupted (checksum mismatch)", async () => {
    const manager = new TransferLedgerManager({
      workspaceDir: tmpDir,
      rendition: sampleRendition,
    });

    await manager.loadOrCreateLedger();

    const chunkData = Buffer.from("original payload");
    const chunkSha = crypto.createHash("sha256").update(chunkData).digest("hex");
    const chunkPath = path.join(tmpDir, "chunks", "chunk_100_115.bin");
    await fs.mkdir(path.dirname(chunkPath), { recursive: true });
    await fs.writeFile(chunkPath, chunkData);

    await manager.recordCompletedChunk({
      range: { startByte: 100, endByte: 115 },
      byteLength: chunkData.length,
      sha256: chunkSha,
      filePath: chunkPath,
      etag: '"strong-etag-12345"',
      transferredNetworkBytes: chunkData.length,
    });

    // Corrupt the file on disk
    await fs.writeFile(chunkPath, Buffer.from("corrupted payload"));

    const validEntry = await manager.getValidCompletedChunk({ startByte: 100, endByte: 115 });
    expect(validEntry).toBeNull();
  });

  it("refuses cross-run cache reuse when remote ETag is absent or weak", async () => {
    const weakRendition: LedgerRenditionIdentity = {
      provider: "eporner",
      providerAssetId: "vid123",
      formatId: "2160p-av1",
      fullFileBytes: 50_000_000,
      etag: 'W/"weak-etag"',
    };

    const manager = new TransferLedgerManager({
      workspaceDir: tmpDir,
      rendition: weakRendition,
    });

    await manager.loadOrCreateLedger();

    const chunkData = Buffer.from("chunk data");
    const chunkPath = path.join(tmpDir, "chunks", "chunk_0_9.bin");
    await fs.mkdir(path.dirname(chunkPath), { recursive: true });
    await fs.writeFile(chunkPath, chunkData);

    await manager.recordCompletedChunk({
      range: { startByte: 0, endByte: 9 },
      byteLength: chunkData.length,
      filePath: chunkPath,
      etag: 'W/"weak-etag"',
      transferredNetworkBytes: chunkData.length,
    });

    // When checking chunk with a weak rendition ETag, cross-run reuse is rejected
    const validEntry = await manager.getValidCompletedChunk({ startByte: 0, endByte: 9 });
    expect(validEntry).toBeNull();
  });

  it("invalidates completed transactions if remote strong ETag changed between runs", async () => {
    const manager1 = new TransferLedgerManager({
      workspaceDir: tmpDir,
      rendition: { ...sampleRendition, etag: '"etag-version-1"' },
    });

    await manager1.loadOrCreateLedger();
    const chunkData = Buffer.from("v1 chunk data");
    const chunkPath = path.join(tmpDir, "chunks", "chunk_0_12.bin");
    await fs.mkdir(path.dirname(chunkPath), { recursive: true });
    await fs.writeFile(chunkPath, chunkData);

    await manager1.recordCompletedChunk({
      range: { startByte: 0, endByte: 12 },
      byteLength: chunkData.length,
      filePath: chunkPath,
      etag: '"etag-version-1"',
      transferredNetworkBytes: chunkData.length,
    });

    // Server updated video -> new ETag
    const manager2 = new TransferLedgerManager({
      workspaceDir: tmpDir,
      rendition: { ...sampleRendition, etag: '"etag-version-2"' },
    });

    const ledger2 = await manager2.loadOrCreateLedger();
    // Old transactions should be invalidated
    expect(ledger2.transactions.length).toBe(0);
    expect(ledger2.rendition.etag).toBe('"etag-version-2"');
  });

  it("persists cumulativeFailedBytes across restarts", async () => {
    const manager1 = new TransferLedgerManager({
      workspaceDir: tmpDir,
      rendition: sampleRendition,
    });

    await manager1.loadOrCreateLedger();
    await manager1.recordFailedAttempt(1500);

    const manager2 = new TransferLedgerManager({
      workspaceDir: tmpDir,
      rendition: sampleRendition,
    });

    const ledger2 = await manager2.loadOrCreateLedger();
    expect(ledger2.cumulativeFailedBytes).toBe(1500);

    await manager2.recordFailedAttempt(500);
    expect(manager2.cumulativeFailedBytes).toBe(2000);
  });

  it("calculates cumulativeHistoricalNetworkBytes as sum of completed chunk transfers and failed attempt bytes", async () => {
    const manager = new TransferLedgerManager({
      workspaceDir: tmpDir,
      rendition: sampleRendition,
    });

    await manager.loadOrCreateLedger();

    const chunk1Data = Buffer.from("chunk1");
    const chunk1Path = path.join(tmpDir, "chunks", "chunk_0_5.bin");
    await fs.mkdir(path.dirname(chunk1Path), { recursive: true });
    await fs.writeFile(chunk1Path, chunk1Data);

    await manager.recordCompletedChunk({
      range: { startByte: 0, endByte: 5 },
      byteLength: 6,
      filePath: chunk1Path,
      etag: '"strong-etag-12345"',
      transferredNetworkBytes: 6,
    });

    await manager.recordFailedAttempt(100);

    expect(manager.cumulativeHistoricalNetworkBytes).toBe(106);
  });

  it("refuses cross-run reuse if cached entry was saved with weak or missing ETag even if current rendition has strong ETag", async () => {
    const manager = new TransferLedgerManager({
      workspaceDir: tmpDir,
      rendition: sampleRendition, // Current rendition has strong ETag
    });

    await manager.loadOrCreateLedger();

    const chunkData = Buffer.from("weak chunk payload");
    const chunkPath = path.join(tmpDir, "chunks", "chunk_0_17.bin");
    await fs.mkdir(path.dirname(chunkPath), { recursive: true });
    await fs.writeFile(chunkPath, chunkData);

    // Save entry with missing / weak ETag
    await manager.recordCompletedChunk({
      range: { startByte: 0, endByte: 17 },
      byteLength: chunkData.length,
      filePath: chunkPath,
      etag: undefined, // Missing ETag when originally downloaded
      transferredNetworkBytes: chunkData.length,
    });

    // Valid check must fail closed
    const validEntry = await manager.getValidCompletedChunk({ startByte: 0, endByte: 17 });
    expect(validEntry).toBeNull();
  });

  it("updates authoritative full file size and regenerates logicalRenditionId", async () => {
    const manager = new TransferLedgerManager({
      workspaceDir: tmpDir,
      rendition: { ...sampleRendition, fullFileBytes: 1000 },
    });

    await manager.loadOrCreateLedger();
    expect(manager.ledger.logicalRenditionId).toBe("eporner:vid123:2160p-av1:1000");

    await manager.updateAuthoritativeFileSize(50_000_000);
    expect(manager.ledger.rendition.fullFileBytes).toBe(50_000_000);
    expect(manager.ledger.logicalRenditionId).toBe("eporner:vid123:2160p-av1:50000000");
  });
});

