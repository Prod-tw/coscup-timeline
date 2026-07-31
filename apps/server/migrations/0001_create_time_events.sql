CREATE TABLE IF NOT EXISTS time_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL CHECK (room_id > 0),
    recorded_at_ms INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'button' CHECK (source IN ('button', 'manual', 'dashboard')),
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_time_events_room_time
    ON time_events (room_id, recorded_at_ms, id);

