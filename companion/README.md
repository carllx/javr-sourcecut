# Eporner Browser Companion

> Lightweight Tampermonkey userscript for 4K+ candidate video validation and AV1 rendition probing on Eporner.

---

## 1. What it is

The **Eporner Browser Companion** is an in-browser companion script designed to streamline candidate video discovery on Eporner:
- **4K+ Candidate Validation**: Filters video list cards client-side (Hard Filter), removing sub-4K items from the DOM and keeping 4K+ candidate cards.
- **AV1 Format Probing**: Asynchronously probes detail pages for candidate cards in the background to detect AV1 availability and highest AV1 resolutions (e.g. 2160p vs 1080p).
- **Soft Filtering**: Allows one-click toggling to hide videos confirmed to have NO AV1 while optimistically keeping pending/unprobed videos visible.

> [!NOTE]
> **Not a Downloader**: The Browser Companion does **not** download video files, run FFmpeg clipping, or replace the SourceCut core CLI/daemon workflow. It focuses exclusively on candidate discovery and capability probing in the browser.

---

## 2. Installation

### Prerequisites
- Chrome, Edge, Firefox, or any Chromium-based browser.
- [Tampermonkey extension](https://www.tampermonkey.net/) installed and enabled.

### Install URL
Install the production userscript directly via Tampermonkey:
- [https://raw.githubusercontent.com/carllx/javr-sourcecut/main/userscripts/eporner-companion.user.js](https://raw.githubusercontent.com/carllx/javr-sourcecut/main/userscripts/eporner-companion.user.js)

*(Note: During development and PR reviews, you can install from the feature branch artifact, but `main` is the permanent update upstream.)*

---

## 3. Recommended Usage

### Recommended Entrypoint
For VR and high-resolution video search, navigate directly to Eporner with the native quality filter active:
- [https://www.eporner.com/cat/vr-porn/?quality=2160](https://www.eporner.com/cat/vr-porn/?quality=2160)

### How It Works
1. **Pages with `quality=2160` (Native 4K Prefilter)**:
   - The Companion detects `quality=2160` in the URL automatically.
   - The toolbar shows `✓ Eporner 4K+` (no manual click needed).
   - Local 4K validation runs as a leakage guard against the DOM.
   - AV1 probing starts automatically for all 4K+ cards with viewport-prioritized queuing.
2. **General Pages (without `quality=2160`)**:
   - On regular category, channel, or search pages, cards below 4K remain visible on page load.
   - Click the **`[筛选 4K+]`** button in the floating toolbar to permanently remove `<4K` cards and begin AV1 probing on the remaining candidates.
3. **Toggle `[只看 AV1]`**:
   - Click to hide confirmed NO-AV1 cards. Unprobed, pending, or error cards remain visible (Optimistic Visibility).

---

## 4. Toolbar & Badge Semantics

### Floating Toolbar

| Control / Display | Meaning |
| :--- | :--- |
| **`✓ Eporner 4K+`** | Upstream native 4K filter detected from URL (`quality=2160`); Hard Filter & AV1 probing active. |
| **`[筛选 4K+]`** | One-way activation action on non-filtered pages. Clicking permanently deletes `<4K` cards from the DOM and begins AV1 probing. |
| **`[只看 AV1]`** | Soft filter toggle. When enabled, hides cards confirmed to lack AV1 streams. |
| **`4K: N`** | Count of 4K+ candidate cards on the current page. |
| **`AV1: X (Y 4K)`** | Count of confirmed AV1 videos (`X`) and count of confirmed 4K AV1 videos (`Y`). |
| **`探测: N`** | Number of candidate cards currently in the probing queue. |
| **`失败: N`** | Number of cards whose probing failed after auto-retries. |

### Card Format Badges

| Badge Text | Color / Style | Meaning |
| :--- | :--- | :--- |
| **`4K · AV1 4K`** | Gold / Green | Video is confirmed 4K and provides **2160p AV1** rendition. |
| **`4K · AV1 1080p`** | Blue | Video is 4K, but AV1 is only available up to **1080p**. |
| **`4K · NO AV1`** | Gray | Video has been probed and confirmed to have **no AV1** stream. |
| **`4K · ⏳`** | Pulsing Cyan | Currently probing detail page in background. |
| **`4K · ⚠️ 重试`** | Red (Clickable) | Network or parsing error occurred. Click the badge to retry probing manually. |

---

## 5. Caching Strategy

- **Capability Cache**: Probed rendition capabilities (`detected` and `no_av1`) are cached in Tampermonkey persistent storage (`GM_setValue` / `GM_getValue`).
- **Cache TTL**: 7 days (604,800,000 ms). Expired records are automatically re-probed.
- **Error Handling**: `error` and `unknown` states are **never** persisted as `no_av1`, ensuring transient network hiccups can be retried immediately.

---

## 6. Automatic Updates

The production userscript includes Tampermonkey metadata headers:
```javascript
// @updateURL   https://raw.githubusercontent.com/carllx/javr-sourcecut/main/userscripts/eporner-companion.user.js
// @downloadURL https://raw.githubusercontent.com/carllx/javr-sourcecut/main/userscripts/eporner-companion.user.js
```
- Tampermonkey automatically polls `@updateURL` and prompts/applies updates whenever the `@version` header is incremented on `main`.
- Users do not need to manually copy-paste script code after initial installation.

---

## 7. Known Warnings

### Chromium AbortError on Card Removal
In the browser developer console, you may occasionally observe:
```text
Uncaught (in promise) AbortError: The play() request was interrupted because the media was removed from the document.
```

#### Explanation
- **Cause**: Eporner's native page scripts trigger asynchronous `HTMLMediaElement.play()` on video thumbnail hover or dynamic initialization. When Companion's Hard Filter removes sub-4K video cards from the DOM, Chromium automatically aborts any pending `play()` promise associated with the detached video element.
- **Classification**: This is a **benign, non-blocking browser warning** under the following verified conditions:
  1. Kept 4K candidate videos continue to function and play normally.
  2. Companion floating toolbar, format badges, and AV1 probing operate without interruption.
  3. No persistent functional errors or page crashes occur.

> [!IMPORTANT]
> **Design Note**: Do not downgrade Hard Filter to a "soft hide" or inject global `unhandledrejection` suppressors solely to silence this browser warning. If actual playback of retained videos or Companion functionality is impacted in the future, investigate as a dedicated issue.

---

## 8. Troubleshooting

| Symptom | Probable Cause | Resolution |
| :--- | :--- | :--- |
| **Floating Toolbar does not appear** | Tampermonkey script disabled or URL pattern mismatch. | Check that Tampermonkey is active and the URL matches `*://*.eporner.com/*`. |
| **All cards stuck in `Pending` / `Error`** | Network connectivity issue or aggressive rate-limiting. | Prober uses limited concurrency (2) and auto-backoff (up to 2 retries). Check network tab, or click the `4K · ⚠️ 重试` badge to trigger a manual probe. |
| **Raw GitHub URL does not open Tampermonkey install dialog** | Browser displaying raw text instead of handing off to Tampermonkey. | In Tampermonkey dashboard, go to *Utilities -> Install from URL*, paste the raw URL, and click *Install*. |
| **Distinguishing benign `AbortError` from real bugs** | Console shows `AbortError` vs other errors. | `AbortError` mentioning `media was removed from the document` is expected when sub-4K cards are deleted. Any error mentioning `GM_xmlhttpRequest`, `TypeError`, or failed parsing should be reported as a bug. |
