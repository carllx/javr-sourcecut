export interface AstalaVrRenditionSummary {
  formatId: string;
  resolution: string;
  height: number;
  vcodec: string;
  mimeType: string;
  mediaHostname: string;
  fullDirectUrl: string;
}

export type AstalaVrPageStatus =
  | "WAITING_FOR_REAL_PAGE"
  | "WAITING_FOR_VIDEO_DOM"
  | "REAL_PAGE_ACTIVE";

export interface AstalaVrPageDetection {
  status: AstalaVrPageStatus;
  isChallenge: boolean;
  isRealPage: boolean;
  videoId: string | null;
}

const ASTALAVR_URL_PATTERNS = [
  /(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)?astalavr\.com\/(?:[a-z]{2}\/)?videos\/([a-zA-Z0-9]+)/i,
];

export function extractAstalaVrVideoId(url: string): string | null {
  for (const pattern of ASTALAVR_URL_PATTERNS) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

export function detectAstalaVrPage(doc: Document = document, currentUrl?: string): AstalaVrPageDetection {
  const title = (doc.title || "").trim();
  const bodyText = doc.body ? (doc.body.innerText || doc.body.textContent || "") : "";

  // Cloudflare challenge detection patterns
  const isChallenge =
    title.includes("Just a moment...") ||
    title.includes("Attention Required! | Cloudflare") ||
    bodyText.includes("Checking your browser before accessing") ||
    bodyText.includes("Verify you are human") ||
    bodyText.includes("Enable JavaScript and cookies to continue") ||
    Boolean(doc.querySelector("#challenge-running, #cf-please-wait, #cf-challenge-running"));

  const urlToCheck = currentUrl || (typeof window !== "undefined" ? window.location.href : "");
  const videoIdFromUrl = extractAstalaVrVideoId(urlToCheck);
  const mainVideo = doc.querySelector("main[data-video-id], main");
  const videoId =
    videoIdFromUrl ||
    mainVideo?.getAttribute("data-video-id") ||
    (doc.querySelector("meta[property='og:url']")?.getAttribute("content")
      ? extractAstalaVrVideoId(doc.querySelector("meta[property='og:url']")!.getAttribute("content")!)
      : null);

  const dl8Video = doc.querySelector("dl8-video");

  let status: AstalaVrPageStatus;
  if (isChallenge) {
    status = "WAITING_FOR_REAL_PAGE";
  } else if (!dl8Video) {
    status = "WAITING_FOR_VIDEO_DOM";
  } else {
    status = "REAL_PAGE_ACTIVE";
  }

  return {
    status,
    isChallenge,
    isRealPage: status === "REAL_PAGE_ACTIVE",
    videoId: videoId || null,
  };
}

export function parseAstalaVrDomRenditions(root: ParentNode = document, baseHref?: string): AstalaVrRenditionSummary[] {
  const renditions: AstalaVrRenditionSummary[] = [];
  const sources = root.querySelectorAll("dl8-video source, video source, source");
  const href = baseHref || (typeof window !== "undefined" ? window.location.href : "https://astalavr.com");

  for (const source of Array.from(sources)) {
    const rawSrc = source.getAttribute("src");
    if (!rawSrc) continue;

    const qualityAttr = source.getAttribute("quality") || "";
    const typeAttr = source.getAttribute("type") || "";
    let mediaHostname = "unknown";
    let fullDirectUrl = rawSrc;

    try {
      const parsed = new URL(rawSrc, href);
      mediaHostname = parsed.hostname;
      fullDirectUrl = parsed.toString();
    } catch {
      if (rawSrc.startsWith("//")) {
        mediaHostname = rawSrc.split("/")[2] || "unknown";
        fullDirectUrl = "https:" + rawSrc;
      } else if (rawSrc.startsWith("http")) {
        try {
          const u = new URL(rawSrc);
          mediaHostname = u.hostname;
        } catch {}
      }
    }

    let filename = "";
    try {
      const parsed = new URL(fullDirectUrl);
      filename = parsed.pathname.split("/").pop() || "";
    } catch {
      filename = fullDirectUrl.split("?")[0].split("/").pop() || "";
    }

    let height = 0;
    const heightMatch = filename.match(/(\d+)[pP]/i) || qualityAttr.match(/(\d+)[pP]?/i);
    if (heightMatch && heightMatch[1]) {
      height = parseInt(heightMatch[1], 10);
    } else if (/4[kK]/i.test(qualityAttr)) {
      height = 2160;
    }

    // Determine codec from DOM attributes if provided, otherwise "unknown"
    let vcodec = "unknown";
    if (typeAttr.includes("codecs=")) {
      const codecMatch = typeAttr.match(/codecs=["']?([^"';]+)["']?/i);
      if (codecMatch && codecMatch[1]) {
        vcodec = codecMatch[1];
      }
    } else if (typeAttr.includes("avc1") || typeAttr.includes("h264")) {
      vcodec = "h264";
    } else if (typeAttr.includes("av01") || typeAttr.includes("av1")) {
      vcodec = "av1";
    } else if (typeAttr.includes("vp9")) {
      vcodec = "vp9";
    } else if (typeAttr.includes("hvc1") || typeAttr.includes("hevc") || typeAttr.includes("h265")) {
      vcodec = "hevc";
    }

    const mimeType = typeAttr || "video/mp4";
    const resolution = height > 0 ? (height + "p") : (qualityAttr || "unknown");
    const formatId = resolution + "-" + vcodec;

    // Deduplicate identical fullDirectUrl
    if (!renditions.some((r) => r.fullDirectUrl === fullDirectUrl)) {
      renditions.push({
        formatId,
        resolution,
        height,
        vcodec,
        mimeType,
        mediaHostname,
        fullDirectUrl,
      });
    }
  }

  // Sort ascending by height
  renditions.sort((a, b) => a.height - b.height);
  return renditions;
}
