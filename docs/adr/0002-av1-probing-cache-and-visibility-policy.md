# 0002. AV1 Probing, Cache Integrity, and Visibility Policy

## Context
When filtering 4K+ videos on Eporner, AV1 format availability is verified asynchronously via detail page inspection. Network failures, rate limits, or HTML structure discrepancies can occur during probing. Additionally, users need seamless browsing while asynchronous probe requests are still inflight.

## Decision
1. **Optimistic Visibility**: Under "Only AV1" view (`Soft Filter`), cards in `pending`, `probing`, `unknown`, or `error` states remain visible. Only cards conclusively proven to have `no_av1` through a valid and complete parse are temporarily hidden.
2. **Cache Integrity & TTL**:
   - Only successful probe results (`detected` AV1 profiles or conclusively verified `no_av1` with valid HTML structure) may be persisted in userscript storage.
   - Any network error, timeout, HTTP error, rate limit, or HTML parsing error must be marked as `unknown` / `error` and must never be persisted as `no_av1`.
   - **Cache TTL (7 Days)**: Cached entries default to a 7-day Time-To-Live based on `updatedAt`. Expired entries or entries with missing/invalid `updatedAt` are ignored on load and evicted on retrieval to ensure capability information is refreshed periodically.
3. **Resilience & Retry**:
   - Automated retries are bounded to a maximum of 2 attempts per candidate video with backoff.
   - If auto-retries are exhausted, the card displays an error state (`4K · ⚠️`).
   - Clicking the Format Badge on an error card immediately clears the error state and re-enqueues the card at high priority for probing.
