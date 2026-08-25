import type { MediaRendition, SourceDescriptor, VideoCodec } from "../../types.js";

const EPORNER_URL_PATTERNS = [
  /(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)?eporner\.com\/video-([a-zA-Z0-9]+)/i,
  /(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)?eporner\.com\/video\/([a-zA-Z0-9]+)/i,
  /(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)?eporner\.com\/hd-porn\/([a-zA-Z0-9]+)/i,
  /(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)?eporner\.com\/embed\/([a-zA-Z0-9]+)/i,
  /(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)?eporner\.com\/dload\/([a-zA-Z0-9]+)/i,
  /(?:https?:\/\/)?(?:127\.0\.0\.1|localhost)(?::\d+)?\/video-([a-zA-Z0-9]+)/i,
  /(?:https?:\/\/)?(?:127\.0\.0\.1|localhost)(?::\d+)?\/video\/([a-zA-Z0-9]+)/i,
  /(?:https?:\/\/)?(?:127\.0\.0\.1|localhost)(?::\d+)?\/hd-porn\/([a-zA-Z0-9]+)/i,
  /(?:https?:\/\/)?(?:127\.0\.0\.1|localhost)(?::\d+)?\/embed\/([a-zA-Z0-9]+)/i,
  /(?:https?:\/\/)?(?:127\.0\.0\.1|localhost)(?::\d+)?\/dload\/([a-zA-Z0-9]+)/i,
];

export function extractVideoIdFromUrl(url: string): string | null {
  for (const pattern of EPORNER_URL_PATTERNS) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

export function parseEpornerHtml(
  html: string,
  sourceUrl: string,
  videoId: string
): SourceDescriptor {
  // 1. Extract Title
  let rawTitle = "";
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  if (jsonLdMatch && jsonLdMatch[1]) {
    try {
      const json = JSON.parse(jsonLdMatch[1]);
      if (json && typeof json.name === "string") {
        rawTitle = json.name.trim();
      }
    } catch {
      // Ignore JSON parse error, fallback to regex
    }
  }

  if (!rawTitle) {
    const ogTitleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
    if (ogTitleMatch && ogTitleMatch[1]) {
      rawTitle = ogTitleMatch[1].replace(/\s*-\s*EPORNER$/i, "").trim();
    }
  }

  if (!rawTitle) {
    const titleTagMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleTagMatch && titleTagMatch[1]) {
      rawTitle = titleTagMatch[1].replace(/\s*-\s*EPORNER$/i, "").trim();
    }
  }

  if (!rawTitle) {
    rawTitle = `eporner-${videoId}`;
  }

  // 2. Extract Duration
  let durationSeconds: number | undefined;
  const ogDurationMatch = html.match(/<meta property="og:duration" content="(\d+)"/i);
  if (ogDurationMatch && ogDurationMatch[1]) {
    durationSeconds = parseInt(ogDurationMatch[1], 10);
  }

  // 3. Extract Tags / Declared Performers
  const declaredPerformers: string[] = [];
  const tagMatches = html.matchAll(/<li class="vit-(?:category|tag)"><a[^>]*>([^<]+)<\/a><\/li>/gi);
  for (const match of tagMatches) {
    const tag = match[1].trim();
    if (tag && !declaredPerformers.includes(tag)) {
      declaredPerformers.push(tag);
    }
  }

  // 4. Extract Renditions from downloaddiv / links
  const renditions: MediaRendition[] = [];
  const downloadLinkRegex = /<span class="download-(av1|h264)">\s*(?:or\s*)?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/span>/gi;
  
  for (const match of html.matchAll(downloadLinkRegex)) {
    const codecClass = match[1].toLowerCase();
    const href = match[2];
    const linkText = match[3].replace(/<[^>]+>/g, "").trim();

    let vcodec: VideoCodec = "other";
    if (codecClass === "av1" || /av1/i.test(linkText) || /-av1\.mp4/i.test(href)) {
      vcodec = "av1";
    } else if (codecClass === "h264" || /h264/i.test(linkText)) {
      vcodec = "h264";
    }

    // Resolution / Height
    let height = 0;
    const resMatch = linkText.match(/(\d+)p/i) || href.match(/\/(\d+)\//) || href.match(/-(\d+)p/i);
    if (resMatch && resMatch[1]) {
      height = parseInt(resMatch[1], 10);
    }

    const resolution = height > 0 ? `${height}p` : "unknown";

    // FPS
    let fps: number | undefined;
    const fpsMatch = linkText.match(/(\d+)\s*fps/i);
    if (fpsMatch && fpsMatch[1]) {
      fps = parseInt(fpsMatch[1], 10);
    }

    // Formatted Size
    let formattedSize: string | undefined;
    const sizeMatch = linkText.match(/(\d+(?:\.\d+)?\s*(?:MB|GB|KB))/i);
    if (sizeMatch && sizeMatch[1]) {
      formattedSize = sizeMatch[1].trim();
    }

    let directUrl: string;
    try {
      directUrl = new URL(href, sourceUrl).toString();
    } catch {
      directUrl = href.startsWith("http") ? href : `https://www.eporner.com${href.startsWith("/") ? "" : "/"}${href}`;
    }

    const formatId = `${resolution}-${vcodec}`;

    renditions.push({
      formatId,
      resolution,
      height,
      fps,
      vcodec,
      directUrl,
      formattedSize,
      supportsRange: true,
    });
  }

  // Sort renditions deterministically: height ascending, then av1 before h264
  renditions.sort((a, b) => {
    if (a.height !== b.height) {
      return a.height - b.height;
    }
    if (a.vcodec === "av1" && b.vcodec !== "av1") return -1;
    if (a.vcodec !== "av1" && b.vcodec === "av1") return 1;
    return 0;
  });

  return {
    provider: "eporner",
    providerAssetId: videoId,
    sourceUrl,
    rawTitle,
    declaredPerformers,
    durationSeconds,
    renditions,
  };
}
