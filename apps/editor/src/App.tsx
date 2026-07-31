import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  CheckCircle,
  CloudArrowDown,
  DownloadSimple,
  FilmStrip,
  FolderOpen,
  HardDrives,
  Plus,
  Scissors,
  Trash,
  UploadSimple,
  Warning,
  X,
} from "@phosphor-icons/react";
import { Timeline } from "./Timeline";
import {
  findSourceVideo,
  formatClock,
  formatTimecode,
  fromInputValue,
  outputTimestamp,
  pairMarkers,
  parseObsFilename,
  sortedMarkers,
  toInputValue,
} from "./timeline";
import type {
  ClipJob,
  ClipWithSource,
  ExportMode,
  ExportResult,
  Marker,
  ServerEvent,
  TimelineVideo,
  VideoInfo,
} from "./types";

const DEFAULT_SERVER = "http://localhost:3000";

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem("coscup.serverUrl") ?? DEFAULT_SERVER);
  const [roomId, setRoomId] = useState(() => localStorage.getItem("coscup.roomId") ?? "209");
  const [utcOffsetMinutes, setUtcOffsetMinutes] = useState(() => Number(localStorage.getItem("coscup.utcOffset") ?? "480"));
  const [videos, setVideos] = useState<VideoInfo[]>([]);
  const [selectedVideoPath, setSelectedVideoPath] = useState<string | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);
  const [pendingSeekMs, setPendingSeekMs] = useState<number | null>(null);
  const [manualInput, setManualInput] = useState("");
  const [outputDirectory, setOutputDirectory] = useState("");
  const [exportMode, setExportMode] = useState<ExportMode>("stream_copy");
  const [toolsReady, setToolsReady] = useState<boolean | null>(null);
  const [loadingServer, setLoadingServer] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [results, setResults] = useState<ExportResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem("coscup.serverUrl", serverUrl);
    localStorage.setItem("coscup.roomId", roomId);
    localStorage.setItem("coscup.utcOffset", String(utcOffsetMinutes));
  }, [serverUrl, roomId, utcOffsetMinutes]);

  useEffect(() => {
    invoke<{ ffmpeg: boolean; ffprobe: boolean }>("check_tools")
      .then((status) => setToolsReady(status.ffmpeg && status.ffprobe))
      .catch(() => setToolsReady(false));
  }, []);

  const timelineVideos = useMemo<TimelineVideo[]>(
    () => videos.map((video) => ({
      ...video,
      recordingStartMs: parseObsFilename(video.name, utcOffsetMinutes),
    })),
    [videos, utcOffsetMinutes],
  );

  const orderedMarkers = useMemo(() => sortedMarkers(markers), [markers]);
  const clips = useMemo<ClipWithSource[]>(
    () => pairMarkers(orderedMarkers).map((clip) => ({
      ...clip,
      video: findSourceVideo(clip.start.recordedAtMs, clip.end.recordedAtMs, timelineVideos),
    })),
    [orderedMarkers, timelineVideos],
  );

  const timelineBounds = useMemo(() => {
    const starts = timelineVideos.flatMap((video) => video.recordingStartMs === null ? [] : [video.recordingStartMs]);
    const ends = timelineVideos.flatMap((video) => video.recordingStartMs === null ? [] : [video.recordingStartMs + video.durationMs]);
    const all = [...starts, ...ends, ...orderedMarkers.map((marker) => marker.recordedAtMs)];
    if (all.length === 0) {
      const hour = 3_600_000;
      const now = Math.floor(Date.now() / hour) * hour;
      return { start: now, end: now + hour };
    }
    const start = Math.min(...all);
    const end = Math.max(...all);
    return { start: start - 10_000, end: Math.max(end + 10_000, start + 60_000) };
  }, [orderedMarkers, timelineVideos]);

  const selectedVideo = timelineVideos.find((video) => video.path === selectedVideoPath) ?? null;
  const invalidVideos = timelineVideos.filter((video) => video.recordingStartMs === null);
  const unmappedClips = clips.filter((clip) => !clip.video);
  const hasUnpaired = orderedMarkers.length % 2 === 1;

  useEffect(() => {
    if (!selectedVideoPath && timelineVideos[0]) setSelectedVideoPath(timelineVideos[0].path);
  }, [selectedVideoPath, timelineVideos]);

  useEffect(() => {
    if (playheadMs === null && selectedVideo?.recordingStartMs !== null && selectedVideo?.recordingStartMs !== undefined) {
      setPlayheadMs(selectedVideo.recordingStartMs);
      setManualInput(toInputValue(selectedVideo.recordingStartMs, utcOffsetMinutes));
    }
  }, [playheadMs, selectedVideo, utcOffsetMinutes]);

  async function selectVideos() {
    try {
      setError(null);
      const selected = await invoke<VideoInfo[]>("select_video_files");
      if (selected.length === 0) return;
      setVideos((current) => {
        const merged = new Map(current.map((video) => [video.path, video]));
        selected.forEach((video) => merged.set(video.path, video));
        return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
      });
      setSelectedVideoPath(selected[0].path);
      setResults([]);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function importServerTimes(event: FormEvent) {
    event.preventDefault();
    const id = Number(roomId);
    if (!Number.isInteger(id) || id <= 0) {
      setError("廳 ID 必須是正整數");
      return;
    }
    setLoadingServer(true);
    setError(null);
    try {
      const base = serverUrl.replace(/\/+$/, "");
      const response = await fetch(`${base}/api/v1/rooms/${id}/events`);
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Server HTTP ${response.status}`);
      }
      const data = await response.json() as ServerEvent[];
      setMarkers(data.map((item) => ({
        key: `server-${item.id}`,
        serverId: item.id,
        recordedAtMs: item.recorded_at_ms,
        source: "server",
      })));
      setResults([]);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoadingServer(false);
    }
  }

  function addMarker(timestampMs: number) {
    setMarkers((current) => sortedMarkers([
      ...current,
      { key: crypto.randomUUID(), recordedAtMs: Math.round(timestampMs), source: "manual" },
    ]));
    setResults([]);
  }

  function addExactMarker(event: FormEvent) {
    event.preventDefault();
    const timestamp = fromInputValue(manualInput, utcOffsetMinutes);
    if (timestamp === null) {
      setError("時間格式無效");
      return;
    }
    addMarker(timestamp);
  }

  function updateMarker(key: string, timestampMs: number) {
    setMarkers((current) => sortedMarkers(current.map((marker) =>
      marker.key === key ? { ...marker, recordedAtMs: Math.round(timestampMs), source: "manual" } : marker,
    )));
    setResults([]);
  }

  function removeMarker(key: string) {
    setMarkers((current) => current.filter((marker) => marker.key !== key));
    setResults([]);
  }

  function seekTimeline(timestampMs: number) {
    const video = findSourceVideo(timestampMs, timestampMs, timelineVideos);
    if (!video || video.recordingStartMs === null) return;
    setSelectedVideoPath(video.path);
    setPendingSeekMs(timestampMs);
    setPlayheadMs(timestampMs);
  }

  function applyPendingSeek() {
    if (pendingSeekMs === null || !selectedVideo || selectedVideo.recordingStartMs === null || !videoRef.current) return;
    videoRef.current.currentTime = Math.max(0, (pendingSeekMs - selectedVideo.recordingStartMs) / 1000);
    setPendingSeekMs(null);
  }

  async function chooseOutputDirectory() {
    try {
      const selected = await invoke<string | null>("select_output_directory");
      if (selected) setOutputDirectory(selected);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function exportAll() {
    if (clips.length === 0 || unmappedClips.length > 0) return;
    let directory = outputDirectory;
    if (!directory) {
      directory = await invoke<string | null>("select_output_directory") ?? "";
      if (!directory) return;
      setOutputDirectory(directory);
    }
    const jobs: ClipJob[] = clips.map((clip) => {
      const video = clip.video!;
      const start = video.recordingStartMs!;
      return {
        inputPath: video.path,
        outputName: `room-${roomId}_${String(clip.index).padStart(2, "0")}_${outputTimestamp(clip.start.recordedAtMs, utcOffsetMinutes)}.mp4`,
        startSeconds: Math.max(0, (clip.start.recordedAtMs - start) / 1000),
        durationSeconds: (clip.end.recordedAtMs - clip.start.recordedAtMs) / 1000,
        mode: exportMode,
      };
    });
    setExporting(true);
    setError(null);
    setResults([]);
    try {
      const exported = await invoke<ExportResult[]>("export_clips", { outputDirectory: directory, jobs });
      setResults(exported);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="editor-shell">
      <header className="editor-topbar">
        <div className="editor-brand">
          <span className="editor-logo"><Scissors size={19} weight="bold" /></span>
          <div><h1>COSCUP Cut</h1><span>議程剪輯台</span></div>
        </div>
        <div className="project-actions">
          <span className={`tool-health ${toolsReady ? "ready" : "missing"}`}>
            {toolsReady ? <CheckCircle size={16} weight="fill" /> : <Warning size={16} weight="fill" />}
            {toolsReady === null ? "檢查 FFmpeg" : toolsReady ? "FFmpeg 就緒" : "FFmpeg 不可用"}
          </span>
          <button className="toolbar-button" type="button" onClick={() => void selectVideos()}>
            <FolderOpen size={18} />加入影片
          </button>
          <button
            className="export-button"
            type="button"
            disabled={exporting || clips.length === 0 || unmappedClips.length > 0 || !toolsReady}
            onClick={() => void exportAll()}
          >
            <DownloadSimple size={18} weight="bold" />
            {exporting ? "輸出中" : `輸出 ${clips.length} 段`}
          </button>
        </div>
      </header>

      {error && (
        <div className="editor-alert" role="alert">
          <Warning size={18} weight="fill" /><pre>{error}</pre>
          <button className="icon-button" type="button" onClick={() => setError(null)} aria-label="關閉錯誤"><X size={17} /></button>
        </div>
      )}

      <main className="editor-workspace">
        <aside className="source-sidebar">
          <div className="panel-heading">
            <h2>來源影片</h2><span>{videos.length}</span>
          </div>
          {videos.length === 0 ? (
            <button className="source-empty" type="button" onClick={() => void selectVideos()}>
              <UploadSimple size={28} /><strong>加入 OBS 影片</strong><span>MKV</span>
            </button>
          ) : (
            <div className="source-list">
              {timelineVideos.map((video) => (
                <button
                  type="button"
                  key={video.path}
                  className={selectedVideoPath === video.path ? "selected" : ""}
                  onClick={() => {
                    setSelectedVideoPath(video.path);
                    if (video.recordingStartMs !== null) setPlayheadMs(video.recordingStartMs);
                  }}
                >
                  <FilmStrip size={22} />
                  <span className="source-copy"><strong>{video.name.replace(/\.mkv$/i, "")}</strong><small>{formatTimecode(video.durationMs)} / {formatBytes(video.fileSizeBytes)}</small></span>
                  {video.recordingStartMs === null && <Warning className="source-warning" size={16} weight="fill" />}
                </button>
              ))}
            </div>
          )}
          {invalidVideos.length > 0 && <p className="inline-warning">{invalidVideos.length} 個檔名格式不符</p>}

          <div className="source-settings">
            <label htmlFor="timezone">OBS 時區</label>
            <select id="timezone" value={utcOffsetMinutes} onChange={(event) => setUtcOffsetMinutes(Number(event.target.value))}>
              <option value={480}>UTC+08:00 台北</option>
              <option value={540}>UTC+09:00</option>
              <option value={0}>UTC+00:00</option>
              <option value={-420}>UTC-07:00</option>
              <option value={-480}>UTC-08:00</option>
            </select>
          </div>
        </aside>

        <section className="edit-stage">
          <div className="preview-area">
            {selectedVideo ? (
              <video
                key={selectedVideo.path}
                ref={videoRef}
                src={convertFileSrc(selectedVideo.path)}
                controls
                onLoadedMetadata={applyPendingSeek}
                onTimeUpdate={(event) => {
                  if (selectedVideo.recordingStartMs !== null) {
                    setPlayheadMs(selectedVideo.recordingStartMs + event.currentTarget.currentTime * 1000);
                  }
                }}
              />
            ) : (
              <div className="preview-empty"><FilmStrip size={48} /><span>未選取影片</span></div>
            )}
            {selectedVideo && (
              <div className="preview-meta">
                <span>{selectedVideo.width ?? "?"} x {selectedVideo.height ?? "?"}</span>
                <span>{selectedVideo.videoCodec?.toUpperCase() ?? "VIDEO"}</span>
                <span>{selectedVideo.audioCodec?.toUpperCase() ?? "NO AUDIO"}</span>
              </div>
            )}
          </div>

          <div className="timeline-section">
            <div className="timeline-toolbar">
              <div>
                <strong>{playheadMs === null ? "00:00:00.000" : formatClock(playheadMs, utcOffsetMinutes)}</strong>
                <span>{orderedMarkers.length} 針 / {clips.length} 段</span>
              </div>
              <button
                className="toolbar-button compact"
                type="button"
                disabled={playheadMs === null}
                onClick={() => playheadMs !== null && addMarker(playheadMs)}
              >
                <Plus size={16} weight="bold" />播放位置加針
              </button>
            </div>
            <Timeline
              startMs={timelineBounds.start}
              endMs={timelineBounds.end}
              utcOffsetMinutes={utcOffsetMinutes}
              markers={orderedMarkers}
              videos={timelineVideos}
              playheadMs={playheadMs}
              onMoveMarker={updateMarker}
              onSeek={seekTimeline}
            />
            <div className="track-labels"><span>影片軌</span><span>時間針</span></div>
          </div>
        </section>

        <aside className="inspector-sidebar">
          <form className="server-import" onSubmit={importServerTimes}>
            <div className="panel-heading"><h2>時間資料</h2><CloudArrowDown size={18} /></div>
            <label htmlFor="server-url">Server URL</label>
            <input id="server-url" type="url" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} />
            <label htmlFor="room-id">廳 ID</label>
            <div className="inline-field">
              <input id="room-id" type="number" min="1" value={roomId} onChange={(event) => setRoomId(event.target.value)} />
              <button type="submit" disabled={loadingServer}>{loadingServer ? "匯入中" : "匯入"}</button>
            </div>
          </form>

          <div className="marker-inspector">
            <div className="panel-heading"><h2>時間針</h2><span>{orderedMarkers.length}</span></div>
            {orderedMarkers.length === 0 ? (
              <div className="inspector-empty"><span>尚無時間針</span></div>
            ) : (
              <ol>
                {orderedMarkers.map((marker, index) => (
                  <li key={marker.key}>
                    <span className={`marker-badge ${index % 2 === 0 ? "start" : "end"}`}>{index % 2 === 0 ? "開始" : "結束"}</span>
                    <input
                      aria-label={`第 ${index + 1} 個時間針`}
                      type="datetime-local"
                      step="0.001"
                      value={toInputValue(marker.recordedAtMs, utcOffsetMinutes)}
                      onChange={(event) => {
                        const value = fromInputValue(event.target.value, utcOffsetMinutes);
                        if (value !== null) updateMarker(marker.key, value);
                      }}
                    />
                    <button className="icon-button" type="button" onClick={() => removeMarker(marker.key)} aria-label={`刪除第 ${index + 1} 個時間針`} title="刪除">
                      <Trash size={16} />
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {hasUnpaired && <p className="inline-warning">最後一針尚未配對</p>}
          </div>

          <form className="exact-marker" onSubmit={addExactMarker}>
            <label htmlFor="manual-marker">精確新增</label>
            <div className="inline-field">
              <input
                id="manual-marker"
                type="datetime-local"
                step="0.001"
                value={manualInput}
                onFocus={() => {
                  if (!manualInput) setManualInput(toInputValue(playheadMs ?? timelineBounds.start, utcOffsetMinutes));
                }}
                onChange={(event) => setManualInput(event.target.value)}
              />
              <button type="submit" disabled={!manualInput} aria-label="新增精確時間"><Plus size={17} /></button>
            </div>
          </form>

          <div className="export-settings">
            <div className="panel-heading"><h2>輸出</h2><HardDrives size={18} /></div>
            <label>裁切模式</label>
            <div className="segmented-control">
              <button type="button" className={exportMode === "stream_copy" ? "active" : ""} onClick={() => setExportMode("stream_copy")}>原始串流</button>
              <button type="button" className={exportMode === "precise" ? "active" : ""} onClick={() => setExportMode("precise")}>精確切點</button>
            </div>
            <p>{exportMode === "stream_copy" ? "不重編碼，切點依影片關鍵幀。" : "H.264 CRF 18，AAC 320 kbps。"}</p>
            <label htmlFor="output-dir">輸出目錄</label>
            <button id="output-dir" className="directory-button" type="button" onClick={() => void chooseOutputDirectory()}>
              <FolderOpen size={17} /><span>{outputDirectory || "選擇目錄"}</span>
            </button>
            {unmappedClips.length > 0 && <p className="inline-warning">{unmappedClips.length} 段超出來源影片範圍</p>}
          </div>

          {results.length > 0 && (
            <div className="export-results">
              <CheckCircle size={20} weight="fill" />
              <div><strong>輸出完成</strong><span>{results.length} 個 MP4</span></div>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return "操作失敗";
}

export default App;

