use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{ShellExt, process::Output};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoInfo {
    path: String,
    name: String,
    duration_ms: i64,
    width: Option<u32>,
    height: Option<u32>,
    video_codec: Option<String>,
    audio_codec: Option<String>,
    file_size_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipJob {
    input_path: String,
    output_name: String,
    start_seconds: f64,
    duration_seconds: f64,
    mode: ExportMode,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum ExportMode {
    StreamCopy,
    Precise,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    output_path: String,
    elapsed_ms: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolStatus {
    ffmpeg: bool,
    ffprobe: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct ServerEvent {
    id: i64,
    recorded_at_ms: i64,
}

#[derive(Debug, Deserialize)]
struct ServerError {
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProbeResult {
    format: ProbeFormat,
    #[serde(default)]
    streams: Vec<ProbeStream>,
}

#[derive(Debug, Deserialize)]
struct ProbeFormat {
    duration: String,
}

#[derive(Debug, Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

#[tauri::command]
async fn select_video_file(app: AppHandle) -> Result<Option<VideoInfo>, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter("OBS Matroska video", &["mkv"])
        .blocking_pick_file();

    let Some(file) = selected else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|error| error.to_string())?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|error| error.to_string())?;
    probe_video(&app, &path).await.map(Some)
}

#[tauri::command]
async fn import_server_events(
    server_url: String,
    room_id: i64,
) -> Result<Vec<ServerEvent>, String> {
    if room_id <= 0 {
        return Err("廳 ID 必須是正整數".into());
    }
    let url = server_events_url(&server_url, room_id)?;
    fetch_json(url).await
}

fn server_events_url(server_url: &str, room_id: i64) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(server_url.trim())
        .map_err(|_| "Server URL 格式無效，請輸入 http:// 或 https:// 網址".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return Err("Server URL 必須是有效的 http:// 或 https:// 網址".into());
    }
    url.set_query(None);
    url.set_fragment(None);
    let room_id = room_id.to_string();
    url.path_segments_mut()
        .map_err(|_| "Server URL 無法附加 API 路徑".to_string())?
        .pop_if_empty()
        .extend(["api", "v1", "rooms", room_id.as_str(), "events"]);
    Ok(url)
}

async fn fetch_json<T: DeserializeOwned>(url: reqwest::Url) -> Result<T, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("無法建立網路連線: {error}"))?;
    let response = client.get(url.clone()).send().await.map_err(|error| {
        if error.is_timeout() {
            format!(
                "連線逾時，請確認 Server 正在執行且可從這台電腦連線：{}",
                url.origin().ascii_serialization()
            )
        } else if error.is_connect() {
            format!(
                "無法連線到 {}，請確認網址、連接埠與 Server 狀態",
                url.origin().ascii_serialization()
            )
        } else {
            format!("匯入時間資料失敗: {error}")
        }
    })?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("無法讀取 Server 回應: {error}"))?;
    if !status.is_success() {
        let detail = serde_json::from_str::<ServerError>(&body)
            .ok()
            .and_then(|payload| payload.error)
            .unwrap_or_else(|| body.chars().take(240).collect());
        return Err(if detail.trim().is_empty() {
            format!("Server 回傳 HTTP {status}")
        } else {
            format!("Server 回傳 HTTP {status}: {detail}")
        });
    }
    serde_json::from_str(&body).map_err(|error| format!("Server 回應不是有效的時間資料: {error}"))
}

#[tauri::command]
fn select_output_directory(app: AppHandle) -> Result<Option<String>, String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|path| {
            path.into_path()
                .map(|path| path.to_string_lossy().into_owned())
        })
        .transpose()
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn check_tools(app: AppHandle) -> ToolStatus {
    ToolStatus {
        ffmpeg: run_tool(&app, "ffmpeg", &["-version".into()]).await.is_ok(),
        ffprobe: run_tool(&app, "ffprobe", &["-version".into()])
            .await
            .is_ok(),
    }
}

#[tauri::command]
async fn export_clips(
    app: AppHandle,
    output_directory: String,
    jobs: Vec<ClipJob>,
) -> Result<Vec<ExportResult>, String> {
    let output_directory = PathBuf::from(output_directory);
    fs::create_dir_all(&output_directory).map_err(|error| error.to_string())?;
    if jobs.is_empty() {
        return Err("沒有可輸出的完整議程".into());
    }

    let mut results = Vec::with_capacity(jobs.len());
    for job in jobs {
        validate_job(&job)?;
        let file_name = Path::new(&job.output_name)
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "輸出檔名無效".to_string())?;
        if file_name != job.output_name {
            return Err("輸出檔名不可包含路徑".into());
        }
        let output_path = output_directory.join(file_name);
        let started = std::time::Instant::now();
        let args = ffmpeg_args(&job, &output_path);
        let output = run_tool(&app, "ffmpeg", &args).await?;
        ensure_success("ffmpeg", output)?;
        results.push(ExportResult {
            output_path: output_path.to_string_lossy().into_owned(),
            elapsed_ms: started.elapsed().as_millis(),
        });
    }
    Ok(results)
}

