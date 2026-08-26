# 0001. Eporner Companion Phase 1 Scope and Boundaries

## Context
Eporner provides high-resolution VR and 4K+ content, but users need an efficient way to filter out non-4K videos and identify high-priority AV1 encoded renditions directly within the browser while browsing search and list pages.

## Decision
1. **Scope Boundary**: Phase 1 is strictly a in-browser candidate filter and format detector. In-browser timeline editing, slice marking, local RPC/daemon integration, and direct downloads are explicitly out of scope.
2. **Dual-Tier Filtering**:
   - 4K+ filtering is an irreversible DOM-level **Hard Filter** (cards strictly below 2160p are removed from DOM).
   - "Only AV1" view is a reversible **Soft Filter** (cards confirmed to have no AV1 rendition are hidden via CSS/display, never removed from DOM).
3. **Rich Rendition Profile**: AV1 detection captures structured format levels (`maxResolution`, `av1Resolutions`, `highestAv1Resolution`, `has4kAv1`, `probeStatus`) rather than a single boolean.
4. **Resilient Probing**: Probing is viewport-prioritized, rate-limited, cached in persistent storage, and strictly distinguishes probe failures (`unknown` / `error`) from confirmed `no_av1`.
