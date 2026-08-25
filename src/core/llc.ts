import fs from "node:fs/promises";
import path from "node:path";
import type { TimeRange } from "./mp4/types.js";

export interface LlcCutSegment {
  start?: number;
  end?: number;
  name?: string;
  selected?: boolean;
  tags?: Record<string, unknown>;
}

export interface LlcProjectFile {
  version?: number;
  mediaFileName?: string;
  cutSegments?: LlcCutSegment[];
  [key: string]: unknown;
}

/**
 * Parses JSON5 / relaxed JavaScript object literal syntax often produced by LosslessCut (.llc)
 */
export function parseRelaxedJson(input: string): unknown {
  let pos = 0;
  const len = input.length;

  function skipWhitespaceAndComments() {
    while (pos < len) {
      const ch = input[pos];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        pos++;
      } else if (ch === "/" && pos + 1 < len && input[pos + 1] === "/") {
        pos += 2;
        while (pos < len && input[pos] !== "\n" && input[pos] !== "\r") {
          pos++;
        }
      } else if (ch === "/" && pos + 1 < len && input[pos + 1] === "*") {
        pos += 2;
        while (pos + 1 < len && !(input[pos] === "*" && input[pos + 1] === "/")) {
          pos++;
        }
        pos += 2;
      } else {
        break;
      }
    }
  }

  function parseValue(): unknown {
    skipWhitespaceAndComments();
    if (pos >= len) {
      throw new SyntaxError("Unexpected end of input");
    }
    const ch = input[pos];
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === "'" || ch === '"') return parseString();
    if (ch === "-" || ch === "+" || (ch >= "0" && ch <= "9") || ch === ".") return parseNumber();
    if (input.startsWith("true", pos)) {
      pos += 4;
      return true;
    }
    if (input.startsWith("false", pos)) {
      pos += 5;
      return false;
    }
    if (input.startsWith("null", pos)) {
      pos += 4;
      return null;
    }
    if (input.startsWith("undefined", pos)) {
      pos += 9;
      return undefined;
    }
    if (input.startsWith("NaN", pos)) {
      pos += 3;
      return NaN;
    }
    if (input.startsWith("Infinity", pos)) {
      pos += 8;
      return Infinity;
    }

    const id = parseIdentifier();
    if (id !== "") return id;

    throw new SyntaxError(`Unexpected character '${ch}' at position ${pos}`);
  }

  function parseObject(): Record<string, unknown> {
    pos++; // consume '{'
    const obj: Record<string, unknown> = {};
    skipWhitespaceAndComments();
    if (pos < len && input[pos] === "}") {
      pos++;
      return obj;
    }

    while (pos < len) {
      skipWhitespaceAndComments();
      if (input[pos] === "}") {
        pos++;
        return obj;
      }

      let key: string;
      if (input[pos] === "'" || input[pos] === '"') {
        key = parseString();
      } else {
        key = parseIdentifier();
      }

      if (!key) {
        throw new SyntaxError(`Expected object key at position ${pos}`);
      }

      skipWhitespaceAndComments();
      if (pos >= len || input[pos] !== ":") {
        throw new SyntaxError(`Expected ':' after key "${key}" at position ${pos}`);
      }
      pos++; // consume ':'

      const val = parseValue();
      obj[key] = val;

      skipWhitespaceAndComments();
      if (pos < len && input[pos] === ",") {
        pos++; // consume ','
        skipWhitespaceAndComments();
        if (pos < len && input[pos] === "}") {
          pos++;
          return obj;
        }
      } else if (pos < len && input[pos] === "}") {
        pos++;
        return obj;
      } else {
        throw new SyntaxError(`Expected ',' or '}' at position ${pos}`);
      }
    }
    throw new SyntaxError("Unterminated object");
  }

  function parseArray(): unknown[] {
    pos++; // consume '['
    const arr: unknown[] = [];
    skipWhitespaceAndComments();
    if (pos < len && input[pos] === "]") {
      pos++;
      return arr;
    }

    while (pos < len) {
      skipWhitespaceAndComments();
      if (input[pos] === "]") {
        pos++;
        return arr;
      }

      const val = parseValue();
      arr.push(val);

      skipWhitespaceAndComments();
      if (pos < len && input[pos] === ",") {
        pos++;
        skipWhitespaceAndComments();
        if (pos < len && input[pos] === "]") {
          pos++;
          return arr;
        }
      } else if (pos < len && input[pos] === "]") {
        pos++;
        return arr;
      } else {
        throw new SyntaxError(`Expected ',' or ']' at position ${pos}`);
      }
    }
    throw new SyntaxError("Unterminated array");
  }

  function parseString(): string {
    const quote = input[pos];
    pos++; // consume quote
    let str = "";
    while (pos < len) {
      const ch = input[pos];
      if (ch === "\\") {
        pos++;
        if (pos >= len) throw new SyntaxError("Unterminated string escape");
        const esc = input[pos];
        if (esc === "n") str += "\n";
        else if (esc === "r") str += "\r";
        else if (esc === "t") str += "\t";
        else if (esc === "b") str += "\b";
        else if (esc === "f") str += "\f";
        else if (esc === "\\") str += "\\";
        else if (esc === "'") str += "'";
        else if (esc === '"') str += '"';
        else if (esc === "u" && pos + 4 < len) {
          const hex = input.slice(pos + 1, pos + 5);
          str += String.fromCharCode(parseInt(hex, 16));
          pos += 4;
        } else {
          str += esc;
        }
        pos++;
      } else if (ch === quote) {
        pos++; // consume quote
        return str;
      } else {
        str += ch;
        pos++;
      }
    }
    throw new SyntaxError("Unterminated string");
  }

  function parseNumber(): number {
    const start = pos;
    if (input[pos] === "-" || input[pos] === "+") pos++;
    while (
      pos < len &&
      ((input[pos] >= "0" && input[pos] <= "9") ||
        input[pos] === "." ||
        input[pos] === "e" ||
        input[pos] === "E" ||
        input[pos] === "-" ||
        input[pos] === "+")
    ) {
      pos++;
    }
    const numStr = input.slice(start, pos);
    const num = Number(numStr);
    if (isNaN(num)) {
      throw new SyntaxError(`Invalid number "${numStr}" at position ${start}`);
    }
    return num;
  }

  function parseIdentifier(): string {
    const start = pos;
    while (pos < len && /[a-zA-Z0-9_$]/.test(input[pos])) {
      pos++;
    }
    return input.slice(start, pos);
  }

  const result = parseValue();
  skipWhitespaceAndComments();
  if (pos < len) {
    throw new SyntaxError(`Unexpected trailing character '${input[pos]}' at position ${pos}`);
  }
  return result;
}

