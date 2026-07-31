export type MarkerType = "start" | "end";

export interface TimeEvent {
  id: number;
  room_id: number;
  recorded_at: string;
  recorded_at_ms: number;
  source: "button" | "manual" | "dashboard";
  created_at: string;
  position: number;
  marker_type: MarkerType;
}

export interface RoomSummary {
  room_id: number;
  marker_count: number;
  completed_segment_count: number;
  has_unpaired_marker: boolean;
  first_recorded_at: string;
  last_recorded_at: string;
  last_recorded_at_ms: number;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...options?.headers,
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  rooms: () => request<RoomSummary[]>("/api/v1/rooms"),
  events: (roomId: number) => request<TimeEvent[]>(`/api/v1/rooms/${roomId}/events`),
  record: (roomId: number) =>
    request<TimeEvent>("/api/v1/events", {
      method: "POST",
      body: JSON.stringify({ room_id: roomId }),
    }),
  addManual: (roomId: number, recordedAt: string) =>
    request<TimeEvent>(`/api/v1/rooms/${roomId}/events`, {
      method: "POST",
      body: JSON.stringify({ recorded_at: recordedAt }),
    }),
  remove: (eventId: number) => request<void>(`/api/v1/events/${eventId}`, { method: "DELETE" }),
  health: () => request<{ status: string; server_time: string }>("/api/v1/health"),
};

