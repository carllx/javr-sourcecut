import type { MediaRendition, SourceDescriptor, VideoCodec } from "../../types.js";

const ASTALAVR_URL_PATTERNS = [
  /(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)?astalavr\.com\/(?:[a-z]{2}\/)?videos\/([a-zA-Z0-9]+)/i,
  /(?:https?:\/\/)?(?:127\.0\.0\.1|localhost)(?::\d+)?\/(?:[a-z]{2}\/)?videos\/([a-zA-Z0-9]+)/i,
];

export function extractVideoIdFromUrl(url: string): string | null {
  for (const pattern of ASTALAVR_URL_PATTERNS) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

export function extractTitleSlugFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const vidIdx = parts.findIndex((p) => p.toLowerCase() === "videos");
    if (vidIdx !== -1 && parts.length > vidIdx + 2) {
      const rawSlug = parts[vidIdx + 2];
      const decoded = decodeURIComponent(rawSlug).trim();
      if (decoded) return decoded;
    }
  } catch {}
  return null;
}

export function buildLocalAstalaVrDescriptor(
  url: string,
  videoId?: string
): SourceDescriptor {
  const resolvedVideoId = videoId || extractVideoIdFromUrl(url);
  if (!resolvedVideoId) {
    throw new Error(`Invalid AstalaVR URL: ${url}`);
  }

  const titleSlug = extractTitleSlugFromUrl(url);
  const rawTitle = titleSlug || `astalavr-${resolvedVideoId}`;

  const renditions: MediaRendition[] = [
    {
      formatId: "720p-h264",
      resolution: "720p",
      height: 720,
      vcodec: "h264",
      directUrl: "",
    },
    {
      formatId: "1440p-h264",
      resolution: "1440p",
      height: 1440,
      vcodec: "h264",
      directUrl: "",
    },
    {
      formatId: "1920p-h264",
      resolution: "1920p",
      height: 1920,
      vcodec: "h264",
      directUrl: "",
    },
  ];

  return {
    provider: "astalavr",
    providerAssetId: resolvedVideoId,
    sourceUrl: url,
    rawTitle,
    declaredPerformers: [],
    renditions,
  };
}

