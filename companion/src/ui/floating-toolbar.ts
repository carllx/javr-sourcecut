import type { FilterStats } from "../types.js";

export interface FloatingToolbarCallbacks {
  onActivateHardFilter?: () => void;
  onToggleSoftFilter?: (active: boolean) => void;
}

export class FloatingToolbar {
  private container: HTMLElement;
  private hardFilterBtn: HTMLButtonElement;
  private softFilterBtn: HTMLButtonElement;
  private statsContainer: HTMLElement;

  private isHardFilterActive = false;
  private isNative4kActive = false;
  private isSoftFilterActive = false;
  private callbacks: FloatingToolbarCallbacks;

  constructor(callbacks: FloatingToolbarCallbacks = {}) {
    this.callbacks = callbacks;
    this.container = document.createElement("div");
    this.container.className = "javr-floating-toolbar";
    this.container.id = "javr-floating-toolbar";

    // Header
    const header = document.createElement("div");
    header.className = "javr-toolbar-header";
    header.innerHTML = `<span>⚡ Eporner Companion</span><span style="font-size:10px;color:#9ca3af;">v0.1</span>`;
    this.container.appendChild(header);

    // Controls
    const controls = document.createElement("div");
    controls.className = "javr-toolbar-controls";

    this.hardFilterBtn = document.createElement("button");
    this.hardFilterBtn.className = "javr-btn";
    this.hardFilterBtn.textContent = "筛选 4K+";
    this.hardFilterBtn.onclick = () => {
      if (this.isHardFilterActive || this.isNative4kActive) return; // One-way irreversible action
      this.isHardFilterActive = true;
      this.updateButtonStates();
      this.callbacks.onActivateHardFilter?.();
    };

    this.softFilterBtn = document.createElement("button");
    this.softFilterBtn.className = "javr-btn";
    this.softFilterBtn.textContent = "只看 AV1";
    this.softFilterBtn.onclick = () => {
      this.isSoftFilterActive = !this.isSoftFilterActive;
      this.updateButtonStates();
      this.callbacks.onToggleSoftFilter?.(this.isSoftFilterActive);
    };

    controls.appendChild(this.hardFilterBtn);
    controls.appendChild(this.softFilterBtn);
    this.container.appendChild(controls);

    // Stats
    this.statsContainer = document.createElement("div");
    this.statsContainer.className = "javr-stats-line";
    this.statsContainer.innerHTML = `<span>等待筛选...</span>`;
    this.container.appendChild(this.statsContainer);
  }

  mount(root: HTMLElement = document.body): void {
    if (!document.getElementById("javr-floating-toolbar")) {
      root.appendChild(this.container);
    }
  }

  updateStats(stats: FilterStats): void {
    this.statsContainer.innerHTML = `
      <div class="javr-stat-item">4K: <span class="javr-stat-val gold">${stats.total4kPlus}</span></div>
      <div class="javr-stat-item">AV1: <span class="javr-stat-val green">${stats.confirmedAv1}</span> (<span class="javr-stat-val cyan">${stats.confirmed4kAv1} 4K</span>)</div>
      ${stats.probing > 0 ? `<div class="javr-stat-item">探测: <span class="javr-stat-val cyan">${stats.probing}</span></div>` : ""}
      ${stats.errorCount > 0 ? `<div class="javr-stat-item">失败: <span class="javr-stat-val red">${stats.errorCount}</span></div>` : ""}
    `;
  }

  setNative4kActive(active: boolean = true): void {
    this.isNative4kActive = active;
    if (active) {
      this.isHardFilterActive = true;
    }
    this.updateButtonStates();
  }

  setHardFilterActive(active: boolean): void {
    this.isHardFilterActive = active;
    this.updateButtonStates();
  }

  setSoftFilterActive(active: boolean): void {
    this.isSoftFilterActive = active;
    this.updateButtonStates();
  }

  private updateButtonStates(): void {
    if (this.isNative4kActive) {
      this.hardFilterBtn.classList.add("active-gold");
      this.hardFilterBtn.textContent = "✓ Eporner 4K+";
      this.hardFilterBtn.disabled = true;
      this.hardFilterBtn.style.cursor = "default";
      this.hardFilterBtn.title = "Eporner 原生 4K 筛选已启用";
    } else if (this.isHardFilterActive) {
      this.hardFilterBtn.classList.add("active-gold");
      this.hardFilterBtn.textContent = "已筛选 4K+";
      this.hardFilterBtn.disabled = true;
      this.hardFilterBtn.style.cursor = "default";
      this.hardFilterBtn.removeAttribute("title");
    } else {
      this.hardFilterBtn.classList.remove("active-gold");
      this.hardFilterBtn.textContent = "筛选 4K+";
      this.hardFilterBtn.disabled = false;
      this.hardFilterBtn.style.cursor = "pointer";
      this.hardFilterBtn.removeAttribute("title");
    }

    if (this.isSoftFilterActive) {
      this.softFilterBtn.classList.add("active");
    } else {
      this.softFilterBtn.classList.remove("active");
    }
  }

  getElement(): HTMLElement {
    return this.container;
  }
}
