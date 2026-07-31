import type { ClipSegment, Marker, TimelineVideo } from "./types";

const OBS_FILENAME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})\.mkv$/i;

export function parseObsFilename(filename: string, utcOffsetMinutes: number): number | null {
  const match = OBS_FILENAME.exec(filename);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const utc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ) - utcOffsetMinutes * 60_000;
  const check = new Date(utc + utcOffsetMinutes * 60_000);
  if (
    check.getUTCFullYear() !== Number(year) ||
    check.getUTCMonth() !== Number(month) - 1 ||
    check.getUTCDate() !== Number(day) ||
    check.getUTCHours() !== Number(hour) ||
    check.getUTCMinutes() !== Number(minute) ||
    check.getUTCSeconds() !== Number(second)
  ) return null;
  return utc;
}

export function sortedMarkers(markers: Marker[]): Marker[] {
  return [...markers].sort((a, b) => a.recordedAtMs - b.recordedAtMs || a.key.localeCompare(b.key));
}

export function pairMarkers(markers: Marker[]): ClipSegment[] {
  const sorted = sortedMarkers(markers);
  const segments: ClipSegment[] = [];
  for (let index = 0; index + 1 < sorted.length; index += 2) {
    segments.push({ index: segments.length + 1, start: sorted[index], end: sorted[index + 1] });
  }
  return segments;
}

export function findSourceVideo(
  startMs: number,
  endMs: number,
  videos: TimelineVideo[],
): TimelineVideo | null {
  const toleranceMs = 1_000;
  return videos.find((video) => {
    if (video.recordingStartMs === null) return false;
    const videoEnd = video.recordingStartMs + video.durationMs;
    return startMs >= video.recordingStartMs - toleranceMs && endMs <= videoEnd + toleranceMs;
  }) ?? null;
}

export function toInputValue(timestampMs: number, utcOffsetMinutes: number): string {
  const date = new Date(timestampMs + utcOffsetMinutes * 60_000);
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
}

export function fromInputValue(value: string, utcOffsetMinutes: number): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "0", milliseconds = "0"] = match;
  const timestamp = Date.UTC(
    Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second),
    Number(milliseconds.padEnd(3, "0")),
  ) - utcOffsetMinutes * 60_000;
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function formatTimecode(durationMs: number): string {
  const value = Math.max(0, Math.round(durationMs));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  const millis = value % 1_000;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":") + `.${String(millis).padStart(3, "0")}`;
}

const TIMELINE_INTERVALS_MS = [
  100, 200, 500,
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000,
  60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000,
  60 * 60_000,
];

export function timelineTickInterval(durationMs: number, contentWidthPx: number): number {
  const targetTickCount = Math.max(1, contentWidthPx / 84);
  const targetInterval = Math.max(1, durationMs) / targetTickCount;
  return TIMELINE_INTERVALS_MS.find((interval) => interval >= targetInterval)
    ?? Math.ceil(targetInterval / 3_600_000) * 3_600_000;
}

export function formatTimelineOffset(offsetMs: number, intervalMs = 1_000): string {
  const value = Math.max(0, Math.round(offsetMs));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  const base = hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return intervalMs < 1_000 ? `${base}.${Math.floor((value % 1_000) / 100)}` : base;
}

export function formatClock(timestampMs: number, utcOffsetMinutes: number, includeDate = false): string {
  const date = new Date(timestampMs + utcOffsetMinutes * 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${String(date.getUTCMilliseconds()).padStart(3, "0")}`;
  return includeDate ? `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${time}` : time;
}

export function outputTimestamp(timestampMs: number, utcOffsetMinutes: number): string {
  return toInputValue(timestampMs, utcOffsetMinutes).replace("T", "_").replaceAll(":", "-").replace(".000", "");
}
