import { detectAstalaVrPage, parseAstalaVrDomRenditions } from "./astalavr.js";

export class AstalaVrProbeApp {
  private panelElement: HTMLElement | null = null;
  private statusElement: HTMLElement | null = null;
  private contentElement: HTMLElement | null = null;
  private mutationObserver?: MutationObserver;
  private pollInterval?: ReturnType<typeof setInterval>;

  init(): void {
    this.createPanel();
    this.checkAndRender();

    // Observe DOM updates for dynamic rendering or challenge resolution
    if (typeof MutationObserver !== "undefined") {
      this.mutationObserver = new MutationObserver(() => {
        this.checkAndRender();
      });
      this.mutationObserver.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
      });
    }

    // Periodic check in case of video tag hydration
    this.pollInterval = setInterval(() => {
      this.checkAndRender();
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

  private checkAndRender(): void {
    if (!this.statusElement || !this.contentElement) return;

    const detection = detectAstalaVrPage(document);

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

    const renditions = parseAstalaVrDomRenditions(document);
    const assetId = detection.videoId || "unknown";

    this.statusElement.textContent = "STATUS: REAL_PAGE_ACTIVE";
    this.statusElement.style.backgroundColor = "#065f46";
    this.statusElement.style.color = "#d1fae5";

    let html = `
      <div style="margin-bottom: 6px;"><strong>ASSET_ID:</strong> ${assetId}</div>
      <div style="margin-bottom: 8px;"><strong>RENDITION_COUNT:</strong> ${renditions.length}</div>
    `;

    if (renditions.length === 0) {
      html += `<div style="color: #f87171;">&lt;dl8-video&gt; found, but no &lt;source&gt; tags rendered yet.</div>`;
    } else {
      html += `<div style="border-top: 1px solid #374151; padding-top: 6px; margin-bottom: 8px;">`;
      for (const r of renditions) {
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

    // Add Copy Renditions button if renditions exist
    if (renditions.length > 0) {
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
      copyBtn.style.marginTop = "4px";

      copyBtn.onclick = () => {
        const payload = JSON.stringify(
          {
            assetId,
            renditions: renditions.map((r) => ({
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

      this.contentElement.appendChild(copyBtn);
    }
  }

  destroy(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.mutationObserver?.disconnect();
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
