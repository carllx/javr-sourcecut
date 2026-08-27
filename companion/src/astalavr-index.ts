import {
  detectAstalaVrPage,
  parseAstalaVrDomRenditions,
  testBrowserMedia720p,
  inspectActivePlayer,
  inspectPlaybackResources,
  testActualPlayback720p,
  testActualPlayback720pRange,
  testActualPlaybackGmRange,
  testActualPlaybackPaired1MiB,
  type AstalaVrRenditionSummary,
} from "./astalavr.js";

export class AstalaVrProbeApp {
  private panelElement: HTMLElement | null = null;
  private statusElement: HTMLElement | null = null;
  private contentElement: HTMLElement | null = null;
  private pollInterval?: ReturnType<typeof setInterval>;

  // Page-local in-memory rendition cache
  private cachedAssetId: string | null = null;
  private cachedRenditions: AstalaVrRenditionSummary[] = [];
  private isTestingBrowserMedia = false;

  init(): void {
    this.createPanel();
    this.checkAndRender();

    // Periodic check handles Cloudflare settlement, dl8-video hydration, and source element updates
    this.pollInterval = setInterval(() => {
      if (!this.isTestingBrowserMedia) {
        this.checkAndRender();
      }
    }, 1000);
  }

  private createPanel(): void {
    if (document.getElementById("astalavr-sourcecut-probe-panel")) return;

    const panel = document.createElement("div");
    panel.id = "astalavr-sourcecut-probe-panel";
    panel.style.position = "fixed";
    panel.style.bottom = "20px";
    panel.style.right = "20px";
    panel.style.width = "380px";
    panel.style.backgroundColor = "rgba(20, 24, 33, 0.95)";
    panel.style.color = "#f3f4f6";
    panel.style.border = "1px solid #3b82f6";
    panel.style.borderRadius = "8px";
    panel.style.padding = "14px 16px";
    panel.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    panel.style.fontSize = "12px";
    panel.style.lineHeight = "1.5";
    panel.style.zIndex = "999999";
    panel.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.5)";

    const header = document.createElement("div");
    header.style.fontWeight = "bold";
    header.style.fontSize = "13px";
    header.style.color = "#60a5fa";
    header.style.marginBottom = "8px";
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.textContent = "ASTALAVR SOURCECUT PROBE";

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.style.background = "none";
    closeBtn.style.border = "none";
    closeBtn.style.color = "#9ca3af";
    closeBtn.style.fontSize = "16px";
    closeBtn.style.cursor = "pointer";
    closeBtn.onclick = () => this.destroy();
    header.appendChild(closeBtn);

    const statusEl = document.createElement("div");
    statusEl.id = "astalavr-probe-status";
    statusEl.style.marginBottom = "8px";
    statusEl.style.padding = "4px 8px";
    statusEl.style.borderRadius = "4px";
    statusEl.style.backgroundColor = "#374151";

    const contentEl = document.createElement("div");
    contentEl.id = "astalavr-probe-content";

    panel.appendChild(header);
    panel.appendChild(statusEl);
    panel.appendChild(contentEl);

