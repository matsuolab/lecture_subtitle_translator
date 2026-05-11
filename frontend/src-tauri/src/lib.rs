use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{self, Read, Seek, SeekFrom},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use tauri::{Manager, State};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    configure_webview2_user_data_dir();

    let backend_state = LocalBackendState::default();
    let video_server_state = VideoServerState::start()
        .expect("failed to start local video server");

    tauri::Builder::default()
        .manage(backend_state)
        .manage(video_server_state)
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ensure_local_legacy_backend_ready,
            check_local_whisperx,
            transcribe_local,
            extract_audio,
            http_request,
            register_video,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(app) = window.app_handle().try_state::<LocalBackendState>() {
                    app.stop_managed_processes();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}

#[cfg(target_os = "windows")]
fn configure_webview2_user_data_dir() {
    use std::{env, fs, path::PathBuf};

    if env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_some() {
        return;
    }

    let mut user_data_dir = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir);
    user_data_dir.push("jp.matsuolab.subtitle-editor");
    user_data_dir.push("EBWebView");

    if let Err(error) = fs::create_dir_all(&user_data_dir) {
        eprintln!("failed to create WebView2 user data dir: {error}");
        return;
    }

    env::set_var("WEBVIEW2_USER_DATA_FOLDER", user_data_dir);
}

const GHCR_WHISPERX_IMAGE: &str = "ghcr.io/jim60105/whisperx:large-v3-ja";

#[derive(Default)]
struct LocalBackendState {
    child: Mutex<Option<Child>>,
}

impl LocalBackendState {
    fn stop_managed_processes(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[tauri::command]
fn ensure_local_legacy_backend_ready(
    state: State<'_, LocalBackendState>,
    service_url: String,
) -> Result<(), String> {
    let endpoint = parse_local_service_url(&service_url)?;
    if is_port_open(endpoint) {
        return Ok(());
    }

    {
        let mut guard = state
            .child
            .lock()
            .map_err(|_| String::from("failed to lock local backend state"))?;

        if let Some(child) = guard.as_mut() {
            if child
                .try_wait()
                .map_err(|error| format!("failed to inspect local backend: {error}"))?
                .is_none()
            {
                drop(guard);
                return wait_until_port_ready(endpoint);
            }
            *guard = None;
        }

        let repo_root = resolve_repo_root()?;
        let log_dir = repo_root.join("frontend");
        let stdout = open_log_file(&log_dir.join("backend-local.out.log"))
            .map_err(|error| format!("failed to prepare backend stdout log: {error}"))?;
        let stderr = open_log_file(&log_dir.join("backend-local.err.log"))
            .map_err(|error| format!("failed to prepare backend stderr log: {error}"))?;

        let mut command = Command::new("python");
        command
            .current_dir(&repo_root)
            .args([
                "-m",
                "uvicorn",
                "backend.api:app",
                "--host",
                "127.0.0.1",
                "--port",
                &endpoint.port().to_string(),
            ])
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }

        let child = command
            .spawn()
            .map_err(|error| format!("failed to start local backend with python: {error}"))?;
        *guard = Some(child);
    }

    wait_until_port_ready(endpoint)
}

fn parse_local_service_url(service_url: &str) -> Result<SocketAddr, String> {
    let trimmed = service_url.trim().trim_end_matches('/');
    let address = trimmed
        .strip_prefix("http://")
        .ok_or_else(|| String::from("local legacy backend auto-start supports only http:// URLs"))?;
    let host_port = address
        .split('/')
        .next()
        .ok_or_else(|| String::from("invalid service URL"))?;
    let socket: SocketAddr = host_port
        .parse()
        .map_err(|_| String::from("service URL must be a direct host:port pair such as http://127.0.0.1:8765"))?;

    if socket.ip().is_loopback() {
        Ok(socket)
    } else {
        Err(String::from("local legacy backend auto-start only supports loopback addresses"))
    }
}

fn wait_until_port_ready(endpoint: SocketAddr) -> Result<(), String> {
    wait_until_port_ready_with_timeout(endpoint, Duration::from_secs(15))
}

fn wait_until_port_ready_with_timeout(endpoint: SocketAddr, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if is_port_open(endpoint) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "local service did not start within {}s on http://{}:{}",
        timeout.as_secs(),
        endpoint.ip(),
        endpoint.port()
    ))
}

fn is_port_open(endpoint: SocketAddr) -> bool {
    TcpStream::connect_timeout(&endpoint, Duration::from_millis(400)).is_ok()
}

