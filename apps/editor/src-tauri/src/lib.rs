use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
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
async fn select_video_files(app: AppHandle) -> Result<Vec<VideoInfo>, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter("OBS Matroska video", &["mkv"])
        .blocking_pick_files()
        .unwrap_or_default();

    let mut videos = Vec::with_capacity(selected.len());
    for file in selected {
        let path = file.into_path().map_err(|error| error.to_string())?;
        app.asset_protocol_scope()
            .allow_file(&path)
            .map_err(|error| error.to_string())?;
        videos.push(probe_video(&app, &path).await?);
    }
    videos.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(videos)
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
            select_video_files,
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
