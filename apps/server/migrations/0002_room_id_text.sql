-- Widen room_id from INTEGER to TEXT so prefixed rooms (e.g. "RB105") are representable.
ALTER TABLE time_events RENAME TO time_events_old;

CREATE TABLE time_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL CHECK (length(trim(room_id)) > 0),
    recorded_at_ms INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'button' CHECK (source IN ('button', 'manual', 'dashboard')),
    created_at_ms INTEGER NOT NULL
);

INSERT INTO time_events (id, room_id, recorded_at_ms, source, created_at_ms)
    SELECT id, CAST(room_id AS TEXT), recorded_at_ms, source, created_at_ms FROM time_events_old;

DROP TABLE time_events_old;

CREATE INDEX IF NOT EXISTS idx_time_events_room_time
    ON time_events (room_id, recorded_at_ms, id);
