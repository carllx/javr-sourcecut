import { describe, it, expect } from "vitest";
import { parseDetailPageHtml } from "../../companion/src/detail-parser.js";

describe("Companion Detail Parser", () => {
  it("extracts 4K AV1 and 1080p AV1 renditions successfully", () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Sample 4K VR Video - EPORNER</title></head>
        <body>
          <div id="downloaddiv">
            <div class="dloadcont">
              <span class="download-h264"><a href="/dload/vid123/2160/vid123-2160p.mp4">2160p 4K (3.2 GB)</a></span>
              <span class="download-av1">or <a href="/dload/vid123/2160/vid123-2160p-av1.mp4">2160p 4K AV1 (1.8 GB)</a></span>
            </div>
            <div class="dloadcont">
              <span class="download-h264"><a href="/dload/vid123/1080/vid123-1080p.mp4">1080p 60fps (1.1 GB)</a></span>
              <span class="download-av1">or <a href="/dload/vid123/1080/vid123-1080p-av1.mp4">1080p 60fps AV1 (650 MB)</a></span>
            </div>
          </div>
        </body>
      </html>
    `;

    const profile = parseDetailPageHtml(html, "vid123", "https://www.eporner.com/video-vid123/");

    expect(profile.probeStatus).toBe("detected");
    expect(profile.has4kAv1).toBe(true);
    expect(profile.highestAv1Resolution).toBe("2160p");
    expect(profile.av1Resolutions).toEqual(["2160p", "1080p"]);
    expect(profile.maxResolution).toBe("2160p");
  });

  it("identifies 1080p AV1 when 4K AV1 is absent", () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>HD Video - EPORNER</title></head>
        <body>
          <div id="downloaddiv">
            <div class="dloadcont">
              <span class="download-h264"><a href="/dload/vid456/2160/vid456-2160p.mp4">2160p 4K (2.5 GB)</a></span>
            </div>
            <div class="dloadcont">
              <span class="download-h264"><a href="/dload/vid456/1080/vid456-1080p.mp4">1080p (900 MB)</a></span>
              <span class="download-av1">or <a href="/dload/vid456/1080/vid456-1080p-av1.mp4">1080p AV1 (450 MB)</a></span>
            </div>
          </div>
        </body>
      </html>
    `;

    const profile = parseDetailPageHtml(html, "vid456", "https://www.eporner.com/video-vid456/");

    expect(profile.probeStatus).toBe("detected");
    expect(profile.has4kAv1).toBe(false);
    expect(profile.highestAv1Resolution).toBe("1080p");
    expect(profile.av1Resolutions).toEqual(["1080p"]);
    expect(profile.maxResolution).toBe("2160p");
  });

  it("correctly flags confirmed NO AV1 when valid page has only H.264 renditions", () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Classic 4K Video - EPORNER</title></head>
        <body>
          <div id="downloaddiv">
            <div class="dloadcont">
              <span class="download-h264"><a href="/dload/vid789/2160/vid789-2160p.mp4">2160p 4K (3.0 GB)</a></span>
            </div>
            <div class="dloadcont">
              <span class="download-h264"><a href="/dload/vid789/1080/vid789-1080p.mp4">1080p (1.0 GB)</a></span>
            </div>
          </div>
        </body>
      </html>
    `;

    const profile = parseDetailPageHtml(html, "vid789", "https://www.eporner.com/video-vid789/");

    expect(profile.probeStatus).toBe("no_av1");
    expect(profile.has4kAv1).toBe(false);
    expect(profile.highestAv1Resolution).toBeNull();
    expect(profile.av1Resolutions).toEqual([]);
    expect(profile.maxResolution).toBe("2160p");
  });

  it("marks anti-bot / Cloudflare challenge as error, NOT no_av1", () => {
    const html = `
      <html>
        <head><title>Just a moment...</title></head>
        <body>
          <div class="cf-challenge">Checking your browser before accessing eporner.com</div>
        </body>
      </html>
    `;

    const profile = parseDetailPageHtml(html, "cf1", "https://www.eporner.com/video-cf1/");

    expect(profile.probeStatus).toBe("error");
    expect(profile.error).toContain("Cloudflare");
    expect(profile.probeStatus).not.toBe("no_av1");
  });

  it("marks unrecognized / empty HTML as error/unknown, NEVER no_av1", () => {
    const emptyProfile = parseDetailPageHtml("", "e1", "https://www.eporner.com/video-e1/");
    expect(emptyProfile.probeStatus).toBe("error");
    expect(emptyProfile.probeStatus).not.toBe("no_av1");

    const garbageHtml = "<html><body>404 Not Found</body></html>";
    const garbageProfile = parseDetailPageHtml(garbageHtml, "g1", "https://www.eporner.com/video-g1/");
    expect(garbageProfile.probeStatus).toBe("unknown");
    expect(garbageProfile.probeStatus).not.toBe("no_av1");
  });
});
