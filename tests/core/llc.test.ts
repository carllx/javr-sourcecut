import { describe, it, expect } from "vitest";
import {
  parseLlcContent,
  normalizeLlcCutSegments,
  normalizeLlcMultiSegments,
  parseRelaxedJson,
} from "../../src/core/llc.js";

describe("LLC Parser & Normalizer", () => {
  it("parses standard JSON LLC format", () => {
    const jsonStr = JSON.stringify({
      version: 2,
      mediaFileName: "test.mp4",
      cutSegments: [
        {
          start: 10.5,
          end: 25.8,
          name: "clip1",
          selected: true,
        },
      ],
    });

    const project = parseLlcContent(jsonStr);
    expect(project.version).toBe(2);
    expect(project.mediaFileName).toBe("test.mp4");
    expect(project.cutSegments).toHaveLength(1);

    const timeRange = normalizeLlcCutSegments(project);
    expect(timeRange.startSeconds).toBe(10.5);
    expect(timeRange.endSeconds).toBe(25.8);
  });

  it("parses relaxed JS / JSON5 object literal format produced by LosslessCut", () => {
    const relaxed = `
{
  version: 2,
  mediaFileName: 'eporner-y1qUfge13j0 - My Spinster Boss Got Tipsy And To Love Hotel - Ayane Sezaki (1).proxy.mp4',
  cutSegments: [
    {
      start: 1075.922793,
      end: 1451.572984,
      name: '',
      selected: true,
    },
  ],
}
`;
    const project = parseLlcContent(relaxed);
    expect(project.version).toBe(2);
    expect(project.mediaFileName).toBe(
      "eporner-y1qUfge13j0 - My Spinster Boss Got Tipsy And To Love Hotel - Ayane Sezaki (1).proxy.mp4"
    );
    expect(project.cutSegments).toBeDefined();
    expect(project.cutSegments?.[0].start).toBeCloseTo(1075.922793);
    expect(project.cutSegments?.[0].end).toBeCloseTo(1451.572984);

    const timeRange = normalizeLlcCutSegments(project);
    expect(timeRange.startSeconds).toBeCloseTo(1075.922793);
    expect(timeRange.endSeconds).toBeCloseTo(1451.572984);
  });

  it("handles multiple segments and selects the one with selected: true for single-segment normalizer", () => {
    const relaxed = `
{
  version: 2,
  cutSegments: [
    { start: 0, end: 10, selected: false },
    { start: 50.2, end: 80.5, selected: true },
    { start: 100, end: 120 }
  ]
}
`;
    const project = parseLlcContent(relaxed);
    const timeRange = normalizeLlcCutSegments(project);
    expect(timeRange.startSeconds).toBe(50.2);
    expect(timeRange.endSeconds).toBe(80.5);
  });

  it("normalizeLlcMultiSegments parses all authored cutSegments preserving order regardless of selected flag", () => {
    const relaxed = `
{
  version: 2,
  cutSegments: [
    { start: 10.0, end: 20.0, name: 'seg1', selected: false },
    { start: 50.5, end: 75.0, name: 'seg2', selected: true },
    { start: 120.0, end: 150.0, name: 'seg3' }
  ]
}
`;
    const project = parseLlcContent(relaxed);
    const multiSegments = normalizeLlcMultiSegments(project);

    expect(multiSegments).toHaveLength(3);
    expect(multiSegments[0]).toEqual({ startSeconds: 10.0, endSeconds: 20.0 });
    expect(multiSegments[1]).toEqual({ startSeconds: 50.5, endSeconds: 75.0 });
    expect(multiSegments[2]).toEqual({ startSeconds: 120.0, endSeconds: 150.0 });
  });

  it("normalizeLlcMultiSegments preserves authored order even when segments are not in chronological order", () => {
    const relaxed = `
{
  version: 2,
  cutSegments: [
    { start: 100.0, end: 120.0 },
    { start: 10.0, end: 25.0 }
  ]
}
`;
    const project = parseLlcContent(relaxed);
    const multiSegments = normalizeLlcMultiSegments(project);

    expect(multiSegments).toHaveLength(2);
    expect(multiSegments[0]).toEqual({ startSeconds: 100.0, endSeconds: 120.0 });
    expect(multiSegments[1]).toEqual({ startSeconds: 10.0, endSeconds: 25.0 });
  });

  it("throws on empty cutSegments or invalid time range", () => {
    expect(() => parseLlcContent("")).toThrow("empty");
    expect(() => normalizeLlcCutSegments({ cutSegments: [] })).toThrow("does not contain any cutSegments");
    expect(() => normalizeLlcCutSegments({ cutSegments: [{ start: 50, end: 40 }] })).toThrow(
      "greater than start time"
    );
    expect(() => normalizeLlcMultiSegments({ cutSegments: [] })).toThrow("does not contain any cutSegments");
    expect(() =>
      normalizeLlcMultiSegments({
        cutSegments: [
          { start: 10, end: 20 },
          { start: 30, end: 25 },
        ],
      })
    ).toThrow("greater than start time");
  });
});
