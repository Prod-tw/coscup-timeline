import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import {
  ArrowsOutLineHorizontal,
  FilmStrip,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
} from "@phosphor-icons/react";
import type { Marker, TimelineVideo } from "./types";
import { formatTimelineOffset, sortedMarkers, timelineTickInterval } from "./timeline";

interface TimelineViewProps {
  startMs: number;
  endMs: number;
  markers: Marker[];
  video: TimelineVideo | null;
  playheadMs: number | null;
  onMoveMarker: (key: string, timestampMs: number) => void;
  onSeek: (timestampMs: number) => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 24;
const ZOOM_STEP = 0.5;

export function TimelineView({
  startMs,
  endMs,
  markers,
  video,
  playheadMs,
  onMoveMarker,
  onSeek,
}: TimelineViewProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const pendingScrollRef = useRef<{ ratio: number; anchorPx: number } | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [viewportWidth, setViewportWidth] = useState(720);
  const duration = Math.max(1, endMs - startMs);
  const contentWidth = Math.max(viewportWidth, Math.round(viewportWidth * zoom));
  const ordered = useMemo(() => sortedMarkers(markers), [markers]);
  const visibleMarkers = ordered.filter((marker) => marker.recordedAtMs >= startMs && marker.recordedAtMs <= endMs);
  const interval = timelineTickInterval(duration, contentWidth);
  const ticks = useMemo(() => {
    const values: number[] = [];
    for (let offset = 0; offset <= duration; offset += interval) values.push(offset);
    if (duration - (values.at(-1) ?? 0) > interval * 0.35) values.push(duration);
    return values;
  }, [duration, interval]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateSize = () => setViewportWidth(Math.max(1, viewport.clientWidth));
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setZoom(MIN_ZOOM);
    if (viewportRef.current) viewportRef.current.scrollLeft = 0;
  }, [video?.path]);

  useEffect(() => {
    const pending = pendingScrollRef.current;
    const viewport = viewportRef.current;
    if (!pending || !viewport) return;
    viewport.scrollLeft = pending.ratio * viewport.scrollWidth - pending.anchorPx;
    pendingScrollRef.current = null;
  }, [zoom]);

  const positionPx = (timestampMs: number) => ((timestampMs - startMs) / duration) * contentWidth;
  const timestampFromPointer = (clientX: number) => {
    const surface = surfaceRef.current;
    if (!surface) return startMs;
    const bounds = surface.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
    return Math.round(startMs + ratio * duration);
  };

  function updateZoom(nextZoom: number, anchorClientX?: number) {
    const viewport = viewportRef.current;
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(nextZoom * 2) / 2));
    if (!viewport || next === zoom) return;
    const bounds = viewport.getBoundingClientRect();
    const anchorPx = anchorClientX === undefined
      ? viewport.clientWidth / 2
      : Math.max(0, Math.min(viewport.clientWidth, anchorClientX - bounds.left));
    pendingScrollRef.current = {
      ratio: (viewport.scrollLeft + anchorPx) / viewport.scrollWidth,
      anchorPx,
    };
    setZoom(next);
  }

  function seekFromPointer(event: PointerEvent<HTMLDivElement>) {
    onSeek(timestampFromPointer(event.clientX));
  }

  function handleSurfacePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromPointer(event);
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      updateZoom(zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP), event.clientX);
      return;
    }
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      event.preventDefault();
      viewport.scrollLeft += event.deltaY;
    }
  }

  return (
    <div className={`timeline-editor ${video ? "has-video" : "is-empty"}`}>
      <div className="timeline-zoom-controls" aria-label="時間軸縮放">
        <button type="button" onClick={() => updateZoom(zoom - ZOOM_STEP)} disabled={zoom <= MIN_ZOOM} title="縮小時間軸" aria-label="縮小時間軸">
          <MagnifyingGlassMinus size={16} />
        </button>
        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={ZOOM_STEP}
          value={zoom}
          onChange={(event) => updateZoom(Number(event.target.value))}
          aria-label="時間軸縮放比例"
        />
        <button type="button" onClick={() => updateZoom(zoom + ZOOM_STEP)} disabled={zoom >= MAX_ZOOM} title="放大時間軸" aria-label="放大時間軸">
          <MagnifyingGlassPlus size={16} />
        </button>
        <button type="button" onClick={() => updateZoom(MIN_ZOOM)} disabled={zoom === MIN_ZOOM} title="完整顯示影片" aria-label="完整顯示影片">
          <ArrowsOutLineHorizontal size={16} />
        </button>
        <output>{zoom === 1 ? "適合" : `${zoom.toFixed(1)}x`}</output>
      </div>

      <div className="timeline-lane-labels" aria-hidden="true">
        <span>時間</span>
        <span>影片</span>
        <span>切點</span>
      </div>

      <div className="timeline-viewport" ref={viewportRef} onWheel={handleWheel}>
        <div
          className="timeline-surface"
          ref={surfaceRef}
          style={{ width: contentWidth }}
          onPointerDown={handleSurfacePointerDown}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) seekFromPointer(event);
          }}
        >
          <div className="timeline-ruler" aria-hidden="true">
            {ticks.map((offset, index) => (
              <span
                className={index % 5 === 0 ? "major" : ""}
                key={offset}
                style={{ left: positionPx(startMs + offset) }}
              >
                <i />
                <b>{formatTimelineOffset(offset, interval)}</b>
              </span>
            ))}
          </div>

          <div className="timeline-video-lane">
            {video ? (
              <div className="timeline-video-clip">
                <span className="clip-leading-icon"><FilmStrip size={18} weight="fill" /></span>
                <strong>{video.name}</strong>
                <small>{formatTimelineOffset(video.durationMs)}</small>
              </div>
            ) : (
              <span className="timeline-empty-message">開啟影片後會在這裡顯示完整時間軸</span>
            )}
          </div>

          <div className="timeline-marker-lane" />

          {playheadMs !== null && playheadMs >= startMs && playheadMs <= endMs && (
            <div className="playhead" style={{ left: positionPx(playheadMs) }} aria-hidden="true"><span /></div>
          )}

          {visibleMarkers.map((marker) => {
            const index = ordered.findIndex((item) => item.key === marker.key);
            return (
              <button
                type="button"
                className={`timeline-marker ${index % 2 === 0 ? "is-start" : "is-end"}`}
                key={marker.key}
                style={{ left: positionPx(marker.recordedAtMs) }}
                title={`${index % 2 === 0 ? "開始" : "結束"} ${formatTimelineOffset(marker.recordedAtMs - startMs, 100)}`}
                aria-label={`拖曳第 ${index + 1} 個時間針`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    onMoveMarker(marker.key, timestampFromPointer(event.clientX));
                  }
                }}
              >
                <span>{index + 1}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
