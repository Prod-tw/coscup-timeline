# COSCUP Time Suite

COSCUP 現場議程時間記錄與 OBS 影片剪輯工具。包含：

- `coscup-time-server`：Axum REST API、SQLite 與現場 dashboard。
- `COSCUP Cut`：Tauri 2 跨平台桌面剪輯器，支援 Windows、macOS、Linux。
- ffmpeg / ffprobe sidecar：bundle 時一併放入桌面安裝檔。

## Server

按鈕每次只要送出廳 ID。伺服器不要求開始或結束欄位，會使用收到 request 當下的 UTC 時間新增一筆資料。

```bash
curl -X POST http://localhost:3000/api/v1/events \
  -H 'content-type: application/json' \
  -d '{"room_id":209}'
```

主要 API：

| Method | Path | 用途 |
| --- | --- | --- |
| `POST` | `/api/v1/events` | 現場按鈕新增 server timestamp |
| `GET` | `/api/v1/rooms` | 所有廳摘要 |
| `GET` | `/api/v1/rooms/:room_id/events` | 某廳所有時間，依時間排序 |
| `POST` | `/api/v1/rooms/:room_id/events` | 手動新增 RFC 3339 時間 |
| `PATCH` | `/api/v1/events/:id` | 修正時間 |
| `DELETE` | `/api/v1/events/:id` | 刪除誤觸時間 |
| `GET` | `/api/v1/health` | health check |

開始/結束是讀取時依排序位置推導：第 1、3、5 筆是開始，第 2、4、6 筆是結束。新增、移動或刪除時間後，後面的角色會立即重算。資料表本身只保存 `room_id`、timestamp、來源與建立時間。

### Docker

```bash
docker compose up --build
```

Dashboard：<http://localhost:3000>。SQLite 位於 named volume `time-data`。

### 本機開發

```bash
corepack enable
pnpm install
pnpm build:dashboard
pnpm dev:server
```

開啟 <http://localhost:3000> 使用 dashboard。要同時啟動桌面剪輯器，另開一個 terminal：

```bash
pnpm dev:editor
```

可設定：

- `DATABASE_URL`，預設 `sqlite://coscup-time.db`
- `BIND_ADDRESS`，預設 `0.0.0.0:3000`
- `DASHBOARD_DIR`，預設 `apps/dashboard/dist`

## COSCUP Cut

OBS 檔名必須是 `YYYY-MM-DD HH-mm-ss.mkv`，例如 `2026-07-31 03-10-34.mkv`。檔名代表錄影開始的當地時間；編輯器預設使用 `UTC+08:00 台北`，也可在來源側欄更換。

工作流程：

1. 開啟一個 OBS MKV。編輯器一次只使用一支來源影片；更換影片會直接取代目前來源。ffprobe 會讀取實際長度與 codec。
2. 填入 server URL 與廳 ID，匯入該廳時間資料。
3. 用縮放滑桿、按鈕或 Ctrl/Command + 滾輪調整時間軸比例，水平捲動後拖動播放頭與時間針；也能在播放位置或精確日期時間新增一針。
4. 選擇輸出目錄與裁切模式，輸出所有完整的 start/end 配對。

輸出模式：

- 原始串流：`-c copy`，不重編碼並保留原始畫質與聲音；切點受 keyframe 限制。
- 精確切點：H.264 `CRF 18` + AAC `320 kbps`，需要重編碼，但切點精確且 MP4 相容性較高。

時間軸固定使用來源影片的實際長度。若議程時間落在來源影片之外，編輯器會阻止輸出並標示該段。這可避免產生缺頭或缺尾的 MP4。Server 時間資料由桌面端的 Rust HTTP client 匯入，不受 WebView CORS 限制；無法連線、逾時與 Server 錯誤會顯示各自的訊息。

### 桌面安裝檔

本機 bundle 前需要 `ffmpeg` 與 `ffprobe` 在 `PATH`：

```bash
pnpm editor:build
```

`scripts/prepare-sidecars.mjs` 會依 Rust target triple 複製兩個 binary，再由 Tauri `externalBin` 收進 bundle。GitHub Actions 會建置 Linux、macOS、Windows 三平台並上傳 artifact。

本機 bundle 會原樣複製目前 `PATH` 上的 FFmpeg；Linux 發行版套件提供的 binary 通常會動態連結系統函式庫，因此產出的安裝檔只適合相容的本機環境。要提供給其他使用者下載時，請使用 GitHub Actions 在各目標平台產生的 artifact；workflow 會從 FFmpeg 的平台 build 來源下載 `ffmpeg` 與 `ffprobe` 後再打包。目前 FFmpeg action 的 macOS build 僅支援 x64，因此 CI 明確建置 `x86_64-apple-darwin`，產物在 Apple Silicon 上需要 Rosetta。

FFmpeg 的實際授權條款取決於 bundle 使用的 build flags。對外發布安裝檔前，請保留對應 FFmpeg build 的 license 與 source offer，並確認是否包含 GPL codec。

### 在 Windows 本機建置

Windows 10/11 需要 Node.js 24、Rust stable MSVC toolchain、Microsoft C++ Build Tools、WebView2，以及在 `PATH` 中的 `ffmpeg.exe` 與 `ffprobe.exe`。在 PowerShell 執行：

```powershell
corepack enable
pnpm install
pnpm editor:build
```

安裝檔會位於：

- `target\release\bundle\nsis\`：Windows setup `.exe`
- `target\release\bundle\msi\`：Windows `.msi`

若 MSI 建置回報 VBScript 不可用，請在 Windows Optional Features 啟用 VBSCRIPT；也可以直接使用 NSIS 的 setup `.exe`。

### GitHub Actions 跨平台建置

[`.github/workflows/editor-bundles.yml`](.github/workflows/editor-bundles.yml) 會在每次 push 或從 Actions 頁面手動執行時，平行建置：

- `coscup-cut-linux-x64`
- `coscup-cut-macos-x64`
- `coscup-cut-windows-x64`

Push 完成後，到 GitHub repository 的 **Actions > Editor bundles**，打開成功的 workflow run，在 **Artifacts** 區塊下載。Artifact 保留 30 天；Windows ZIP 內包含 NSIS `.exe` 與 MSI `.msi`。macOS 目前是 Intel x64 bundle，在 Apple Silicon 上需要 Rosetta。

## 驗證

```bash
pnpm test
pnpm typecheck
```