fn open_log_file(path: &Path) -> io::Result<std::fs::File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
}

fn run_command_output(command: &mut Command, context: &str) -> Result<Output, String> {
    command
        .output()
        .map_err(|error| format!("{context}: {error}"))
}

#[tauri::command]
async fn extract_audio(app: tauri::AppHandle, video_path: String) -> Result<String, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cache dir unavailable: {e}"))?;
    fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("failed to create cache dir: {e}"))?;
    let output_path = cache_dir
        .join("extracted_audio.wav")
        .to_string_lossy()
        .into_owned();
    let output_clone = output_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("ffmpeg")
            .args([
                "-i", &video_path,
                "-vn",
                "-acodec", "pcm_s16le",
                "-ar", "16000",
                "-ac", "1",
                &output_clone,
                "-y",
            ])
            .output()
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
    .map_err(|e| format!("ffmpeg exec failed: {e}"))?;

    if result.status.success() {
        Ok(output_path)
    } else {
        Err(String::from_utf8_lossy(&result.stderr).into_owned())
    }
}

// WebKit/CORS制限を迂回するための汎用HTTPクライアント
// Linux/Mac の tauri://localhost オリジンが外部API(S3/OpenAI等)のCORSで拒否されるため、
// ブラウザのfetchではなく Rust の reqwest で直接通信する
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpRequestOptions {
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body_text: Option<String>,
    body_file: Option<String>,
}

#[derive(Serialize)]
struct HttpResponsePayload {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

#[tauri::command]
async fn http_request(options: HttpRequestOptions) -> Result<HttpResponsePayload, String> {
    let method = options
        .method
        .parse::<reqwest::Method>()
        .map_err(|e| format!("invalid HTTP method '{}': {e}", options.method))?;

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;

    let mut req = client.request(method, &options.url);
    for (key, value) in &options.headers {
        req = req.header(key.as_str(), value.as_str());
    }

    if let Some(file_path) = options.body_file.as_ref() {
        let path_clone = file_path.clone();
        let bytes = tauri::async_runtime::spawn_blocking(move || fs::read(&path_clone))
            .await
            .map_err(|e| format!("spawn_blocking failed: {e}"))?
            .map_err(|e| format!("failed to read upload file '{file_path}': {e}"))?;
        req = req.body(bytes);
    } else if let Some(body) = options.body_text {
        req = req.body(body);
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("HTTP request to {} failed: {e}", options.url))?;

    let status = response.status().as_u16();
    let response_headers: HashMap<String, String> = response
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();

    let body = response
        .text()
        .await
        .map_err(|e| format!("failed to read response body: {e}"))?;

    Ok(HttpResponsePayload {
        status,
        headers: response_headers,
        body,
    })
}

#[tauri::command]
fn check_local_whisperx() -> Result<String, String> {
    let mut docker_info = Command::new("docker");
    docker_info.args(["info", "--format", "{{.ServerVersion}}"]);
    docker_info.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        docker_info.creation_flags(0x0800_0000);
    }
    let info_output = run_command_output(&mut docker_info, "docker info")
        .map_err(|_| String::from("Docker が見つかりません。Docker Desktop をインストールして起動してください"))?;
    if !info_output.status.success() {
        return Err(String::from(
            "Docker デーモンが起動していません。Docker Desktop を起動してください",
        ));
    }
    let docker_version = String::from_utf8_lossy(&info_output.stdout).trim().to_string();

    let mut inspect = Command::new("docker");
    inspect.args(["image", "inspect", "--format", "{{.Id}}", GHCR_WHISPERX_IMAGE]);
    inspect.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        inspect.creation_flags(0x0800_0000);
    }
    let inspect_output = run_command_output(&mut inspect, "docker image inspect")?;
    if inspect_output.status.success() {
        Ok(format!(
            "OK: Docker {docker_version} / イメージ {GHCR_WHISPERX_IMAGE} はローカルに存在します"
        ))
    } else {
        Ok(format!(
            "OK: Docker {docker_version} / イメージ未取得。初回転写時に自動で pull されます（約10GB）: {GHCR_WHISPERX_IMAGE}"
        ))
    }
}

