use std::{path::PathBuf, sync::Arc};

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use coscup_time_server::{Clock, build_app_with_clock, connect_database};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

struct FixedClock(i64);

impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

async fn test_app() -> (axum::Router, TempDir) {
    let temp = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}", temp.path().join("test.db").display());
    let pool = connect_database(&url).await.unwrap();
    let app = build_app_with_clock(
        pool,
        PathBuf::from("missing-dashboard"),
        Arc::new(FixedClock(1_775_100_634_000)),
    );
    (app, temp)
}

#[tokio::test]
async fn button_post_records_only_server_time_and_room() {
    let (app, _temp) = test_app().await;
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/v1/events")
                .header("content-type", "application/json")
                .body(Body::from(json!({"room_id": 209}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["room_id"], 209);
    assert_eq!(body["recorded_at_ms"], 1_775_100_634_000_i64);
    assert_eq!(body["marker_type"], "start");

    let second = app
        .oneshot(
            Request::post("/api/v1/events")
                .header("content-type", "application/json")
                .body(Body::from(json!({"room_id": 209}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let body: Value =
        serde_json::from_slice(&second.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["marker_type"], "end");
    assert_eq!(body["position"], 2);
}

#[tokio::test]
async fn inserting_between_markers_recomputes_all_parity() {
    let (app, _temp) = test_app().await;
    for timestamp in [
        "2026-07-31T10:00:00+08:00",
        "2026-07-31T12:00:00+08:00",
        "2026-07-31T14:00:00+08:00",
    ] {
        app.clone()
            .oneshot(
                Request::post("/api/v1/rooms/209/events")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"recorded_at": timestamp}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
    }
    app.clone()
        .oneshot(
            Request::post("/api/v1/rooms/209/events")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"recorded_at": "2026-07-31T11:00:00+08:00"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    let response = app
        .oneshot(
            Request::get("/api/v1/rooms/209/events")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let types: Vec<&str> = body
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value["marker_type"].as_str().unwrap())
        .collect();
    assert_eq!(types, vec!["start", "end", "start", "end"]);
}

#[tokio::test]
async fn rejects_invalid_room_ids() {
    let (app, _temp) = test_app().await;
    let response = app
        .oneshot(
            Request::post("/api/v1/events")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"room_id":0}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
}