export function parseAstalaVrHtml(
  html: string,
  sourceUrl: string,
  videoId?: string
): SourceDescriptor {
  // 1. Extract Video ID
  let resolvedVideoId = videoId;
  if (!resolvedVideoId) {
    const mainMatch = html.match(/<main[^>]*\bdata-video-id="([^"]+)"/i);
    if (mainMatch && mainMatch[1]) {
      resolvedVideoId = mainMatch[1];
    }
  }
  if (!resolvedVideoId) {
    const scriptMatch = html.match(/window\.videoId\s*=\s*["']([^"']+)["']/i);
    if (scriptMatch && scriptMatch[1]) {
      resolvedVideoId = scriptMatch[1];
    }
  }
  if (!resolvedVideoId) {
    resolvedVideoId = extractVideoIdFromUrl(sourceUrl) || "unknown";
  }

  // 2. Extract Title
  let rawTitle = "";
  const dl8TitleMatch = html.match(/<dl8-video[^>]*\btitle="([^"]+)"/i);
  if (dl8TitleMatch && dl8TitleMatch[1]) {
    rawTitle = dl8TitleMatch[1].trim();
  }

  if (!rawTitle) {
    const h2Match = html.match(/<h2[^>]*class="[^"]*font-bold[^"]*"[^>]*>([\s\S]*?)<\/h2>/i);
    if (h2Match && h2Match[1]) {
      rawTitle = h2Match[1].replace(/<[^>]+>/g, "").trim();
    }
  }

  if (!rawTitle) {
    const ogTitleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
    if (ogTitleMatch && ogTitleMatch[1]) {
      rawTitle = ogTitleMatch[1].replace(/\s*\|\s*AstalaVR$/i, "").trim();
    }
  }

  if (!rawTitle) {
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (jsonLdMatch && jsonLdMatch[1]) {
      try {
        const json = JSON.parse(jsonLdMatch[1]);
        if (json && typeof json.name === "string") {
          rawTitle = json.name.trim();
        }
      } catch {
        // Ignore json error
      }
    }
  }

  if (!rawTitle) {
    const titleTagMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleTagMatch && titleTagMatch[1]) {
      rawTitle = titleTagMatch[1]
        .replace(/\s*\|\s*AstalaVR$/i, "")
        .replace(/^AstalaVR:\s*/i, "")
        .trim();
    }
  }

  if (!rawTitle) {
    rawTitle = `astalavr-${resolvedVideoId}`;
  }

  // 3. Extract Duration
  let durationSeconds: number | undefined;
  const ogDurationMatch = html.match(/<meta property="video:duration" content="(\d+)"/i);
  if (ogDurationMatch && ogDurationMatch[1]) {
    durationSeconds = parseInt(ogDurationMatch[1], 10);
  }

  // 4. Extract Declared Performers (Actresses)
  const declaredPerformers: string[] = [];
  const actorMetaMatches = html.matchAll(/<meta property="video:actor" content="([^"]+)"/gi);
  for (const match of actorMetaMatches) {
    const performer = match[1].trim();
    if (performer && !declaredPerformers.includes(performer)) {
      declaredPerformers.push(performer);
    }
  }

  const actressItemMatches = html.matchAll(
    /<div class="actress-item[^"]*">[\s\S]*?<a\s+href="\/search\/[^"]*"[^>]*>([^<]+)<\/a>/gi
  );
  for (const match of actressItemMatches) {
    const performer = match[1].trim();
    if (performer && !declaredPerformers.includes(performer)) {
      declaredPerformers.push(performer);
    }
  }

  // 5. Extract FPS from <dl8-video>
  let fps: number | undefined;
  const fpsMatch = html.match(/<dl8-video[^>]*\bfps="(\d+)"/i);
  if (fpsMatch && fpsMatch[1]) {
    fps = parseInt(fpsMatch[1], 10);
  }

  // 6. Extract Renditions from <dl8-video> <source> tags
  const renditions: MediaRendition[] = [];
  const observedFilenames: string[] = [];

  // Match all <source ...> tags
  const sourceTagRegex = /<source\b([^>]*)>/gi;
  for (const match of html.matchAll(sourceTagRegex)) {
    const attrs = match[1];
    const srcMatch = attrs.match(/\bsrc="([^"]+)"/i);
    if (!srcMatch || !srcMatch[1]) continue;

    const rawSrc = srcMatch[1].replace(/&amp;/g, "&");
    const qualityMatch = attrs.match(/\bquality="([^"]+)"/i);
    const qualityAttr = qualityMatch ? qualityMatch[1] : "";

    // Extract filename clue
    let filename = "";
    try {
      const parsed = new URL(rawSrc, sourceUrl);
      filename = parsed.pathname.split("/").pop() || "";
    } catch {
      filename = rawSrc.split("?")[0].split("/").pop() || "";
    }
    if (filename && !observedFilenames.includes(filename)) {
      observedFilenames.push(filename);
    }

    // Determine height and resolution
    let height = 0;
    const heightMatch = filename.match(/(\d+)[pP]/i) || qualityAttr.match(/(\d+)[pP]?/i);
    if (heightMatch && heightMatch[1]) {
      height = parseInt(heightMatch[1], 10);
    } else if (/4[kK]/i.test(qualityAttr)) {
      height = 2160;
    }

    // Direct MP4 URL resolution
    let directUrl: string;
    try {
      directUrl = new URL(rawSrc, sourceUrl).toString();
    } catch {
      directUrl = rawSrc.startsWith("http")
        ? rawSrc
        : `https://cdn3.astalavr.com${rawSrc.startsWith("/") ? "" : "/"}${rawSrc}`;
    }

    const resolution = height > 0 ? `${height}p` : "unknown";
    const vcodec: VideoCodec = "h264";
    const formatId = `${resolution}-${vcodec}`;

    renditions.push({
      formatId,
      resolution,
      height,
      fps,
      vcodec,
      directUrl,
    });
  }

  if (renditions.length === 0) {
    throw new Error(`No downloadable video renditions discovered for AstalaVR video ${resolvedVideoId}`);
  }

  // Sort renditions deterministically: height ascending, formatId ascending
  renditions.sort((a, b) => {
    if (a.height !== b.height) {
      return a.height - b.height;
    }
    return a.formatId.localeCompare(b.formatId);
  });

  return {
    provider: "astalavr",
    providerAssetId: resolvedVideoId,
    sourceUrl,
    rawTitle,
    declaredPerformers,
    observedFilenames: observedFilenames.length > 0 ? observedFilenames : undefined,
    durationSeconds,
    renditions,
  };
}
