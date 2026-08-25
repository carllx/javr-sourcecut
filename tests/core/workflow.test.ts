import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runTracerSlice } from "../../src/core/workflow.js";
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

    // Check workspace has no extra subdirectories (flat layout)
    const files = await fs.readdir(result.workspaceDir);
    expect(files.sort()).toEqual([
      "Yua Mikami - WAVR110.proxy.mp4",
      "job.json",
    ]);
  });
});
