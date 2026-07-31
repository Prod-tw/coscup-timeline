import { useMemo, useRef } from "react";
import type { Marker, TimelineVideo } from "./types";
import { formatClock, sortedMarkers } from "./timeline";

interface TimelineViewProps {
  startMs: number;
  endMs: number;
  utcOffsetMinutes: number;
  markers: Marker[];
  videos: TimelineVideo[];
  playheadMs: number | null;
  onMoveMarker: (key: string, timestampMs: number) => void;
  onSeek: (timestampMs: number) => void;
}

export function TimelineView({
  startMs,
  endMs,
  utcOffsetMinutes,
  markers,
  videos,
  playheadMs,
  onMoveMarker,
  onSeek,
}: TimelineViewProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const duration = Math.max(1, endMs - startMs);
  const ordered = useMemo(() => sortedMarkers(markers), [markers]);
  const ticks = Array.from({ length: 9 }, (_, index) => startMs + duration * (index / 8));
  const percent = (value: number) => Math.max(0, Math.min(100, ((value - startMs) / duration) * 100));
  const valueFromPointer = (clientX: number) => {
    const bounds = trackRef.current?.getBoundingClientRect();
    if (!bounds) return startMs;
    return startMs + Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)) * duration;
  };

  return (
    <div className="timeline-wrap">
      <div className="timeline-ruler" aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick} style={{ left: `${percent(tick)}%` }}>{formatClock(tick, utcOffsetMinutes)}</span>
        ))}
      </div>
      <div
        className="timeline-track"
        ref={trackRef}
        onDoubleClick={(event) => onSeek(Math.round(valueFromPointer(event.clientX)))}
      >
        {videos.filter((video) => video.recordingStartMs !== null).map((video) => (
          <div
            className="video-range"
            key={video.path}
            style={{
              left: `${percent(video.recordingStartMs!)}%`,
              width: `${Math.max(0.2, percent(video.recordingStartMs! + video.durationMs) - percent(video.recordingStartMs!))}%`,
            }}
            title={video.name}
          />
        ))}
        {playheadMs !== null && (
          <div className="playhead" style={{ left: `${percent(playheadMs)}%` }} aria-hidden="true"><span /></div>
        )}
        {ordered.map((marker, index) => (
          <button
            type="button"
            className={`timeline-marker ${index % 2 === 0 ? "is-start" : "is-end"}`}
            key={marker.key}
            style={{ left: `${percent(marker.recordedAtMs)}%` }}
            title={`${index % 2 === 0 ? "開始" : "結束"} ${formatClock(marker.recordedAtMs, utcOffsetMinutes)}`}
            aria-label={`拖曳第 ${index + 1} 個時間針`}
            onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                onMoveMarker(marker.key, Math.round(valueFromPointer(event.clientX)));
              }
            }}
          >
            <span>{index + 1}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