export function parseLlcContent(rawContent: string): LlcProjectFile {
  const trimmed = rawContent.trim();
  if (!trimmed) {
    throw new Error("LosslessCut project file content is empty");
  }

  try {
    return JSON.parse(trimmed) as LlcProjectFile;
  } catch {
    // Fall back to relaxed JSON parser for JSON5 / JS object syntax
    return parseRelaxedJson(trimmed) as LlcProjectFile;
  }
}

export function normalizeLlcCutSegments(llcProject: LlcProjectFile): TimeRange {
  if (!llcProject.cutSegments || !Array.isArray(llcProject.cutSegments) || llcProject.cutSegments.length === 0) {
    throw new Error("LosslessCut project file does not contain any cutSegments");
  }

  // If there's a selected segment, prioritize it; otherwise pick the first segment
  const selectedSegment = llcProject.cutSegments.find((seg) => seg.selected === true) || llcProject.cutSegments[0];

  const startSeconds = selectedSegment.start !== undefined ? Number(selectedSegment.start) : 0;
  if (isNaN(startSeconds) || startSeconds < 0) {
    throw new Error(`Invalid cut segment start time: ${selectedSegment.start}`);
  }

  if (selectedSegment.end === undefined || isNaN(Number(selectedSegment.end))) {
    throw new Error(`Missing or invalid cut segment end time: ${selectedSegment.end}`);
  }

  const endSeconds = Number(selectedSegment.end);
  if (endSeconds <= startSeconds) {
    throw new Error(
      `Cut segment end time (${endSeconds}s) must be greater than start time (${startSeconds}s)`
    );
  }

  return {
    startSeconds,
    endSeconds,
  };
}

export async function findLlcFileInWorkspace(
  workspaceDir: string,
  expectedLlcPath?: string
): Promise<string> {
  if (expectedLlcPath) {
    try {
      const stat = await fs.stat(expectedLlcPath);
      if (stat.isFile()) {
        return expectedLlcPath;
      }
    } catch {
      // expectedLlcPath did not exist, search workspace directory
    }
  }

  const entries = await fs.readdir(workspaceDir);
  // Prioritize *.proxy-proj.llc, then *.proj.llc, then any *.llc
  const llcFiles = entries.filter((file) => file.toLowerCase().endsWith(".llc"));
  if (llcFiles.length === 0) {
    throw new Error(
      `No LosslessCut (.llc) file found in workspace directory: ${workspaceDir}`
    );
  }

  const proxyProj = llcFiles.find((f) => f.toLowerCase().endsWith(".proxy-proj.llc"));
  if (proxyProj) {
    return path.join(workspaceDir, proxyProj);
  }

  const proj = llcFiles.find((f) => f.toLowerCase().endsWith("-proj.llc") || f.toLowerCase().endsWith(".proj.llc"));
  if (proj) {
    return path.join(workspaceDir, proj);
  }

  return path.join(workspaceDir, llcFiles[0]);
}

export async function loadAndNormalizeLlc(
  llcPathOrWorkspace: string
): Promise<{ timeRange: TimeRange; project: LlcProjectFile; resolvedPath: string }> {
  let resolvedPath = path.resolve(llcPathOrWorkspace);
  const stat = await fs.stat(resolvedPath);
  if (stat.isDirectory()) {
    resolvedPath = await findLlcFileInWorkspace(resolvedPath);
  }

  const raw = await fs.readFile(resolvedPath, "utf-8");
  const project = parseLlcContent(raw);
  const timeRange = normalizeLlcCutSegments(project);

  return {
    timeRange,
    project,
    resolvedPath,
  };
}