    document.body.appendChild(panel);
    this.panelElement = panel;
    this.statusElement = statusEl;
    this.contentElement = contentEl;
  }

  public checkAndRender(): void {
    if (!this.statusElement || !this.contentElement) return;

    const detection = detectAstalaVrPage(document);
    const assetId = detection.videoId || "unknown";

    // Invalidate memory cache immediately if assetId changes
    if (this.cachedAssetId && this.cachedAssetId !== assetId) {
      this.cachedAssetId = null;
      this.cachedRenditions = [];
    }

    if (detection.status === "WAITING_FOR_REAL_PAGE") {
      this.statusElement.textContent = "STATUS: WAITING_FOR_REAL_PAGE";
      this.statusElement.style.backgroundColor = "#b45309";
      this.statusElement.style.color = "#fef3c7";
      this.contentElement.innerHTML = `<div style="color: #9ca3af;">Cloudflare challenge / verification active.<br>Awaiting manual challenge resolution...</div>`;
      return;
    }

    if (detection.status === "WAITING_FOR_VIDEO_DOM") {
      this.statusElement.textContent = "STATUS: WAITING_FOR_VIDEO_DOM";
      this.statusElement.style.backgroundColor = "#4b5563";
      this.statusElement.style.color = "#f3f4f6";
      this.contentElement.innerHTML = `<div style="color: #9ca3af;">Page loaded, waiting for &lt;dl8-video&gt; element...</div>`;
      return;
    }

    const liveRenditions = parseAstalaVrDomRenditions(document);
    let effectiveRenditions: AstalaVrRenditionSummary[] = [];
    let renditionSource: "LIVE_DOM" | "MEMORY_CACHE" = "LIVE_DOM";

    if (liveRenditions.length > 0) {
      effectiveRenditions = liveRenditions;
      this.cachedAssetId = assetId;
      this.cachedRenditions = liveRenditions;
      renditionSource = "LIVE_DOM";
    } else if (this.cachedAssetId === assetId && this.cachedRenditions.length > 0) {
      effectiveRenditions = this.cachedRenditions;
      renditionSource = "MEMORY_CACHE";
    } else {
      effectiveRenditions = [];
      renditionSource = "LIVE_DOM";
    }

    this.statusElement.textContent = "STATUS: REAL_PAGE_ACTIVE";
    this.statusElement.style.backgroundColor = "#065f46";
    this.statusElement.style.color = "#d1fae5";

    // Check playback resource detection safely from performance entries
    const perfEntries =
      typeof performance !== "undefined" && typeof performance.getEntriesByType === "function"
        ? (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
        : [];

    let actualPlaybackDetected = false;
    const rendition720p = effectiveRenditions.find((r) => r.resolution === "720p" || r.height === 720);
    if (rendition720p) {
      try {
        const cParsed = new URL(rendition720p.fullDirectUrl);
        const cachedPath = cParsed.pathname.toLowerCase();
        for (const entry of perfEntries) {
          const rawUrl = entry.name;
          if (rawUrl && typeof rawUrl === "string") {
            const p = new URL(rawUrl, typeof window !== "undefined" ? window.location.href : "https://astalavr.com");
            const initiator = (entry.initiatorType || "").toLowerCase();
            if (
              (initiator === "video" || initiator === "media") &&
              p.hostname === "cdn3.astalavr.com" &&
              p.pathname.toLowerCase() === cachedPath
            ) {
              actualPlaybackDetected = true;
              break;
            }
          }
        }
      } catch {}
    }

    let html = `
      <div style="margin-bottom: 4px;"><strong>ASSET_ID:</strong> ${assetId}</div>
      <div style="margin-bottom: 4px;"><strong>RENDITION_COUNT:</strong> ${effectiveRenditions.length}</div>
      <div style="margin-bottom: 8px;"><strong>RENDITION_SOURCE:</strong> ${renditionSource}</div>
    `;

    if (effectiveRenditions.length === 0) {
      html += `<div style="color: #f87171;">&lt;dl8-video&gt; found, but no &lt;source&gt; tags rendered yet.</div>`;
    } else {
      html += `<div style="border-top: 1px solid #374151; padding-top: 6px; margin-bottom: 8px;">`;
      for (const r of effectiveRenditions) {
        html += `
          <div style="margin-bottom: 4px; padding: 4px; background: rgba(255,255,255,0.05); border-radius: 4px;">
            <div><span style="color: #34d399; font-weight: bold;">[${r.resolution}]</span> ${r.vcodec} (${r.mimeType})</div>
            <div style="color: #9ca3af; font-size: 11px;">Host: ${r.mediaHostname}</div>
          </div>
        `;
      }
      html += `</div>`;

      // Browser transport status section
      html += `
        <div id="astalavr-transport-status-section" style="border-top: 1px solid #374151; padding-top: 6px; margin-bottom: 8px;">
          <div style="font-weight: bold; color: #60a5fa; margin-bottom: 4px;">Browser transport</div>
          <div style="font-size: 11px; line-height: 1.6;">
            <div>Actual playback: <strong>${actualPlaybackDetected ? "DETECTED" : "WAITING"}</strong></div>
            <div>Control metadata: <strong>${actualPlaybackDetected ? "VERIFIED" : "NOT VERIFIED"}</strong></div>
            <div>Range data: <strong>${actualPlaybackDetected ? "VERIFIED" : "NOT VERIFIED"}</strong></div>
          </div>
        </div>
      `;
    }

    this.contentElement.innerHTML = html;

    // Add collapsible Developer diagnostics section if renditions exist
    if (effectiveRenditions.length > 0) {
      const devDetails = document.createElement("details");
      devDetails.id = "astalavr-dev-diagnostics";
      devDetails.style.marginTop = "8px";
      devDetails.style.borderTop = "1px solid #374151";
      devDetails.style.paddingTop = "6px";

      const devSummary = document.createElement("summary");
      devSummary.id = "astalavr-dev-diagnostics-summary";
      devSummary.textContent = "Developer diagnostics";
      devSummary.style.cursor = "pointer";
      devSummary.style.color = "#9ca3af";
      devSummary.style.fontWeight = "bold";
      devSummary.style.fontSize = "11px";
      devSummary.style.userSelect = "none";
      devSummary.style.marginBottom = "6px";
      devDetails.appendChild(devSummary);

      const devContainer = document.createElement("div");
      devContainer.id = "astalavr-dev-diagnostics-content";
      devContainer.style.display = "flex";
      devContainer.style.flexDirection = "column";
      devContainer.style.gap = "6px";
      devContainer.style.marginTop = "6px";

      // Test paired 1MiB Range button (the only remaining diagnostic)
      const testPairBtn = document.createElement("button");
      testPairBtn.id = "astalavr-test-pair-range-btn";
      testPairBtn.textContent = "▶ Test paired 1MiB Range";
      testPairBtn.style.width = "100%";
      testPairBtn.style.padding = "6px 12px";
      testPairBtn.style.backgroundColor = "#d97706";
      testPairBtn.style.color = "#ffffff";
      testPairBtn.style.border = "none";
      testPairBtn.style.borderRadius = "4px";
      testPairBtn.style.cursor = "pointer";
      testPairBtn.style.fontWeight = "bold";

      const testPairResultEl = document.createElement("div");
      testPairResultEl.id = "astalavr-test-pair-range-result";
      testPairResultEl.style.fontSize = "11px";
      testPairResultEl.style.padding = "6px 8px";
      testPairResultEl.style.borderRadius = "4px";
      testPairResultEl.style.display = "none";
      testPairResultEl.style.lineHeight = "1.4";

      testPairBtn.onclick = () => {
        // Freeze scheduled polling immediately
        this.isTestingBrowserMedia = true;
        if (this.pollInterval) {
          clearInterval(this.pollInterval);
          this.pollInterval = undefined;
        }

        testPairBtn.disabled = true;
        testPairBtn.textContent = "⏳ Testing paired 1MiB (GM metadata + page data)...";
        testPairResultEl.style.display = "none";

        testActualPlaybackPaired1MiB(
          effectiveRenditions,
          typeof performance !== "undefined" ? performance : ({} as any)
        ).then((res) => {
          testPairBtn.disabled = false;
          testPairBtn.textContent = "▶ Test paired 1MiB Range";
          testPairResultEl.style.display = "block";

          if (!res.actualPlaybackUrlFound) {
            testPairResultEl.style.backgroundColor = "#1e293b";
            testPairResultEl.style.color = "#f1f5f9";
            testPairResultEl.innerHTML = `<div><strong>PAIR_ACTUAL_PLAYBACK_URL_FOUND=</strong>NO</div><div>(No matching video resource found in performance entries yet. Please start playback first.)</div>`;
            return;
          }

          if (res.pass) {
            testPairResultEl.style.backgroundColor = "#065f46";
            testPairResultEl.style.color = "#d1fae5";
            testPairResultEl.innerHTML = `
              <div><strong>PAIR_ACTUAL_PLAYBACK_URL_FOUND=</strong>YES</div>
              <div><strong>PAIR_RANGE_TEST=</strong>PASS</div>
              <div style="margin-top: 4px; border-top: 1px solid rgba(255,255,255,0.2); padding-top: 2px;"><strong>GM_METADATA_STATUS=</strong>${res.gmMetadataStatus ?? "unknown"}</div>
              <div><strong>GM_CONTENT_RANGE_PRESENT=</strong>${res.gmContentRangePresent ? "YES" : "NO"}</div>
              <div><strong>GM_CONTENT_RANGE_MATCH=</strong>${res.gmContentRangeMatch ? "YES" : "NO"}</div>
              <div><strong>GM_TOTAL_FILE_SIZE_PARSED=</strong>${res.gmTotalFileSizeParsed ? "YES" : "NO"}</div>
              <div><strong>GM_ABORTED_AT_HEADERS=</strong>${res.gmAbortedAtHeaders ? "YES" : "NO"}</div>
              <div style="margin-top: 4px; border-top: 1px solid rgba(255,255,255,0.2); padding-top: 2px;"><strong>PAGE_DATA_STATUS=</strong>${res.pageDataStatus ?? "unknown"}</div>
              <div><strong>PAGE_CONTENT_LENGTH_PRESENT=</strong>${res.pageContentLengthPresent ? "YES" : "NO"}</div>
              <div><strong>PAGE_CONTENT_LENGTH_MATCH=</strong>${res.pageContentLengthMatch ? "YES" : "NO"}</div>
              <div><strong>PAGE_BYTES_READ=</strong>${res.pageBytesRead ?? 0}</div>
              <div><strong>PAGE_MAX_BYTES_READ=</strong>${res.pageMaxBytesRead}</div>
            `;
          } else {
            testPairResultEl.style.backgroundColor = "#7f1d1d";
            testPairResultEl.style.color = "#fee2e2";
            let failDetails = `
              <div><strong>PAIR_ACTUAL_PLAYBACK_URL_FOUND=</strong>YES</div>
              <div><strong>PAIR_RANGE_TEST=</strong>FAIL</div>
              <div><strong>PAIR_FAILURE_KIND=</strong>${res.pairFailureKind || "UNKNOWN"}</div>
            `;
            if (res.gmMetadataStatus !== undefined) {
              failDetails += `<div style="margin-top: 4px; border-top: 1px solid rgba(255,255,255,0.2); padding-top: 2px;"><strong>GM_METADATA_STATUS=</strong>${res.gmMetadataStatus}</div>`;
            }
            if (res.gmContentRangePresent !== undefined) {
              failDetails += `<div><strong>GM_CONTENT_RANGE_PRESENT=</strong>${res.gmContentRangePresent ? "YES" : "NO"}</div>`;
            }
            if (res.gmContentRangeMatch !== undefined) {
              failDetails += `<div><strong>GM_CONTENT_RANGE_MATCH=</strong>${res.gmContentRangeMatch ? "YES" : "NO"}</div>`;
            }
            if (res.gmTotalFileSizeParsed !== undefined) {
              failDetails += `<div><strong>GM_TOTAL_FILE_SIZE_PARSED=</strong>${res.gmTotalFileSizeParsed ? "YES" : "NO"}</div>`;
            }
            if (res.gmAbortedAtHeaders !== undefined) {
              failDetails += `<div><strong>GM_ABORTED_AT_HEADERS=</strong>${res.gmAbortedAtHeaders ? "YES" : "NO"}</div>`;
            }
            if (res.pageDataStatus !== undefined) {
              failDetails += `<div style="margin-top: 4px; border-top: 1px solid rgba(255,255,255,0.2); padding-top: 2px;"><strong>PAGE_DATA_STATUS=</strong>${res.pageDataStatus}</div>`;
            }
            if (res.pageContentLengthPresent !== undefined) {
              failDetails += `<div><strong>PAGE_CONTENT_LENGTH_PRESENT=</strong>${res.pageContentLengthPresent ? "YES" : "NO"}</div>`;
            }
            if (res.pageContentLengthMatch !== undefined) {
              failDetails += `<div><strong>PAGE_CONTENT_LENGTH_MATCH=</strong>${res.pageContentLengthMatch ? "YES" : "NO"}</div>`;
            }
            if (res.pageBytesRead !== undefined) {
              failDetails += `<div><strong>PAGE_BYTES_READ=</strong>${res.pageBytesRead}</div>`;
            }
            failDetails += `<div><strong>PAGE_MAX_BYTES_READ=</strong>${res.pageMaxBytesRead}</div>`;
            testPairResultEl.innerHTML = failDetails;
          }
        });
      };

      devContainer.appendChild(testPairBtn);
      devContainer.appendChild(testPairResultEl);
      devDetails.appendChild(devContainer);
      this.contentElement.appendChild(devDetails);
    }
  }

  destroy(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.panelElement?.remove();
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const isAstalaVr = /^astalavr\.com$/i.test(window.location.hostname);
  if (isAstalaVr) {
    const app = new AstalaVrProbeApp();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => app.init());
    } else {
      app.init();
    }
  }
}
