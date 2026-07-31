export interface VideoInfo {
  path: string;
  name: string;
  durationMs: number;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  fileSizeBytes: number;
}

export interface TimelineVideo extends VideoInfo {
  recordingStartMs: number | null;
}

export interface Marker {
  key: string;
  serverId?: number;
  recordedAtMs: number;
  source: "server" | "manual";
}

export interface ServerEvent {
  id: number;
  room_id: number;
  recorded_at: string;
  recorded_at_ms: number;
  source: string;
  position: number;
  marker_type: "start" | "end";
}

export interface ClipSegment {
  index: number;
  start: Marker;
  end: Marker;
}

export interface ClipWithSource extends ClipSegment {
  video: TimelineVideo | null;
}

export type ExportMode = "stream_copy" | "precise";

export interface ClipJob {
  inputPath: string;
  outputName: string;
  startSeconds: number;
  durationSeconds: number;
  mode: ExportMode;
}

export interface ExportResult {
  outputPath: string;
  elapsedMs: number;
}

