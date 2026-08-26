/**
 * Scoped styles for Eporner Companion UI components
 */
export const COMPANION_CSS = `
/* Floating Toolbar */
.javr-floating-toolbar {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 999999;
  background: rgba(18, 18, 24, 0.92);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  padding: 12px 16px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.3);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 13px;
  color: #f0f0f5;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 260px;
  user-select: none;
  transition: all 0.2s ease;
}

.javr-toolbar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.5px;
  color: #ffd700;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  padding-bottom: 6px;
}

.javr-toolbar-controls {
  display: flex;
  gap: 8px;
}

.javr-btn {
  flex: 1;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.18);
  color: #fff;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  transition: all 0.15s ease;
}

.javr-btn:hover {
  background: rgba(255, 255, 255, 0.16);
  border-color: rgba(255, 255, 255, 0.35);
}

.javr-btn.active {
  background: #2563eb;
  border-color: #3b82f6;
  color: #ffffff;
  box-shadow: 0 0 10px rgba(59, 130, 246, 0.5);
}

.javr-btn.active-gold {
  background: #b45309;
  border-color: #f59e0b;
  color: #ffffff;
  box-shadow: 0 0 10px rgba(245, 158, 11, 0.5);
}

.javr-stats-line {
  font-size: 11px;
  color: #a0a0b0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  padding-top: 4px;
}

.javr-stat-item {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.javr-stat-val {
  font-weight: 600;
  color: #ffffff;
}

.javr-stat-val.gold { color: #f59e0b; }
.javr-stat-val.green { color: #10b981; }
.javr-stat-val.cyan { color: #06b6d4; }
.javr-stat-val.gray { color: #9ca3af; }
.javr-stat-val.red { color: #ef4444; }

/* In-Card Format Badge */
.javr-card-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 100;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.3px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.6);
  pointer-events: auto;
  transition: all 0.2s ease;
}

.javr-badge-4k-av1-4k {
  background: linear-gradient(135deg, #059669 0%, #10b981 100%);
  color: #ffffff;
  border: 1px solid #34d399;
}

.javr-badge-4k-av1-1080p {
  background: linear-gradient(135deg, #0284c7 0%, #0ea5e9 100%);
  color: #ffffff;
  border: 1px solid #38bdf8;
}

.javr-badge-4k-no-av1 {
  background: rgba(35, 35, 45, 0.85);
  color: #9ca3af;
  border: 1px solid rgba(255, 255, 255, 0.15);
}

.javr-badge-probing {
  background: rgba(30, 41, 59, 0.9);
  color: #38bdf8;
  border: 1px solid #0284c7;
  animation: javr-pulse 1.5s infinite ease-in-out;
}

.javr-badge-error {
  background: rgba(127, 29, 29, 0.9);
  color: #fca5a5;
  border: 1px solid #ef4444;
  cursor: pointer;
}

.javr-badge-error:hover {
  background: #dc2626;
  color: #ffffff;
}

@keyframes javr-pulse {
  0% { opacity: 0.6; }
  50% { opacity: 1; }
  100% { opacity: 0.6; }
}

.javr-soft-hidden {
  display: none !important;
}
`;

export function injectStyles(): void {
  if (typeof document === "undefined") return;
  const styleId = "javr-companion-styles";
  if (document.getElementById(styleId)) return;

  const styleEl = document.createElement("style");
  styleEl.id = styleId;
  styleEl.textContent = COMPANION_CSS;
  document.head.appendChild(styleEl);
}
