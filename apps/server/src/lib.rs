use std::{path::PathBuf, str::FromStr, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{
    FromRow, SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use thiserror::Error;
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

#[derive(Clone)]
pub struct AppState {
    pool: SqlitePool,
    clock: Arc<dyn Clock>,
}

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

#[derive(Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        Utc::now().timestamp_millis()
    }
}

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub database_url: String,
    pub dashboard_dir: PathBuf,
}

#[derive(Debug, Error)]
pub enum AppError {
    #[error("database error")]
    Database(#[from] sqlx::Error),
    #[error("room_id must be a positive integer")]
    InvalidRoom,
    #[error("invalid timestamp; use RFC 3339 such as 2026-07-31T03:10:34+08:00")]
    InvalidTimestamp,
    #[error("time event not found")]
    NotFound,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::InvalidRoom | Self::InvalidTimestamp => StatusCode::UNPROCESSABLE_ENTITY,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let message = self.to_string();
        if matches!(self, Self::Database(_)) {
            tracing::error!(error = %message, "request failed");
        }
        (status, Json(ErrorResponse { error: message })).into_response()
    }
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Debug, Deserialize)]
pub struct RecordEventRequest {
    pub room_id: i64,
}

#[derive(Debug, Deserialize)]
pub struct ManualEventRequest {
    pub recorded_at: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateEventRequest {
    pub recorded_at: String,
}

#[derive(Debug, Clone, FromRow)]
struct EventRow {
    id: i64,
    room_id: i64,
    recorded_at_ms: i64,
    source: String,
    created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeEvent {
    pub id: i64,
    pub room_id: i64,
    pub recorded_at: String,
    pub recorded_at_ms: i64,
    pub source: String,
    pub created_at: String,
    pub position: usize,
    pub marker_type: MarkerType,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MarkerType {
    Start,
    End,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RoomSummary {
    pub room_id: i64,
    pub marker_count: i64,
    pub completed_segment_count: i64,
    pub has_unpaired_marker: bool,
    pub first_recorded_at: String,
    pub last_recorded_at: String,
    pub last_recorded_at_ms: i64,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    server_time: String,
}

#[derive(Debug, FromRow)]
struct RoomSummaryRow {
    room_id: i64,
    marker_count: i64,
    first_recorded_at_ms: i64,
    last_recorded_at_ms: i64,
}

pub async fn connect_database(database_url: &str) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

pub fn build_app(pool: SqlitePool, dashboard_dir: PathBuf) -> Router {
    build_app_with_clock(pool, dashboard_dir, Arc::new(SystemClock))
}

pub fn build_app_with_clock(
    pool: SqlitePool,
    dashboard_dir: PathBuf,
    clock: Arc<dyn Clock>,
) -> Router {
    let state = AppState { pool, clock };
    let api = Router::new()
        .route("/health", get(health))
        .route("/events", post(record_event))
        .route(
            "/events/{event_id}",
            patch(update_event).delete(delete_event),
        )
        .route("/rooms", get(list_rooms))
        .route(
            "/rooms/{room_id}/events",
            get(list_room_events).post(record_manual_event),
        );

    let index = dashboard_dir.join("index.html");
    let static_files = ServeDir::new(dashboard_dir).not_found_service(ServeFile::new(index));
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
        .allow_headers([axum::http::header::CONTENT_TYPE])
        .expose_headers([axum::http::header::CONTENT_TYPE])
        .max_age(Duration::from_secs(3600));

    Router::new()
        .nest("/api/v1", api)
        .fallback_service(static_files)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        server_time: format_timestamp(state.clock.now_ms()),
    })
}

async fn record_event(
    State(state): State<AppState>,
    Json(payload): Json<RecordEventRequest>,
) -> Result<(StatusCode, Json<TimeEvent>), AppError> {
    validate_room(payload.room_id)?;
    let now = state.clock.now_ms();
    let row = insert_event(&state.pool, payload.room_id, now, "button", now).await?;
    let position = event_position(&state.pool, row.room_id, row.id).await?;
    Ok((StatusCode::CREATED, Json(to_event(row, position))))
}

async fn record_manual_event(
    State(state): State<AppState>,
    Path(room_id): Path<i64>,
    Json(payload): Json<ManualEventRequest>,
) -> Result<(StatusCode, Json<TimeEvent>), AppError> {
    validate_room(room_id)?;
    let recorded_at_ms = parse_timestamp(&payload.recorded_at)?;
    let row = insert_event(
        &state.pool,
        room_id,
        recorded_at_ms,
        "manual",
        state.clock.now_ms(),
    )
    .await?;
    let position = event_position(&state.pool, row.room_id, row.id).await?;
    Ok((StatusCode::CREATED, Json(to_event(row, position))))
}

async fn update_event(
    State(state): State<AppState>,
    Path(event_id): Path<i64>,
    Json(payload): Json<UpdateEventRequest>,
) -> Result<Json<TimeEvent>, AppError> {
    let recorded_at_ms = parse_timestamp(&payload.recorded_at)?;
    let row = sqlx::query_as::<_, EventRow>(
        "UPDATE time_events SET recorded_at_ms = ?, source = 'dashboard' WHERE id = ? RETURNING id, room_id, recorded_at_ms, source, created_at_ms",
    )
    .bind(recorded_at_ms)
    .bind(event_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    let position = event_position(&state.pool, row.room_id, row.id).await?;
    Ok(Json(to_event(row, position)))
}

async fn delete_event(
    State(state): State<AppState>,
    Path(event_id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let result = sqlx::query("DELETE FROM time_events WHERE id = ?")
        .bind(event_id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn list_room_events(
    State(state): State<AppState>,
    Path(room_id): Path<i64>,
) -> Result<Json<Vec<TimeEvent>>, AppError> {
    validate_room(room_id)?;
    let rows = sqlx::query_as::<_, EventRow>(
        "SELECT id, room_id, recorded_at_ms, source, created_at_ms FROM time_events WHERE room_id = ? ORDER BY recorded_at_ms ASC, id ASC",
    )
    .bind(room_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .enumerate()
            .map(|(index, row)| to_event(row, index + 1))
            .collect(),
    ))
}

async fn list_rooms(State(state): State<AppState>) -> Result<Json<Vec<RoomSummary>>, AppError> {
    let rows = sqlx::query_as::<_, RoomSummaryRow>(
        "SELECT room_id, COUNT(*) AS marker_count, MIN(recorded_at_ms) AS first_recorded_at_ms, MAX(recorded_at_ms) AS last_recorded_at_ms FROM time_events GROUP BY room_id ORDER BY room_id ASC",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|row| RoomSummary {
                room_id: row.room_id,
                marker_count: row.marker_count,
                completed_segment_count: row.marker_count / 2,
                has_unpaired_marker: row.marker_count % 2 == 1,
                first_recorded_at: format_timestamp(row.first_recorded_at_ms),
                last_recorded_at: format_timestamp(row.last_recorded_at_ms),
                last_recorded_at_ms: row.last_recorded_at_ms,
            })
            .collect(),
    ))
}

async fn insert_event(
    pool: &SqlitePool,
    room_id: i64,
    recorded_at_ms: i64,
    source: &str,
    created_at_ms: i64,
) -> Result<EventRow, sqlx::Error> {
    sqlx::query_as::<_, EventRow>(
        "INSERT INTO time_events (room_id, recorded_at_ms, source, created_at_ms) VALUES (?, ?, ?, ?) RETURNING id, room_id, recorded_at_ms, source, created_at_ms",
    )
    .bind(room_id)
    .bind(recorded_at_ms)
    .bind(source)
    .bind(created_at_ms)
    .fetch_one(pool)
    .await
}

async fn event_position(
    pool: &SqlitePool,
    room_id: i64,
    event_id: i64,
) -> Result<usize, sqlx::Error> {
    let position: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM time_events current JOIN time_events candidate ON candidate.room_id = current.room_id AND (candidate.recorded_at_ms < current.recorded_at_ms OR (candidate.recorded_at_ms = current.recorded_at_ms AND candidate.id <= current.id)) WHERE current.room_id = ? AND current.id = ?",
    )
    .bind(room_id)
    .bind(event_id)
    .fetch_one(pool)
    .await?;
    Ok(position as usize)
}

fn to_event(row: EventRow, position: usize) -> TimeEvent {
    TimeEvent {
        id: row.id,
        room_id: row.room_id,
        recorded_at: format_timestamp(row.recorded_at_ms),
        recorded_at_ms: row.recorded_at_ms,
        source: row.source,
        created_at: format_timestamp(row.created_at_ms),
        position,
        marker_type: if position % 2 == 1 {
            MarkerType::Start
        } else {
            MarkerType::End
        },
    }
}

fn validate_room(room_id: i64) -> Result<(), AppError> {
    if room_id <= 0 {
        Err(AppError::InvalidRoom)
    } else {
        Ok(())
    }
}

fn parse_timestamp(value: &str) -> Result<i64, AppError> {
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.timestamp_millis())
        .map_err(|_| AppError::InvalidTimestamp)
}

fn format_timestamp(timestamp_ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(timestamp_ms)
        .expect("timestamps stored by this application are valid")
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn accepts_rfc3339_offsets_and_normalizes_to_utc() {
        let value = parse_timestamp("2026-07-31T11:10:34+08:00").unwrap();
        assert_eq!(format_timestamp(value), "2026-07-31T03:10:34.000Z");
    }
}