#[tauri::command]
async fn transcribe_local(audio_path: String, language: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_whisperx_cli(&audio_path, &language)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

fn run_whisperx_cli(audio_path: &str, _language: &str) -> Result<serde_json::Value, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let output_dir = std::env::temp_dir().join(format!("whisperx_out_{ts}"));

    fs::create_dir_all(&output_dir)
        .map_err(|e| format!("failed to create temp output dir: {e}"))?;

    // Windows パスのバックスラッシュをフォワードスラッシュに変換（Docker Desktop WSL2対応）
    let audio_host = audio_path.replace('\\', "/");
    let output_host = output_dir.display().to_string().replace('\\', "/");
    let audio_mount = format!("{audio_host}:/audio/input.wav:ro");
    let output_mount = format!("{output_host}:/output");

    let mut command = Command::new("docker");
    command.args([
        "run", "--rm",
        "--gpus", "all",
        "-v", &audio_mount,
        "-v", &output_mount,
        GHCR_WHISPERX_IMAGE,
        "--",              // /bin/sh -c "whisperx $@" の $0 に食われるダミー
        "/audio/input.wav",
        "--output_format", "json",
        "--output_dir", "/output",
    ]);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    let docker_result = run_command_output(&mut command, "docker run whisperx");

    let result = (|| -> Result<serde_json::Value, String> {
        let output = docker_result?;
        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let details = [stdout.as_str(), stderr.as_str()]
                .iter()
                .filter(|s| !s.is_empty())
                .cloned()
                .collect::<Vec<_>>()
                .join("\n");
            return Err(format!(
                "whisperx transcription failed\naudio_mount: {audio_mount}\noutput_mount: {output_mount}\n{details}"
            ));
        }
        let result_path = output_dir.join("input.json");
        let bytes = fs::read(&result_path)
            .map_err(|e| format!("failed to read transcription result: {e}"))?;
        serde_json::from_slice(&bytes)
            .map_err(|e| format!("failed to parse transcription result: {e}"))
    })();

    let _ = fs::remove_dir_all(&output_dir);
    result
}

// ローカル動画HTTPサーバ
// WebKitGTK(Linux)/WKWebView(Mac) はカスタムURIスキーム(asset:// videofile://)
// から <video> 要素にデータを供給できないため、127.0.0.1 上にHTTPサーバを起動して
// Range対応でストリーミング配信する。
// セキュリティ:
// - 127.0.0.1 のみバインド(外部ネットワーク不可)
// - 動画ごとに128bitランダムトークンを発行(任意パス読取不可)
// - トークンはメモリ上のみ(セッション終了で消失)
const VIDEO_CHUNK_MAX: u64 = 32 * 1024 * 1024; // 32MiB per Range response

struct VideoServerState {
    port: u16,
    tokens: Arc<Mutex<HashMap<String, PathBuf>>>,
}

impl VideoServerState {
    fn start() -> Result<Self, String> {
        let server = tiny_http::Server::http("127.0.0.1:0")
            .map_err(|e| format!("failed to bind video server: {e}"))?;
        let port = server
            .server_addr()
            .to_ip()
            .ok_or_else(|| String::from("video server has no IP address"))?
            .port();

        let tokens: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::new(Mutex::new(HashMap::new()));
        let tokens_clone = Arc::clone(&tokens);

        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let tokens = Arc::clone(&tokens_clone);
                std::thread::spawn(move || {
                    if let Err(e) = handle_video_request(request, tokens) {
                        eprintln!("video server request error: {e}");
                    }
                });
            }
        });

        Ok(Self { port, tokens })
    }
}

fn cors_headers() -> Vec<tiny_http::Header> {
    vec![
        tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
        tiny_http::Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET, OPTIONS, HEAD"[..]).unwrap(),
        tiny_http::Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Range, If-Range, If-None-Match, If-Modified-Since"[..]).unwrap(),
        tiny_http::Header::from_bytes(&b"Access-Control-Expose-Headers"[..], &b"Content-Length, Content-Range, Accept-Ranges"[..]).unwrap(),
    ]
}

