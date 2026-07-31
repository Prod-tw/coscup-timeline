import { describe, expect, it } from "vitest";
import { findSourceVideo, pairMarkers, parseObsFilename, sortedMarkers } from "./timeline";
import type { Marker, TimelineVideo } from "./types";

describe("OBS time mapping", () => {
  it("parses a Taipei OBS filename into UTC", () => {
    expect(parseObsFilename("2026-07-31 03-10-34.mkv", 480))
      .toBe(Date.parse("2026-07-30T19:10:34.000Z"));
  });

  it("rejects files outside the agreed filename format", () => {
    expect(parseObsFilename("recording.mkv", 480)).toBeNull();
    expect(parseObsFilename("2026-02-31 03-10-34.mkv", 480)).toBeNull();
  });
});

describe("marker pairing", () => {
  const marker = (key: string, recordedAtMs: number): Marker => ({ key, recordedAtMs, source: "manual" });

  it("reorders and immediately reparities after an insertion", () => {
    const result = sortedMarkers([marker("a", 100), marker("c", 300), marker("b", 200)]);
    expect(result.map((item) => item.key)).toEqual(["a", "b", "c"]);
    expect(pairMarkers(result)).toHaveLength(1);
    expect(pairMarkers(result)[0]).toMatchObject({ start: { key: "a" }, end: { key: "b" } });
  });

  it("leaves the final odd marker unpaired", () => {
    expect(pairMarkers([marker("a", 100), marker("b", 200), marker("c", 300)])).toHaveLength(1);
  });
});

describe("source mapping", () => {
  it("only maps a segment wholly contained in one recording", () => {
    const video: TimelineVideo = {
      path: "/video.mkv", name: "video.mkv", durationMs: 60_000, recordingStartMs: 100_000,
      width: 1920, height: 1080, videoCodec: "h264", audioCodec: "aac", fileSizeBytes: 10,
    };
    expect(findSourceVideo(110_000, 150_000, [video])).toBe(video);
    expect(findSourceVideo(90_000, 150_000, [video])).toBeNull();
  });
});