async fn probe_video(app: &AppHandle, path: &Path) -> Result<VideoInfo, String> {
    let args = vec![
        "-v".into(),
        "error".into(),
        "-show_entries".into(),
        "format=duration:stream=codec_type,codec_name,width,height".into(),
        "-of".into(),
        "json".into(),
        path.to_string_lossy().into_owned(),
    ];
    let output = run_tool(app, "ffprobe", &args).await?;
    let output = ensure_success("ffprobe", output)?;
    let probe: ProbeResult = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("無法解析 ffprobe 結果: {error}"))?;
    let duration_ms = (probe
        .format
        .duration
        .parse::<f64>()
        .map_err(|_| "ffprobe 沒有回傳有效的影片長度".to_string())?
        * 1000.0)
        .round() as i64;
    let video_stream = probe
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"));
    let audio_stream = probe
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("audio"));
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;

    Ok(VideoInfo {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("video.mkv")
            .to_owned(),
        duration_ms,
        width: video_stream.and_then(|stream| stream.width),
        height: video_stream.and_then(|stream| stream.height),
        video_codec: video_stream.and_then(|stream| stream.codec_name.clone()),
        audio_codec: audio_stream.and_then(|stream| stream.codec_name.clone()),
        file_size_bytes: metadata.len(),
    })
}

async fn run_tool(app: &AppHandle, name: &str, args: &[String]) -> Result<Output, String> {
    let sidecar_name = format!("binaries/coscup-{name}");
    if let Ok(command) = app.shell().sidecar(sidecar_name) {
        if let Ok(output) = command.args(args).output().await {
            return Ok(output);
        }
    }
    app.shell()
        .command(name)
        .args(args)
        .output()
        .await
        .map_err(|error| format!("找不到 {name}: {error}"))
}

fn ensure_success(name: &str, output: Output) -> Result<Output, String> {
    if output.status.success() {
        return Ok(output);
    }
    let message = String::from_utf8_lossy(&output.stderr);
    let tail = message
        .lines()
        .rev()
        .take(8)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!("{name} 執行失敗\n{tail}"))
}

fn validate_job(job: &ClipJob) -> Result<(), String> {
    if !Path::new(&job.input_path).is_file() {
        return Err(format!("來源影片不存在: {}", job.input_path));
    }
    if !job.start_seconds.is_finite() || job.start_seconds < 0.0 {
        return Err("裁切開始時間無效".into());
    }
    if !job.duration_seconds.is_finite() || job.duration_seconds <= 0.0 {
        return Err("裁切長度必須大於 0".into());
    }
    Ok(())
}

fn ffmpeg_args(job: &ClipJob, output_path: &Path) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-ss".into(),
        format!("{:.3}", job.start_seconds),
        "-i".into(),
        job.input_path.clone(),
        "-t".into(),
        format!("{:.3}", job.duration_seconds),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "0:a?".into(),
        "-map_metadata".into(),
        "0".into(),
    ];
    match job.mode {
        ExportMode::StreamCopy => {
            args.extend(["-c".into(), "copy".into()]);
        }
        ExportMode::Precise => {
            args.extend([
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "medium".into(),
                "-crf".into(),
                "18".into(),
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                "320k".into(),
            ]);
        }
    }
    args.extend([
        "-movflags".into(),
        "+faststart".into(),
        output_path.to_string_lossy().into_owned(),
    ]);
    args
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            select_video_file,
            import_server_events,
            select_output_directory,
            check_tools,
            export_clips
        ])
        .run(tauri::generate_context!())
        .expect("error while running COSCUP Cut");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        thread,
    };

    #[test]
    fn stream_copy_preserves_streams_without_reencoding() {
        let job = ClipJob {
            input_path: "/tmp/source.mkv".into(),
            output_name: "clip.mp4".into(),
            start_seconds: 12.5,
            duration_seconds: 30.0,
            mode: ExportMode::StreamCopy,
        };
        let args = ffmpeg_args(&job, Path::new("/tmp/clip.mp4"));
        assert!(args.windows(2).any(|pair| pair == ["-c", "copy"]));
        assert_eq!(args.last().unwrap(), "/tmp/clip.mp4");
    }

    #[test]
    fn builds_server_event_url_and_preserves_base_path() {
        let url = server_events_url("https://times.example.test/coscup/?debug=1", 209).unwrap();
        assert_eq!(
            url.as_str(),
            "https://times.example.test/coscup/api/v1/rooms/209/events"
        );
    }

    #[test]
    fn rejects_non_http_server_urls() {
        assert!(server_events_url("file:///tmp/events.json", 209).is_err());
        assert!(server_events_url("localhost:3000", 209).is_err());
    }

    #[test]
    fn fetches_server_events_over_http() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request_line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut request_line)
                .unwrap();
            assert_eq!(request_line, "GET /api/v1/rooms/209/events HTTP/1.1\r\n");
            let body = r#"[{"id":7,"recorded_at_ms":1785438634000}]"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        });

        let url = server_events_url(&format!("http://{address}"), 209).unwrap();
        let events: Vec<ServerEvent> = tauri::async_runtime::block_on(fetch_json(url)).unwrap();
        server.join().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, 7);
        assert_eq!(events[0].recorded_at_ms, 1_785_438_634_000);
    }

    #[test]
    fn precise_mode_uses_high_quality_h264_and_aac() {
        let job = ClipJob {
            input_path: "/tmp/source.mkv".into(),
            output_name: "clip.mp4".into(),
            start_seconds: 0.0,
            duration_seconds: 30.0,
            mode: ExportMode::Precise,
        };
        let args = ffmpeg_args(&job, Path::new("/tmp/clip.mp4"));
        assert!(args.windows(2).any(|pair| pair == ["-crf", "18"]));
        assert!(args.iter().any(|value| value == "libx264"));
    }
}
