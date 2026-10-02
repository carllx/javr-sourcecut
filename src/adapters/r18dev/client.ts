import { SourceQueryFailure } from "../../core/ingestion.js";
import type { R18MovieDetailResponse } from "./types.js";

export interface R18DevClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

const HTML_CHALLENGE_PATTERN =
  /<!DOCTYPE\s+html|<html[\s>]|\/cdn-cgi\/challenge-platform|cf-turnstile|cf_chl/i;

export class R18DevClient {
  private baseUrl: string;
  private fetchFn: typeof fetch;

  constructor(options: R18DevClientOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "") || "https://r18.dev";
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

  public async fetchDetail(
    contentId: string
  ): Promise<R18MovieDetailResponse | null> {
    const cleanId = contentId.trim().toLowerCase();
    const url = `${this.baseUrl}/videos/vod/movies/detail/-/combined=${encodeURIComponent(cleanId)}/json`;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: {
          Accept: "application/json, text/plain, */*",
          "User-Agent": "javr-sourcecut/0.1.0",
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SourceQueryFailure("NETWORK_ERROR", `Network error fetching R18.dev: ${msg}`, true);
    }

    if (response.status === 404) {
      return null;
    }

    if (response.status === 429) {
      throw new SourceQueryFailure(
        "HTTP_429",
        "R18.dev rate limit exceeded (HTTP 429)",
        true
      );
    }

    if (response.status === 503) {
      throw new SourceQueryFailure(
        "HTTP_503",
        "R18.dev service unavailable (HTTP 503)",
        true
      );
    }

    if (response.status === 403) {
      throw new SourceQueryFailure(
        "HTTP_403",
        "R18.dev access forbidden (HTTP 403)",
        true
      );
    }

    if (response.status === 401) {
      throw new SourceQueryFailure(
        "AUTH_FAILED",
        "R18.dev unauthorized (HTTP 401)",
        true
      );
    }

    if (!response.ok) {
      throw new SourceQueryFailure(
        "NETWORK_ERROR",
        `R18.dev returned HTTP ${response.status} ${response.statusText}`,
        true
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SourceQueryFailure("NETWORK_ERROR", `Failed to read R18.dev response body: ${msg}`, true);
    }

    if (HTML_CHALLENGE_PATTERN.test(text)) {
      throw new SourceQueryFailure(
        "CHALLENGE_SHELL",
        "R18.dev returned HTML challenge shell instead of expected JSON payload",
        true
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SourceQueryFailure(
        "MALFORMED_RESPONSE",
        `Failed to parse R18.dev JSON response: ${msg}`,
        true
      );
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SourceQueryFailure(
        "MALFORMED_RESPONSE",
        "R18.dev returned non-object JSON response",
        true
      );
    }

    const obj = parsed as Record<string, unknown>;

    // Handle explicit upstream error responses (e.g. { error: "not found" })
    if (obj.error === "not found" || obj.code === 404) {
      return null;
    }

    if (!obj.content_id || typeof obj.content_id !== "string") {
      throw new SourceQueryFailure(
        "MALFORMED_RESPONSE",
        "R18.dev JSON response missing required 'content_id' field",
        true
      );
    }

    return parsed as R18MovieDetailResponse;
  }
}
