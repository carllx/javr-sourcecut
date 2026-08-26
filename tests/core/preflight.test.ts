import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { checkDuplicatePreflight, DuplicatePreflightError } from "../../src/core/preflight.js";
import { saveJob, createJob } from "../../src/core/job.js";
import type { SourceDescriptor, MediaRendition, JobStatus } from "../../src/types.js";

describe("Duplicate Preflight Hardening", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sc-preflight-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const sampleRendition: MediaRendition = {
    formatId: "480p-av1",
    resolution: "480p",
    height: 480,
    vcodec: "av1",
    directUrl: "http://example.com/480.mp4",
  };

  it("returns not-seen when no prior jobs or records exist in rootDir", async () => {
    const descriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "fresh123",
      sourceUrl: "https://www.eporner.com/video-fresh123/ssni-999-new-video/",
      rawTitle: "SSNI-999 New Video",
      declaredPerformers: ["Actress A"],
      renditions: [sampleRendition],
    };

    const result = await checkDuplicatePreflight(tempRoot, descriptor);
    expect(result.status).toBe("not-seen");
    expect(result.matchedJob).toBeUndefined();
  });

  it("detects in-progress duplicate across all active job statuses (discovering, created, proxy-downloading, waiting-for-llc, needs-user-intervention)", async () => {
    const activeStatuses: JobStatus[] = [
      "created",
      "discovering",
      "proxy-downloading",
      "waiting-for-llc",
      "needs-user-intervention",
    ];

    for (const status of activeStatuses) {
      const subRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sc-status-test-"));
      try {
        const descriptor: SourceDescriptor = {
          provider: "eporner",
          providerAssetId: `asset-${status}`,
          sourceUrl: `https://www.eporner.com/video-asset-${status}/wavr-110/`,
          rawTitle: "WAVR-110 Yua Mikami",
          declaredPerformers: ["Yua Mikami"],
          renditions: [sampleRendition],
        };

        const job = await createJob(subRoot, descriptor, sampleRendition);
        job.status = status;
        await saveJob(job);

        const result = await checkDuplicatePreflight(subRoot, descriptor);
        expect(result.status).toBe("in-progress");
        expect(result.matchedJob?.jobId).toBe(job.jobId);
        expect(result.matchedJob?.status).toBe(status);
      } finally {
        await fs.rm(subRoot, { recursive: true, force: true });
      }
    }
  });

  it("does not block when prior job is in failed state", async () => {
    const descriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "failedAsset123",
      sourceUrl: "https://www.eporner.com/video-failedAsset123/jfb-446/",
      rawTitle: "JFB-446 Title",
      declaredPerformers: ["Actress B"],
      renditions: [sampleRendition],
    };

    const job = await createJob(tempRoot, descriptor, sampleRendition);
    job.status = "failed";
    await saveJob(job);

    const result = await checkDuplicatePreflight(tempRoot, descriptor);
    expect(result.status).toBe("not-seen");
  });

  it("detects completed duplicate even if final MP4 file was moved or deleted", async () => {
    const descriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "completedAsset",
      sourceUrl: "https://www.eporner.com/video-completedAsset/ipx-534/",
      rawTitle: "IPX-534 Kaede Karen",
      declaredPerformers: ["Kaede Karen"],
      renditions: [sampleRendition],
    };

    const job = await createJob(tempRoot, descriptor, sampleRendition);
    job.status = "completed";
    await saveJob(job);

    // Ensure final output file does NOT exist on disk
    try {
      await fs.rm(job.finalOutputPath, { force: true });
    } catch {}

    const result = await checkDuplicatePreflight(tempRoot, descriptor);
    expect(result.status).toBe("completed");
    expect(result.matchedJob?.jobId).toBe(job.jobId);
    expect(result.matchedJob?.status).toBe("completed");
  });

  it("matches duplicate by canonical catalog ID across different URLs and provider IDs", async () => {
    const initialDescriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "providerAssetA",
      sourceUrl: "https://www.eporner.com/video-providerAssetA/wavr-110-yua-mikami/",
      rawTitle: "WAVR-110 Yua Mikami",
      declaredPerformers: ["Yua Mikami"],
      renditions: [sampleRendition],
    };

    const job = await createJob(tempRoot, initialDescriptor, sampleRendition);
    job.status = "waiting-for-llc";
    await saveJob(job);

    // New incoming descriptor with different providerAssetId and URL but matching catalog ID
    const incomingDescriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "providerAssetB",
      sourceUrl: "https://www.eporner.com/video-providerAssetB/wavr-110-remaster/",
      rawTitle: "WAVR-110 HD Remaster",
      declaredPerformers: ["Yua Mikami"],
      renditions: [sampleRendition],
    };

    const result = await checkDuplicatePreflight(tempRoot, incomingDescriptor);
    expect(result.status).toBe("in-progress");
    expect(result.matchedJob?.identity.canonicalCatalogId).toBe("WAVR110");
  });

  it("matches duplicate by structured search aliases (e.g. hyphenated forms)", async () => {
    const initialDescriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "assetX",
      sourceUrl: "https://www.eporner.com/video-assetX/ssni-888/",
      rawTitle: "SSNI-888 Yua Mikami",
      declaredPerformers: ["Yua Mikami"],
      renditions: [sampleRendition],
    };

    const job = await createJob(tempRoot, initialDescriptor, sampleRendition);
    job.status = "completed";
    await saveJob(job);

    const incomingDescriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "assetY",
      sourceUrl: "https://www.eporner.com/video-assetY/ssni-888-alt/",
      rawTitle: "SSNI-888 Alternative Version",
      declaredPerformers: ["Yua Mikami"],
      renditions: [sampleRendition],
    };

    const result = await checkDuplicatePreflight(tempRoot, incomingDescriptor);
    expect(result.status).toBe("completed");
  });

  it("does not block different works featuring the same performer or performer aliases (not-seen)", async () => {
    // Existing job featuring Yua Mikami in SSNI-888
    const existingDescriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "assetA",
      sourceUrl: "https://www.eporner.com/video-assetA/ssni-888-yua-mikami/",
      rawTitle: "SSNI-888 Yua Mikami",
      declaredPerformers: [
        { preferredName: "Yua Mikami", aliases: ["Mikami Yua", "Momona Kito"] },
      ],
      renditions: [sampleRendition],
    };

    const job = await createJob(tempRoot, existingDescriptor, sampleRendition);
    job.status = "completed";
    await saveJob(job);

    // Incoming work featuring the same performer and performer alias but DIFFERENT catalog ID and provider asset ID
    const incomingDescriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "assetB",
      sourceUrl: "https://www.eporner.com/video-assetB/ssni-999-mikami-yua/",
      rawTitle: "SSNI-999 Mikami Yua",
      declaredPerformers: [
        { preferredName: "Yua Mikami", aliases: ["Mikami Yua"] },
      ],
      renditions: [sampleRendition],
    };

    const result = await checkDuplicatePreflight(tempRoot, incomingDescriptor);
    expect(result.status).toBe("not-seen");
    expect(result.matchedJob).toBeUndefined();
  });

  it("scopes provider asset IDs strictly to their provider namespace (different providers with same raw ID are not-seen)", async () => {
    // Existing job from eporner with asset ID "777888" and raw fallback title
    const existingDescriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "777888",
      sourceUrl: "https://www.eporner.com/video-777888/eporner-title/",
      rawTitle: "Eporner Raw Title",
      declaredPerformers: [],
      renditions: [sampleRendition],
    };

    const job = await createJob(tempRoot, existingDescriptor, sampleRendition);
    job.status = "completed";
    await saveJob(job);

    // Incoming job from astalavr with same raw asset ID "777888" and different URL / title
    const incomingDescriptor: SourceDescriptor = {
      provider: "astalavr",
      providerAssetId: "777888",
      sourceUrl: "https://www.astalavr.com/video-777888/astalavr-title/",
      rawTitle: "AstalaVR Raw Title",
      declaredPerformers: [],
      renditions: [sampleRendition],
    };

    const result = await checkDuplicatePreflight(tempRoot, incomingDescriptor);
    expect(result.status).toBe("not-seen");
    expect(result.matchedJob).toBeUndefined();
  });

  it("does not block when only low-confidence filename catalog candidates are present (not-seen)", async () => {
    // Existing job with low-confidence filename-only clue IPX-789
    const existingDescriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "assetFirst",
      sourceUrl: "https://www.eporner.com/video-assetFirst/unrelated-one/",
      rawTitle: "Unrelated Title One",
      declaredPerformers: [],
      observedFilenames: ["extra_ipx789_1080p.mp4"],
      renditions: [sampleRendition],
    };

    const job = await createJob(tempRoot, existingDescriptor, sampleRendition);
    job.status = "completed";
    await saveJob(job);

    // Incoming job with different asset ID and different URL that also has a filename containing IPX-789
    const incomingDescriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "assetSecond",
      sourceUrl: "https://www.eporner.com/video-assetSecond/unrelated-two/",
      rawTitle: "Unrelated Title Two",
      declaredPerformers: [],
      observedFilenames: ["extra_ipx789_720p.mp4"],
      renditions: [sampleRendition],
    };

    const result = await checkDuplicatePreflight(tempRoot, incomingDescriptor);
    expect(result.status).toBe("not-seen");
    expect(result.matchedJob).toBeUndefined();
  });

  it("treats fuzzy filename clues alone as auxiliary evidence without creating authoritative duplicate blocker", async () => {
    // Create an unmanaged file in rootDir that might have a similar name, but no job.json
    const unmanagedDir = path.join(tempRoot, "Random Video Folder");
    await fs.mkdir(unmanagedDir, { recursive: true });
    await fs.writeFile(path.join(unmanagedDir, "SomeOtherVideo.mp4"), "dummy");

    const descriptor: SourceDescriptor = {
      provider: "eporner",
      providerAssetId: "nonMatchingAsset",
      sourceUrl: "https://www.eporner.com/video-nonMatchingAsset/unrelated/",
      rawTitle: "Unrelated Title",
      declaredPerformers: ["Actress C"],
      renditions: [sampleRendition],
    };

    const result = await checkDuplicatePreflight(tempRoot, descriptor);
    expect(result.status).toBe("not-seen");
    expect(result.matchedJob).toBeUndefined();
  });
});
