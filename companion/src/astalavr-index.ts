import {
  detectAstalaVrPage,
  parseAstalaVrDomRenditions,
  testBrowserMedia720p,
  inspectActivePlayer,
  inspectPlaybackResources,
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
    }

    this.contentElement.innerHTML = html;

    // Add action buttons if effective renditions exist
    if (effectiveRenditions.length > 0) {
      const btnContainer = document.createElement("div");
      btnContainer.style.display = "flex";
      btnContainer.style.flexDirection = "column";
      btnContainer.style.gap = "6px";
      btnContainer.style.marginTop = "6px";

      const copyBtn = document.createElement("button");
      copyBtn.textContent = "📋 Copy renditions";
      copyBtn.style.width = "100%";
      copyBtn.style.padding = "6px 12px";
      copyBtn.style.backgroundColor = "#2563eb";
      copyBtn.style.color = "#ffffff";
      copyBtn.style.border = "none";
      copyBtn.style.borderRadius = "4px";
      copyBtn.style.cursor = "pointer";
      copyBtn.style.fontWeight = "bold";

      copyBtn.onclick = () => {
        const payload = JSON.stringify(
          {
            assetId,
            renditions: effectiveRenditions.map((r) => ({
              formatId: r.formatId,
              resolution: r.resolution,
              vcodec: r.vcodec,
              mimeType: r.mimeType,
              mediaHostname: r.mediaHostname,
              directUrl: r.fullDirectUrl,
            })),
          },
          null,
          2
        );
        navigator.clipboard.writeText(payload).then(
          () => {
            copyBtn.textContent = "✅ Copied to clipboard!";
            setTimeout(() => {
              copyBtn.textContent = "📋 Copy renditions";
            }, 2000);
          },
          (err) => {
            copyBtn.textContent = "❌ Copy failed";
            console.error("Clipboard write error:", err);
          }
        );
      };

      const rendition720p = effectiveRenditions.find((r) => r.resolution === "720p" || r.height === 720);
      if (rendition720p) {
        const test720Btn = document.createElement("button");
        test720Btn.id = "astalavr-test-720p-btn";
        test720Btn.textContent = "▶ Test 720p in browser";
        test720Btn.style.width = "100%";
        test720Btn.style.padding = "6px 12px";
        test720Btn.style.backgroundColor = "#4f46e5";
        test720Btn.style.color = "#ffffff";
        test720Btn.style.border = "none";
        test720Btn.style.borderRadius = "4px";
        test720Btn.style.cursor = "pointer";
        test720Btn.style.fontWeight = "bold";

        const resultEl = document.createElement("div");
        resultEl.id = "astalavr-test-720p-result";
        resultEl.style.fontSize = "11px";
        resultEl.style.padding = "4px 8px";
        resultEl.style.borderRadius = "4px";
        resultEl.style.display = "none";

        test720Btn.onclick = () => {
          // Freeze scheduled polling immediately so DOM result UI is not destroyed
          this.isTestingBrowserMedia = true;
          if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = undefined;
          }

          test720Btn.disabled = true;
          test720Btn.textContent = "⏳ Testing 720p metadata in browser...";
          resultEl.style.display = "none";

          testBrowserMedia720p(rendition720p.fullDirectUrl).then((res) => {
            test720Btn.disabled = false;
            test720Btn.textContent = "▶ Test 720p in browser";
            resultEl.style.display = "block";

            if (res.pass) {
              resultEl.style.backgroundColor = "#065f46";
              resultEl.style.color = "#d1fae5";
              const durStr = typeof res.duration === "number" ? res.duration.toFixed(2) : "unknown";
              resultEl.innerHTML = `<div><strong>720P_BROWSER_MEDIA_TEST=PASS</strong></div><div>DURATION=${durStr}s</div>`;
            } else {
              resultEl.style.backgroundColor = "#7f1d1d";
              resultEl.style.color = "#fee2e2";
              resultEl.innerHTML = `<div><strong>720P_BROWSER_MEDIA_TEST=FAIL</strong></div><div>MEDIA_ERROR_CODE=${res.errorCode || "UNKNOWN"}</div>`;
            }
          });
        };

        btnContainer.appendChild(test720Btn);
        btnContainer.appendChild(resultEl);
      }

      // Add Inspect active player button
      const inspectBtn = document.createElement("button");
      inspectBtn.id = "astalavr-inspect-player-btn";
      inspectBtn.textContent = "🔍 Inspect active player";
      inspectBtn.style.width = "100%";
      inspectBtn.style.padding = "6px 12px";
      inspectBtn.style.backgroundColor = "#0d9488";
      inspectBtn.style.color = "#ffffff";
      inspectBtn.style.border = "none";
      inspectBtn.style.borderRadius = "4px";
      inspectBtn.style.cursor = "pointer";
      inspectBtn.style.fontWeight = "bold";

      const inspectResultEl = document.createElement("div");
      inspectResultEl.id = "astalavr-inspect-player-result";
      inspectResultEl.style.fontSize = "11px";
      inspectResultEl.style.padding = "6px 8px";
      inspectResultEl.style.borderRadius = "4px";
      inspectResultEl.style.backgroundColor = "#1e293b";
      inspectResultEl.style.color = "#f1f5f9";
      inspectResultEl.style.display = "none";
      inspectResultEl.style.lineHeight = "1.4";

      inspectBtn.onclick = () => {
        // Freeze scheduled polling so inspection result UI is preserved
        this.isTestingBrowserMedia = true;
        if (this.pollInterval) {
          clearInterval(this.pollInterval);
          this.pollInterval = undefined;
        }

        const info = inspectActivePlayer(document, effectiveRenditions);
        inspectResultEl.style.display = "block";

        let resultText = `<div><strong>ACTIVE_PLAYER_FOUND=</strong>${info.activePlayerFound ? "YES" : "NO"}</div>`;
        if (info.activePlayerFound) {
          resultText += `<div><strong>TAG_NAME=</strong>${info.tagName || "unknown"}</div>`;
          resultText += `<div><strong>READY_STATE=</strong>${info.readyState ?? "unknown"}</div>`;
          resultText += `<div><strong>NETWORK_STATE=</strong>${info.networkState ?? "unknown"}</div>`;
          resultText += `<div><strong>PAUSED=</strong>${info.paused !== undefined ? String(info.paused).toUpperCase() : "unknown"}</div>`;
          resultText += `<div><strong>DURATION=</strong>${info.duration !== undefined ? info.duration.toFixed(2) + "s" : "unknown"}</div>`;
          resultText += `<div><strong>VIDEO_WIDTH=</strong>${info.videoWidth ?? "unknown"}</div>`;
          resultText += `<div><strong>VIDEO_HEIGHT=</strong>${info.videoHeight ?? "unknown"}</div>`;
          resultText += `<div style="margin-top: 4px;"><strong>CURRENT_SRC_KIND=</strong>${info.currentSrcKind}</div>`;
          if (info.currentSrcHost) {
            resultText += `<div><strong>CURRENT_SRC_HOST=</strong>${info.currentSrcHost}</div>`;
          }
          if (info.currentSrcPath) {
            resultText += `<div><strong>CURRENT_SRC_PATH=</strong>${info.currentSrcPath}</div>`;
          }
          if (info.currentSrcHasToken !== undefined) {
            resultText += `<div><strong>CURRENT_SRC_HAS_TOKEN=</strong>${info.currentSrcHasToken ? "YES" : "NO"}</div>`;
          }
          resultText += `<div style="margin-top: 4px; color: #38bdf8;"><strong>MATCHED_CACHED_RENDITION=</strong>${info.matchedCachedRendition}</div>`;
        }

        inspectResultEl.innerHTML = resultText;
      };

      btnContainer.appendChild(inspectBtn);
      btnContainer.appendChild(inspectResultEl);

      // Add Inspect playback resources button
      const inspectResBtn = document.createElement("button");
      inspectResBtn.id = "astalavr-inspect-resources-btn";
      inspectResBtn.textContent = "🔍 Inspect playback resources";
      inspectResBtn.style.width = "100%";
      inspectResBtn.style.padding = "6px 12px";
      inspectResBtn.style.backgroundColor = "#0284c7";
      inspectResBtn.style.color = "#ffffff";
      inspectResBtn.style.border = "none";
      inspectResBtn.style.borderRadius = "4px";
      inspectResBtn.style.cursor = "pointer";
      inspectResBtn.style.fontWeight = "bold";

      const inspectResResultEl = document.createElement("div");
      inspectResResultEl.id = "astalavr-inspect-resources-result";
      inspectResResultEl.style.fontSize = "11px";
      inspectResResultEl.style.padding = "6px 8px";
      inspectResResultEl.style.borderRadius = "4px";
      inspectResResultEl.style.backgroundColor = "#1e293b";
      inspectResResultEl.style.color = "#f1f5f9";
      inspectResResultEl.style.display = "none";
      inspectResResultEl.style.lineHeight = "1.4";

      inspectResBtn.onclick = () => {
        // Freeze scheduled polling so inspection result UI is preserved
        this.isTestingBrowserMedia = true;
        if (this.pollInterval) {
          clearInterval(this.pollInterval);
          this.pollInterval = undefined;
        }

        const resInfo = inspectPlaybackResources(document, effectiveRenditions);
        inspectResResultEl.style.display = "block";

        let text = `
          <div><strong>DL8_VIDEO_FOUND=</strong>${resInfo.dl8VideoFound ? "YES" : "NO"}</div>
          <div><strong>DL8_SHADOW_ROOT=</strong>${resInfo.dl8ShadowRoot}</div>
          <div style="margin-top: 4px;"><strong>RESOURCE_MATCH_COUNT=</strong>${resInfo.resourceMatchCount}</div>
        `;

        if (resInfo.resources.length > 0) {
          text += `<div style="border-top: 1px solid #334155; margin-top: 4px; padding-top: 4px;">`;
          resInfo.resources.forEach((r, idx) => {
            const n = idx + 1;
            text += `
              <div style="margin-bottom: 6px; padding: 4px; background: rgba(255,255,255,0.03); border-radius: 4px;">
                <div><strong>RESOURCE_${n}_INITIATOR_TYPE=</strong>${r.initiatorType}</div>
                <div><strong>RESOURCE_${n}_HOST=</strong>${r.host}</div>
                <div><strong>RESOURCE_${n}_PATH=</strong>${r.path}</div>
                <div><strong>RESOURCE_${n}_HAS_TOKEN=</strong>${r.hasToken ? "YES" : "NO"}</div>
                <div style="color: #38bdf8;"><strong>RESOURCE_${n}_MATCHED_RENDITION=</strong>${r.matchedRendition}</div>
                <div><strong>RESOURCE_${n}_DURATION_MS=</strong>${r.durationMs}</div>
                ${r.transferSize !== undefined ? `<div><strong>RESOURCE_${n}_TRANSFER_SIZE=</strong>${r.transferSize}</div>` : ""}
                ${r.encodedBodySize !== undefined ? `<div><strong>RESOURCE_${n}_ENCODED_BODY_SIZE=</strong>${r.encodedBodySize}</div>` : ""}
              </div>
            `;
          });
          text += `</div>`;
        }

        inspectResResultEl.innerHTML = text;
      };

      btnContainer.appendChild(inspectResBtn);
      btnContainer.appendChild(inspectResResultEl);

      btnContainer.appendChild(copyBtn);
      this.contentElement.appendChild(btnContainer);
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
