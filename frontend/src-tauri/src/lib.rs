use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};
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
            ensure_local_whisperx_ready,
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

#[derive(Default)]
struct LocalBackendState {
    child: Mutex<Option<Child>>,
    whisperx_started_by_app: Mutex<bool>,
}

const LOCAL_WHISPERX_IMAGE: &str = "whisperx-server:local";
const LOCAL_WHISPERX_SETUP_REQUIRED: &str = "LOCAL_WHISPERX_SETUP_REQUIRED";
const LOCAL_WHISPERX_REBUILD_REQUIRED: &str = "LOCAL_WHISPERX_REBUILD_REQUIRED";

#[derive(Debug, Deserialize)]
struct WhisperxHealthResponse {
    status: Option<String>,
    #[serde(default)]
    server_version: Option<String>,
}

impl LocalBackendState {
    fn stop_managed_processes(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }

        if let Ok(mut started_by_app) = self.whisperx_started_by_app.lock() {
            if *started_by_app {
                let _ = stop_local_whisperx_container();
                *started_by_app = false;
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

fn fetch_http_health(endpoint: SocketAddr) -> Option<WhisperxHealthResponse> {
    let mut stream = match TcpStream::connect_timeout(&endpoint, Duration::from_millis(500)) {
        Ok(stream) => stream,
        Err(_) => return None,
    };

    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));

    let request = format!(
        "GET /health HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\n\r\n",
        endpoint.ip(),
        endpoint.port()
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return None;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return None;
    }

    if !(response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")) {
        return None;
    }

    let (_, body) = response.split_once("\r\n\r\n")?;
    serde_json::from_str(body).ok()
}

fn is_http_health_ready(endpoint: SocketAddr) -> bool {
    fetch_http_health(endpoint)
        .and_then(|health| health.status)
        .as_deref()
        == Some("ok")
}

fn wait_until_http_health_ready(endpoint: SocketAddr, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if is_http_health_ready(endpoint) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err(format!(
        "local transcript service did not become healthy within {}s on http://{}:{}/health",
        timeout.as_secs(),
        endpoint.ip(),
        endpoint.port()
    ))
}

fn open_log_file(path: &Path) -> io::Result<std::fs::File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
}

#[tauri::command]
fn ensure_local_whisperx_ready(
    state: State<'_, LocalBackendState>,
    service_url: String,
    allow_setup: bool,
) -> Result<(), String> {
    let endpoint = parse_local_service_url(&service_url)?;
    let repo_root = resolve_repo_root()?;
    let server_dir = repo_root.join("whisperx-server");
    if !server_dir.exists() {
        return Err(String::from("whisperx-server directory not found"));
    }
    let expected_version = compute_local_whisperx_version(&server_dir)?;

    let mut needs_rebuild = false;
    if let Some(health) = fetch_http_health(endpoint) {
        if health.status.as_deref() == Some("ok")
            && health.server_version.as_deref() == Some(expected_version.as_str())
        {
            return Ok(());
        }

        needs_rebuild = true;
        if !allow_setup {
            return Err(String::from(LOCAL_WHISPERX_REBUILD_REQUIRED));
        }
    }

    let image_exists = docker_image_exists(&server_dir)?;
    if !image_exists && !allow_setup {
        return Err(String::from(LOCAL_WHISPERX_SETUP_REQUIRED));
    }

    let compose_args = if allow_setup && (needs_rebuild || !image_exists) {
        vec!["up", "-d", "--build", "--force-recreate"]
    } else if allow_setup {
        vec!["up", "-d", "--build"]
    } else {
        vec!["up", "-d", "--no-build"]
    };
    let output = run_compose_command(
        &server_dir,
        &compose_args,
        "failed to run docker compose",
        &[("WHISPERX_SERVER_VERSION", expected_version.as_str())],
    )?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "docker compose failed{}",
            if stderr.is_empty() { String::new() } else { format!(": {stderr}") }
        ));
    }

    if let Ok(mut started_by_app) = state.whisperx_started_by_app.lock() {
        *started_by_app = true;
    }

    wait_until_http_health_ready(endpoint, Duration::from_secs(120))?;

    let health = fetch_http_health(endpoint)
        .ok_or_else(|| String::from("failed to read WhisperX health response after startup"))?;
    if health.server_version.as_deref() != Some(expected_version.as_str()) {
        return Err(format!(
            "local WhisperX version mismatch after startup: expected {}, got {}",
            expected_version,
            health.server_version.as_deref().unwrap_or("unknown")
        ));
    }

    Ok(())
}

fn docker_image_exists(server_dir: &Path) -> Result<bool, String> {
    let mut command = Command::new("docker");
    command
        .current_dir(server_dir)
        .args(["image", "inspect", LOCAL_WHISPERX_IMAGE])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    prepare_hidden_command(&mut command);
    let output = run_command_output(&mut command, "failed to inspect local WhisperX image")?;

    if output.status.success() {
        return Ok(true);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.contains("No such image")
        || stderr.contains("No such object")
        || stderr.contains("not found")
    {
        return Ok(false);
    }

    Err(format!(
        "failed to inspect local WhisperX image{}",
        if stderr.is_empty() { String::new() } else { format!(": {stderr}") }
    ))
}

fn stop_local_whisperx_container() -> Result<(), String> {
    let repo_root = resolve_repo_root()?;
    let server_dir = repo_root.join("whisperx-server");
    let output = run_compose_command(
        &server_dir,
        &["stop", "whisperx"],
        "failed to stop docker compose whisperx",
        &[],
    )?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!(
            "docker compose stop failed{}",
            if stderr.is_empty() { String::new() } else { format!(": {stderr}") }
        ))
    }
}

fn run_compose_command(
    server_dir: &Path,
    args: &[&str],
    context: &str,
    envs: &[(&str, &str)],
) -> Result<Output, String> {
    let docker_compose = {
        let mut command = Command::new("docker-compose");
        command.current_dir(server_dir).args(args).envs(envs.iter().copied());
        prepare_hidden_command(&mut command);
        run_command_output(&mut command, context)
    };

    match docker_compose {
        Ok(output) => Ok(output),
        Err(compose_error) => {
            let mut command = Command::new("docker");
            command
                .current_dir(server_dir)
                .arg("compose")
                .args(args)
                .envs(envs.iter().copied());
            prepare_hidden_command(&mut command);
            run_command_output(&mut command, context).map_err(|docker_error| {
                format!("{compose_error}; fallback docker compose also failed: {docker_error}")
            })
        }
    }
}

fn compute_local_whisperx_version(server_dir: &Path) -> Result<String, String> {
    let path = server_dir.join("server.py");
    let contents = fs::read(&path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let digest = Sha256::digest(contents);
    Ok(format!("{:x}", digest)[..16].to_string())
}

fn run_command_output(command: &mut Command, context: &str) -> Result<Output, String> {
    command
        .output()
        .map_err(|error| format!("{context}: {error}"))
}

fn prepare_hidden_command(command: &mut Command) {
    command.stdout(Stdio::null()).stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
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
