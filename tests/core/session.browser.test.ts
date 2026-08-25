import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  findBrowserExecutable,
  extractEpornerCookiesFromProfile,
} from "../../src/core/session.js";

describe("Browser Integration CDP Smoke", () => {
  it("verifies DevToolsActivePort, page target connection, URL-scoped cookies, and graceful shutdown", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "javr-cdp-smoke-"));
    const testProfile = path.join(tmpDir, "cdp-smoke-profile");
    await fs.mkdir(testProfile, { recursive: true });

    try {
      const browser = findBrowserExecutable();

      // 1. Launch browser to initialize cookies in profile
      const initProc = spawn(
        browser.executablePath,
        [
          `--user-data-dir=${testProfile}`,
          "--remote-debugging-port=0",
          "--remote-debugging-address=127.0.0.1",
          "--headless=new",
          "--no-first-run",
          "--no-default-browser-check",
          "about:blank",
        ],
        { stdio: "ignore" }
      );

      // Read DevToolsActivePort
      const activePortFile = path.join(testProfile, "DevToolsActivePort");
      let port = 0;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          const content = await fs.readFile(activePortFile, "utf-8");
          const lines = content.trim().split(/\r?\n/);
          if (lines.length >= 2) {
            port = parseInt(lines[0].trim(), 10);
            if (port > 0) break;
          }
        } catch {}
      }

      expect(port).toBeGreaterThan(0);

      // Connect to Page target and set test cookies via CDP Network.setCookie
      const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await listRes.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
      const pageWsUrl = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
      expect(pageWsUrl).toBeTruthy();

      const ws = new WebSocket(pageWsUrl!);
      await new Promise((r) => (ws.onopen = r));

      // Set 1 Eporner cookie and 1 unrelated domain cookie
      await new Promise((resolve) => {
        ws.send(
          JSON.stringify({
            id: 1,
            method: "Network.setCookie",
            params: {
              name: "EPRNS_TEST",
              value: "test_token_123",
              domain: ".eporner.com",
              path: "/",
              httpOnly: true,
              secure: true,
              expires: Math.floor(Date.now() / 1000) + 86400,
            },
          })
        );
        ws.send(
          JSON.stringify({
            id: 2,
            method: "Network.setCookie",
            params: {
              name: "OTHER_COOKIE",
              value: "unrelated_val",
              domain: "otherdomain.com",
              path: "/",
              expires: Math.floor(Date.now() / 1000) + 86400,
            },
          })
        );
        setTimeout(resolve, 300);
      });

      ws.close();

      // Close init browser
      const versionRes = await fetch(`http://127.0.0.1:${port}/json/version`);
      const versionJson = (await versionRes.json()) as { webSocketDebuggerUrl?: string };
      const browserWs = new WebSocket(versionJson.webSocketDebuggerUrl!);
      await new Promise((r) => (browserWs.onopen = r));
      const closePromise = new Promise<void>((r) => {
        initProc.once("exit", () => r());
        initProc.once("close", () => r());
      });
      browserWs.send(JSON.stringify({ id: 999, method: "Browser.close" }));
      await closePromise;

      // 2. Now run the production extractEpornerCookiesFromProfile helper on the profile
      const extracted = await extractEpornerCookiesFromProfile(testProfile);

      // Verify URL scoping: Eporner cookie included, unrelated domain excluded
      expect(extracted.some((c) => c.name === "EPRNS_TEST")).toBe(true);
      expect(extracted.some((c) => c.name === "OTHER_COOKIE")).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30000);
});