fn handle_video_request(
    request: tiny_http::Request,
    tokens: Arc<Mutex<HashMap<String, PathBuf>>>,
) -> std::io::Result<()> {
    // OPTIONS preflight 対応
    if request.method() == &tiny_http::Method::Options {
        let mut response = tiny_http::Response::empty(204);
        for h in cors_headers() {
            response.add_header(h);
        }
        return request.respond(response);
    }

    let url = request.url().to_string();
    let token = match url.strip_prefix("/video/") {
        Some(s) => s.split('?').next().unwrap_or(s),
        None => {
            return request.respond(
                tiny_http::Response::from_string("not found").with_status_code(404),
            );
        }
    };

    let path = {
        let guard = tokens.lock().unwrap();
        guard.get(token).cloned()
    };

    let path = match path {
        Some(p) => p,
        None => {
            return request.respond(
                tiny_http::Response::from_string("invalid token").with_status_code(403),
            );
        }
    };

    let metadata = match fs::metadata(&path) {
        Ok(m) => m,
        Err(_) => {
            return request.respond(
                tiny_http::Response::from_string("file not found").with_status_code(404),
            );
        }
    };
    let file_size = metadata.len();

    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("mkv") => "video/x-matroska",
        Some("webm") => "video/webm",
        Some("avi") => "video/x-msvideo",
        _ => "video/mp4",
    };

    let range_str = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());

    let mut file = match fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => {
            return request.respond(
                tiny_http::Response::from_string("open failed").with_status_code(500),
            );
        }
    };

    let has_range = range_str.is_some();
    let (start, end) = if let Some(range) = range_str
        .as_deref()
        .and_then(|r| parse_range_header(r, file_size))
    {
        let (s, e) = range;
        let actual_end = e.min(s + VIDEO_CHUNK_MAX - 1).min(file_size.saturating_sub(1));
        (s, actual_end)
    } else {
        // Rangeなしの初回要求: 全長ヒントを返しつつ最初のチャンクを送る
        (0, file_size.saturating_sub(1).min(VIDEO_CHUNK_MAX - 1))
    };
    let length = end.saturating_sub(start) + 1;

    if file.seek(SeekFrom::Start(start)).is_err() {
        return request.respond(
            tiny_http::Response::from_string("seek failed").with_status_code(416),
        );
    }

    let limited = file.take(length);
    // Rangeリクエスト → 206 Partial Content
    // 通常GET → 200 OK
    let status = if has_range { 206 } else { 200 };
    let mut response = tiny_http::Response::new(
        tiny_http::StatusCode(status),
        Vec::new(),
        limited,
        Some(length as usize),
        None,
    );
    response.add_header(
        tiny_http::Header::from_bytes(&b"Content-Type"[..], mime.as_bytes()).unwrap(),
    );
    if has_range {
        response.add_header(
            tiny_http::Header::from_bytes(
                &b"Content-Range"[..],
                format!("bytes {start}-{end}/{file_size}").as_bytes(),
            )
            .unwrap(),
        );
    }
    response.add_header(
        tiny_http::Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]).unwrap(),
    );
    response.add_header(
        tiny_http::Header::from_bytes(
            &b"Cache-Control"[..],
            &b"no-cache, no-store, must-revalidate"[..],
        )
        .unwrap(),
    );
    for h in cors_headers() {
        response.add_header(h);
    }

    request.respond(response)
}

fn parse_range_header(range: &str, file_size: u64) -> Option<(u64, u64)> {
    let range = range.strip_prefix("bytes=")?;
    let mut parts = range.splitn(2, '-');
    let start: u64 = parts.next()?.parse().ok()?;
    let end: u64 = parts
        .next()
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse().ok())
        .unwrap_or(file_size.saturating_sub(1))
        .min(file_size.saturating_sub(1));
    (start <= end && start < file_size).then_some((start, end))
}

fn generate_video_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("getrandom failed");
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[tauri::command]
fn register_video(
    state: tauri::State<'_, VideoServerState>,
    path: String,
) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        return Err(format!("video file not found: {path}"));
    }
    let token = generate_video_token();
    state
        .tokens
        .lock()
        .map_err(|e| format!("token lock poisoned: {e}"))?
        .insert(token.clone(), path_buf);
    Ok(format!("http://127.0.0.1:{}/video/{}", state.port, token))
}

fn resolve_repo_root() -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        return manifest_dir
            .parent()
            .and_then(|path| path.parent())
            .map(Path::to_path_buf)
            .ok_or_else(|| String::from("failed to resolve repo root from Cargo manifest dir"));
    }

    let exe_dir = std::env::current_exe()
        .map_err(|error| format!("failed to inspect current executable path: {error}"))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| String::from("failed to resolve executable directory"))?;

    let candidate = exe_dir.join("backend");
    if candidate.exists() {
        Ok(exe_dir)
    } else {
        Err(String::from(
            "packaged local legacy backend is not bundled yet; use managed service or run the backend manually",
        ))
    }
}
