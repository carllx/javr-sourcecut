import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runTracerSlice } from "../../src/core/workflow.js";
import { NoopSessionProvider } from "../../src/core/session.js";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("Eporner Tracer Slice 1 End-to-End Workflow", () => {
  let server: http.Server;
  let serverUrl: string;
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sc-tracer-test-"));
    vi.stubEnv("JAVR_PROFILES_DIR", path.join(tempRoot, "profiles"));

    server = http.createServer((req, res) => {
      if (req.url?.startsWith("/video-sample123")) {
        const html = `
          <!DOCTYPE html>
          <html>
          <head>
            <title>WAVR-110 Yua Mikami - EPORNER</title>
            <meta property="og:duration" content="1200" />
            <script type="application/ld+json">
            {
              "@type": "VideoObject",
              "name": "WAVR-110 Yua Mikami",
              "duration": "PT0H20M00S"
            }
            </script>
          </head>
          <body>
            <div id="video-info-tags">
              <ul>
                <li class="vit-pornstar"><a href="/pornstar/yua-mikami/">Yua Mikami</a></li>
              </ul>
            </div>
            <div id="downloaddiv">
              <div id="hd-porn-dload">
                <div class="dloaddivcol">
                  <u>480p:</u>
                  <span class="download-av1"><a href="/dload/sample123/480/sample-480p-av1.mp4">Download MP4 (480p, AV1, 50 MB)</a></span>
                  <span class="download-h264"> or <a href="/dload/sample123/480/sample-480p.mp4"> MP4 (480p, h264, 100 MB)</a></span><br />
                  <u>1080p@60fps HD:</u>
                  <span class="download-av1"><a href="/dload/sample123/1080/sample-1080p-av1.mp4">Download MP4 (1080p, AV1, 200 MB)</a></span><br />
                </div>
              </div>
            </div>
          </body>
          </html>
        `;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.url === "/dload/sample123/480/sample-480p-av1.mp4") {
        res.writeHead(302, { Location: `${serverUrl}/cdn/sample-480p-av1.mp4` });
        res.end();
        return;
      }

      if (req.url === "/cdn/sample-480p-av1.mp4") {
        const payload = Buffer.from("SYNTHETIC_PROXY_MP4_PAYLOAD_12345");
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": payload.length.toString(),
        });
        res.end(payload);
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("completes full tracer slice 1 to intentional waiting-for-llc pause", async () => {
    const epornerVideoUrl = `${serverUrl}/video-sample123/wavr-110-yua-mikami/`;

    // Mock verifier that validates downloaded synthetic file
    const mockVerifier = async (filePath: string) => {
      const content = await fs.readFile(filePath);
      if (content.length === 0) throw new Error("File empty");
      return {
        isValid: true,
        duration: 1200,
        videoStream: { codec: "av01", width: 854, height: 480, fps: 30 },
        audioStream: { codec: "aac" },
      };
    };

    const result = await runTracerSlice({
      sourceUrl: epornerVideoUrl,
      rootDir: tempRoot,
      sessionProvider: new NoopSessionProvider(),
      verifierFn: mockVerifier,
    });

    expect(result.status).toBe("waiting-for-llc");
    expect(result.jobId).toBe("eporner-sample123");
    expect(result.proxyPath).toContain("Yua Mikami - WAVR110.proxy.mp4");
    expect(result.expectedLlcPath).toContain("Yua Mikami - WAVR110.llc");

    // Check that proxy was downloaded
    const proxyExists = await fs.access(result.proxyPath).then(() => true).catch(() => false);
    expect(proxyExists).toBe(true);

    // Check that job.json exists and has waiting-for-llc status
    const jobJsonContent = JSON.parse(await fs.readFile(result.jobJsonPath, "utf-8"));
    expect(jobJsonContent.status).toBe("waiting-for-llc");
    expect(jobJsonContent.selectedProxy.formatId).toBe("480p-av1");
    expect(jobJsonContent.identity.canonicalCatalogId).toBe("WAVR110");
    expect(jobJsonContent.identity.searchAliases).toContain("WAVR110");
    expect(jobJsonContent.identity.searchAliases).toContain("WAVR-110");

    // Check workspace has no extra subdirectories (flat layout)
    const files = await fs.readdir(result.workspaceDir);
    expect(files.sort()).toEqual([
      "Yua Mikami - WAVR110.proxy.mp4",
      "job.json",
    ]);

    // Secondary attempt with the same URL must halt with DuplicatePreflightError before download
    await expect(
      runTracerSlice({
        sourceUrl: epornerVideoUrl,
        rootDir: tempRoot,
        sessionProvider: new NoopSessionProvider(),
        verifierFn: mockVerifier,
      })
    ).rejects.toThrow(/Duplicate preflight halted/i);
  });
});

describe("AstalaVR Tracer Slice 1 End-to-End Workflow", () => {
  let server: http.Server;
  let serverUrl: string;
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sc-astala-workflow-"));
    vi.stubEnv("JAVR_PROFILES_DIR", path.join(tempRoot, "profiles"));

    server = http.createServer((req, res) => {
      if (req.url?.startsWith("/videos/7gYMp")) {
        const html = `
          <!DOCTYPE html>
          <html>
          <head>
            <title>Kenzie Reeves VR Scene | AstalaVR</title>
            <meta property="video:actor" content="Kenzie Reeves" />
            <meta property="video:duration" content="2400" />
          </head>
          <body>
            <main data-video-id="7gYMp">
              <dl8-video title="Kenzie Reeves VR Scene" fps="60">
                <source src="${serverUrl}/media/7gYMp/720P.mp4?token=123" type="video/mp4" quality="720P" />
                <source src="${serverUrl}/media/7gYMp/1440P.mp4?token=123" type="video/mp4" quality="1440P" />
                <source src="${serverUrl}/media/7gYMp/2048P.mp4?token=123" type="video/mp4" quality="4K" />
              </dl8-video>
            </main>
          </body>
          </html>
        `;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.url?.startsWith("/media/7gYMp/720P.mp4")) {
        const payload = Buffer.from("SYNTHETIC_ASTALAVR_720P_PROXY_MP4");
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": payload.length.toString(),
        });
        res.end(payload);
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("ingests AstalaVR URL, selects proxy, downloads, and pauses at waiting-for-llc", async () => {
    const astalaUrl = `${serverUrl}/videos/7gYMp/Kenzie-Reeves-VR-Scene`;

    const mockVerifier = async (filePath: string) => {
      const content = await fs.readFile(filePath);
      if (content.length === 0) throw new Error("File empty");
      return {
        isValid: true,
        duration: 2400,
        videoStream: { codec: "h264", width: 1280, height: 720, fps: 60 },
        audioStream: { codec: "aac" },
      };
    };

    const result = await runTracerSlice({
      sourceUrl: astalaUrl,
      rootDir: tempRoot,
      sessionProvider: new NoopSessionProvider(),
      verifierFn: mockVerifier,
    });

    expect(result.status).toBe("waiting-for-llc");
    expect(result.jobId).toBe("astalavr-7gYMp");
    expect(result.proxyPath).toContain("astalavr-7gYMp - Kenzie Reeves VR Scene.proxy.mp4");
    expect(result.expectedLlcPath).toContain("astalavr-7gYMp - Kenzie Reeves VR Scene.llc");

    const jobJson = JSON.parse(await fs.readFile(result.jobJsonPath, "utf-8"));
    expect(jobJson.provider).toBe("astalavr");
    expect(jobJson.providerAssetId).toBe("7gYMp");
    expect(jobJson.status).toBe("waiting-for-llc");
    expect(jobJson.selectedProxy.formatId).toBe("720p-h264");
    expect(jobJson.selectedProxy.height).toBe(720);
    expect(jobJson.identity.performers[0].preferredName).toBe("Kenzie Reeves");

    // Second ingestion of same URL halts with duplicate preflight error
    await expect(
      runTracerSlice({
        sourceUrl: astalaUrl,
        rootDir: tempRoot,
        sessionProvider: new NoopSessionProvider(),
        verifierFn: mockVerifier,
      })
    ).rejects.toThrow(/Duplicate preflight halted/i);
  });
});

