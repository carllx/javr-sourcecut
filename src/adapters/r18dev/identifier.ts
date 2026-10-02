import { SourceQueryFailure } from "../../core/ingestion.js";
import type { R18MovieDetailResponse } from "./types.js";

export const IGNORED_JAV_PREFIXES = new Set([
  "VR",
  "HD",
  "FHD",
  "UHD",
  "FPS",
  "X264",
  "X265",
  "H264",
  "HEVC",
  "TEST",
  "VIDEO",
  "VID",
  "ASSET",
  "ITEM",
  "FILE",
  "ID",
  "MOV",
  "MOVIE",
  "MP",
  "MKV",
  "AVI",
  "WEBM",
  "FLV",
  "UPLOAD",
  "SAMPLE",
  "DOWNLOAD",
  "CHANNEL",
  "PART",
  "CLIP",
  "SCENE",
  "DATE",
  "HTTP",
  "HTTPS",
  "EPORNER",
  "ASTALAVR",
  "PIKPAK",
]);

const JAV_IDENTIFIER_PATTERN =
  /(?:^|[^a-zA-Z0-9])([a-zA-Z]{2,8})[-_\s]?(\d{1,6})(?=[^a-zA-Z0-9]|$)/g;

export interface ParsedJavIdentifier {
  series: string;
  rawSeries: string;
  numericCore: number;
  rawNumber: string;
  canonical: string;
}

export interface JavIdentityKey {
  series: string;
  numericCore: number;
}

export interface ActualJavIdentity extends JavIdentityKey {
  contentId?: string;
  dvdId?: string | null;
}

export class IdentityMismatchError extends SourceQueryFailure {
  public readonly expected: JavIdentityKey;
  public readonly actual: ActualJavIdentity;

  constructor(
    message: string,
    expected: JavIdentityKey,
    actual: ActualJavIdentity
  ) {
    super("IDENTITY_MISMATCH", message, false);
    this.name = "IdentityMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

export function parseJavIdentifier(text: string): ParsedJavIdentifier | null {
  if (!text || typeof text !== "string") return null;

  const matches = Array.from(text.matchAll(JAV_IDENTIFIER_PATTERN));
  for (const match of matches) {
    const rawSeries = match[1];
    const prefixUpper = rawSeries.toUpperCase();
    const rawNumber = match[2];

    if (IGNORED_JAV_PREFIXES.has(prefixUpper)) {
      continue;
    }

    const numericCore = parseInt(rawNumber, 10);
    if (Number.isNaN(numericCore)) {
      continue;
    }

    const series = rawSeries.toLowerCase();
    const formattedNum =
      rawNumber.length < 3 ? rawNumber.padStart(3, "0") : rawNumber;
    const canonical = `${prefixUpper}-${formattedNum}`;

    return {
      series,
      rawSeries,
      numericCore,
      rawNumber,
      canonical,
    };
  }

  return null;
}

export function generateContentIdCandidates(
  identifier: ParsedJavIdentifier
): string[] {
  const { series, numericCore, rawNumber } = identifier;
  const candidates: string[] = [];
  const seen = new Set<string>();

  const add = (cid: string) => {
    if (cid && !seen.has(cid)) {
      seen.add(cid);
      candidates.push(cid);
    }
  };

  // 1. Primary candidate: standard DMM / R18.dev 5-digit zero-padded format
  add(`${series}${String(numericCore).padStart(5, "0")}`);

  // 2. Exact as-given raw number if different length
  if (rawNumber.length !== 5) {
    add(`${series}${rawNumber}`);
  }

  // 3. 3-digit zero-padded (e.g. for short series)
  if (numericCore < 1000) {
    add(`${series}${String(numericCore).padStart(3, "0")}`);
  }

  // 4. 4-digit zero-padded
  if (numericCore < 10000) {
    add(`${series}${String(numericCore).padStart(4, "0")}`);
  }

  // 5. Unpadded numeric core
  add(`${series}${numericCore}`);

  return candidates;
}

export function verifyPostFetchIdentity(
  expected: ParsedJavIdentifier,
  data: Partial<R18MovieDetailResponse>
): void {
  if (!data || typeof data !== "object" || !data.content_id) {
    throw new SourceQueryFailure(
      "MALFORMED_RESPONSE",
      "Missing or invalid content_id in R18.dev response",
      true
    );
  }

  const rawCid = String(data.content_id).trim().toLowerCase();
  const cidMatch = rawCid.match(/(?:[a-z0-9]+_|\d+)?([a-z]{2,8})(\d{1,6})$/);
  if (!cidMatch) {
    throw new SourceQueryFailure(
      "MALFORMED_RESPONSE",
      `Malformed content_id format: "${data.content_id}"`,
      true
    );
  }

  const actualSeries = cidMatch[1];
  const actualCore = parseInt(cidMatch[2], 10);

  if (
    actualSeries !== expected.series ||
    actualCore !== expected.numericCore
  ) {
    throw new IdentityMismatchError(
      `R18.dev content_id mismatch: expected series "${expected.series}" core ${expected.numericCore}, but received "${actualSeries}" core ${actualCore} (content_id="${data.content_id}")`,
      { series: expected.series, numericCore: expected.numericCore },
      {
        series: actualSeries,
        numericCore: actualCore,
        contentId: data.content_id,
        dvdId: data.dvd_id,
      }
    );
  }

  // If dvd_id is non-null and present in returned record, also verify it
  if (data.dvd_id && typeof data.dvd_id === "string") {
    const dvdParsed = parseJavIdentifier(data.dvd_id);
    if (dvdParsed) {
      if (
        dvdParsed.series !== expected.series ||
        dvdParsed.numericCore !== expected.numericCore
      ) {
        throw new IdentityMismatchError(
          `R18.dev dvd_id mismatch: expected series "${expected.series}" core ${expected.numericCore}, but received dvd_id="${data.dvd_id}"`,
          { series: expected.series, numericCore: expected.numericCore },
          {
            series: dvdParsed.series,
            numericCore: dvdParsed.numericCore,
            contentId: data.content_id,
            dvdId: data.dvd_id,
          }
        );
      }
    }
  }
}
