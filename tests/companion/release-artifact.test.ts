import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..", "..");
const userscriptsDir = path.resolve(rootDir, "userscripts");
const prodUserJs = path.join(userscriptsDir, "eporner-companion.user.js");

describe("Userscript Release Artifact & Update URLs", () => {
  it("verifies production userscript file exists and has valid metadata headers", () => {
    expect(fs.existsSync(prodUserJs)).toBe(true);

    const content = fs.readFileSync(prodUserJs, "utf-8");

    // Check Tampermonkey metadata
    expect(content).toContain("// ==UserScript==");
    expect(content).toContain("// ==/UserScript==");

    // Check stable tracked raw GitHub update & download URLs
    const expectedUrl =
      "https://raw.githubusercontent.com/carllx/javr-sourcecut/main/userscripts/eporner-companion.user.js";
    expect(content).toContain(`// @updateURL    ${expectedUrl}`);
    expect(content).toContain(`// @downloadURL  ${expectedUrl}`);

    // Check grants
    expect(content).toContain("// @grant        GM_getValue");
    expect(content).toContain("// @grant        GM_setValue");
    expect(content).toContain("// @grant        GM_xmlhttpRequest");
  });
});
