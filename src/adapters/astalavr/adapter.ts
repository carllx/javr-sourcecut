import type { SourceAdapter, SourceDescriptor } from "../../types.js";
import { extractVideoIdFromUrl, parseAstalaVrHtml } from "./parser.js";

export class AstalaVrAdapter implements SourceAdapter {
  readonly provider = "astalavr" as const;

  canHandle(url: string): boolean {
    return extractVideoIdFromUrl(url) !== null;
  }

  async resolve(url: string, fetchFn: typeof fetch = fetch): Promise<SourceDescriptor> {
    const videoId = extractVideoIdFromUrl(url);
    if (!videoId) {
      throw new Error(`Invalid AstalaVR URL: ${url}`);
    }

    const response = await fetchFn(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://astalavr.com/",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch AstalaVR page (${response.status} ${response.statusText}): ${url}`
      );
    }

    const html = await response.text();
    const descriptor = parseAstalaVrHtml(html, url, videoId);

    if (descriptor.renditions.length === 0) {
      throw new Error(
        `No downloadable video renditions discovered for AstalaVR video ${videoId}`
      );
    }

    return descriptor;
  }
}
