use std::{
    fs::{self, OpenOptions},
    io,
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

use tauri::{Manager, State};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    configure_webview2_user_data_dir();

    let backend_state = LocalBackendState::default();

    tauri::Builder::default()
        .manage(backend_state)
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            ensure_local_legacy_backend_ready,
            check_local_whisperx,
            transcribe_local,
            extract_audio,
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
        Err(format!(
            "イメージが見つかりません。初回転写時に自動で pull されます（約10GB）: {GHCR_WHISPERX_IMAGE}"
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

fn run_whisperx_cli(audio_path: &str, language: &str) -> Result<serde_json::Value, String> {
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
        "/audio/input.wav",
        "--model", "large-v3",
        "--language", language,
        "--output_format", "json",
        "--batch_size", "8",
        "--compute_type", "float16",
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
            return Err(format!("whisperx transcription failed: {details}"));
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
