import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  Broadcast,
  CheckCircle,
  ClockCounterClockwise,
  Plus,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { api, type RoomSummary, type TimeEvent } from "./api";
import { formatDateTime, formatTime, relativeTime } from "./format";

const REFRESH_INTERVAL = 10_000;

function App() {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [events, setEvents] = useState<TimeEvent[]>([]);
  const [roomInput, setRoomInput] = useState("209");
  const [manualTime, setManualTime] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [online, setOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async (preferredRoom?: string) => {
    try {
      const [roomData] = await Promise.all([api.rooms(), api.health()]);
      setRooms(roomData);
      setOnline(true);
      setError(null);
      const target = preferredRoom ?? selectedRoom ?? roomData[0]?.room_id ?? null;
      setSelectedRoom(target);
      setEvents(target ? await api.events(target) : []);
    } catch (reason) {
      setOnline(false);
      setError(reason instanceof Error ? reason.message : "無法連接伺服器");
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, [selectedRoom]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL);
    return () => window.clearInterval(interval);
  }, [refresh]);

  async function submitRecord(event: FormEvent) {
    event.preventDefault();
    const roomId = roomInput.trim();
    if (!roomId) {
      setError("廳 ID 不可為空");
      return;
    }
    setSubmitting(true);
    try {
      await api.record(roomId);
      await refresh(roomId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "記錄失敗");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitManual(event: FormEvent) {
    event.preventDefault();
    if (!selectedRoom || !manualTime) return;
    setSubmitting(true);
    try {
      await api.addManual(selectedRoom, new Date(manualTime).toISOString());
      setManualTime("");
      await refresh(selectedRoom);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "新增失敗");
    } finally {
      setSubmitting(false);
    }
  }

  async function removeEvent(eventId: number) {
    if (!selectedRoom || !window.confirm("刪除這個時間點？後續開始/結束配對會全部重算。")) return;
    try {
      await api.remove(eventId);
      await refresh(selectedRoom);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "刪除失敗");
    }
  }

  const selectedSummary = useMemo(
    () => rooms.find((room) => room.room_id === selectedRoom) ?? null,
    [rooms, selectedRoom],
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">C</div>
          <div>
            <h1>COSCUP 時間站</h1>
            <p>現場議程時間</p>
          </div>
        </div>
        <div className={`server-status ${online ? "is-online" : "is-offline"}`}>
          {online ? <CheckCircle size={18} weight="fill" /> : <WarningCircle size={18} weight="fill" />}
          <span>{online ? "伺服器正常" : "連線中斷"}</span>
          <button className="icon-button" type="button" onClick={() => void refresh()} aria-label="重新整理" title="重新整理">
            <ArrowClockwise size={18} />
          </button>
        </div>
      </header>

      <main>
        <section className="capture-band" aria-labelledby="capture-title">
          <div>
            <h2 id="capture-title">記錄現場時間</h2>
            <p>伺服器時間 {formatDateTime(now)}</p>
          </div>
          <form className="capture-form" onSubmit={submitRecord}>
            <label htmlFor="room-id">廳 ID</label>
            <input
              id="room-id"
              type="text"
              value={roomInput}
              onChange={(event) => setRoomInput(event.target.value)}
            />
            <button className="primary-button" type="submit" disabled={submitting || !online}>
              <Broadcast size={20} weight="bold" />
              {submitting ? "記錄中" : "送出時間"}
            </button>
          </form>
        </section>

        {error && (
          <div className="error-banner" role="alert">
            <WarningCircle size={20} weight="fill" />
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)}>關閉</button>
          </div>
        )}

        <div className="workspace-grid">
          <aside className="room-panel" aria-label="廳別">
            <div className="section-heading">
              <h2>廳別</h2>
              <span>{rooms.length}</span>
            </div>
            {loading ? (
              <div className="skeleton-list" aria-label="載入中">
                <span /><span /><span />
              </div>
            ) : rooms.length === 0 ? (
              <div className="empty-compact">
                <ClockCounterClockwise size={28} />
                <p>尚無時間資料</p>
              </div>
            ) : (
              <nav className="room-list">
                {rooms.map((room) => (
                  <button
                    type="button"
                    key={room.room_id}
                    className={selectedRoom === room.room_id ? "is-selected" : ""}
                    onClick={() => {
                      setSelectedRoom(room.room_id);
                      void refresh(room.room_id);
                    }}
                  >
                    <span className="room-number">廳 {room.room_id}</span>
                    <span className="room-meta">{room.marker_count} 針 / {room.completed_segment_count} 段</span>
                    <span className={room.has_unpaired_marker ? "pair-state pending" : "pair-state complete"}>
                      {room.has_unpaired_marker ? "待結束" : "已配對"}
                    </span>
                  </button>
                ))}
              </nav>
            )}
          </aside>

          <section className="event-panel" aria-labelledby="event-title">
            <div className="event-header">
              <div>
                <h2 id="event-title">{selectedRoom ? `廳 ${selectedRoom}` : "時間資料"}</h2>
                {selectedSummary && (
                  <p>最後記錄 {relativeTime(selectedSummary.last_recorded_at_ms, now)}</p>
                )}
              </div>
              {selectedSummary && (
                <div className="summary-metrics">
                  <span><strong>{selectedSummary.marker_count}</strong> 時間針</span>
                  <span><strong>{selectedSummary.completed_segment_count}</strong> 完整議程</span>
                </div>
              )}
            </div>

            {events.length === 0 ? (
              <div className="empty-state">
                <ClockCounterClockwise size={38} />
                <h3>這一廳還沒有時間點</h3>
              </div>
            ) : (
              <ol className="event-list">
                {events.map((item, index) => (
                  <li key={item.id} className={item.marker_type === "start" ? "marker-start" : "marker-end"}>
                    <div className="marker-index">{String(index + 1).padStart(2, "0")}</div>
                    <div className="marker-line"><span /></div>
                    <div className="marker-content">
                      <span className="marker-kind">{item.marker_type === "start" ? "開始" : "結束"}</span>
                      <strong>{formatTime(item.recorded_at)}</strong>
                      <span>{formatDateTime(item.recorded_at)}</span>
                    </div>
                    <span className="source-label">{item.source === "button" ? "按鈕" : item.source === "manual" ? "手動" : "修正"}</span>
                    <button
                      className="icon-button danger"
                      type="button"
                      onClick={() => void removeEvent(item.id)}
                      aria-label={`刪除第 ${index + 1} 個時間點`}
                      title="刪除時間點"
                    >
                      <Trash size={18} />
                    </button>
                  </li>
                ))}
              </ol>
            )}

            {selectedRoom && (
              <form className="manual-form" onSubmit={submitManual}>
                <div>
                  <label htmlFor="manual-time">精確新增時間</label>
                  <input
                    id="manual-time"
                    type="datetime-local"
                    step="0.001"
                    value={manualTime}
                    onChange={(event) => setManualTime(event.target.value)}
                  />
                </div>
                <button className="secondary-button" type="submit" disabled={!manualTime || submitting}>
                  <Plus size={18} weight="bold" />新增
                </button>
              </form>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

export default App;

