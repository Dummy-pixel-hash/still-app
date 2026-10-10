//! M5 host-key verification tests (deterministic, real localhost sshd).
//!
//! - Uses the REAL system sshd on 127.0.0.1:22222 (same as headless_ssh.rs).
//! - `STILL_KNOWN_HOSTS` points at an isolated temp file per test, so the
//!   user's real trust store is never touched.
//! - Covers: unknown -> refused + fingerprint exposed; trust -> stored;
//!   reconnect -> verified; changed key -> refused; reject -> no trust;
//!   malformed store -> fail closed; pre-trusted -> connected via worker.
//!
//! Run: cargo test --offline --test hostkey_m5

use std::time::Duration;

use still_app::{core, hostkeys, ssh_worker};

static SERIAL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn serial_lock() -> SerialGuard {
    while SERIAL.compare_exchange_weak(false, true, std::sync::atomic::Ordering::Acquire, std::sync::atomic::Ordering::Relaxed).is_err() {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    SerialGuard
}

struct SerialGuard;

impl Drop for SerialGuard {
    fn drop(&mut self) {
        SERIAL.store(false, std::sync::atomic::Ordering::Release);
    }
}

fn check(name: &str, cond: bool) {
    println!("{}: {}", name, if cond { "PASS" } else { "FAIL" });
    if !cond {
        panic!("hostkey_m5 check failed: {name}");
    }
}

/// Isolated trust store for one test; restored afterwards.
struct IsolatedStore {
    dir: std::path::PathBuf,
    _prev: Option<String>,
}

impl IsolatedStore {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "still-hk-m5-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let prev = std::env::var("STILL_KNOWN_HOSTS").ok();
        unsafe { std::env::set_var("STILL_KNOWN_HOSTS", dir.join("known_hosts.json")) };
        Self { dir, _prev: prev }
    }
}

impl Drop for IsolatedStore {
    fn drop(&mut self) {
        // Keep STILL_KNOWN_HOSTS pointing at OUR file until the next test
        // overwrites it under SERIAL. Restoring here would race sibling tests.
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn drain(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<core::SessionEvent>,
) -> Vec<core::SessionEvent> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        out.push(ev);
    }
    out
}

fn find_prompt(evs: &[core::SessionEvent]) -> Option<core::HostKeyPrompt> {
    for ev in evs {
        if let core::SessionEvent::HostKeyPrompt { prompt } = ev {
            return Some(prompt.clone());
        }
    }
    None
}

fn find_error_code(evs: &[core::SessionEvent]) -> Option<String> {
    for ev in evs {
        if let core::SessionEvent::Error { error } = ev {
            return Some(error.code.clone());
        }
    }
    None
}

fn test_cfg() -> core::SshConfig {
    core::SshConfig {
        host: "127.0.0.1".into(),
        port: 22222,
        username: "nobody-invalid".into(),
        tmux_session: "still-m5-probe".into(),
        working_directory: None,
        cols: 80,
        rows: 24,
    }
}

async fn run_worker_once(cfg: core::SshConfig) -> Vec<core::SessionEvent> {
    let (etx, mut erx) = tokio::sync::mpsc::unbounded_channel();
    let (_itx, irx) = tokio::sync::mpsc::unbounded_channel();
    let (_rtx, rrx) = tokio::sync::mpsc::unbounded_channel();
    let (_stx, srx) = tokio::sync::oneshot::channel();
    // No credentials: verification must refuse BEFORE auth matters.
    ssh_worker::run_session(cfg, None, None, etx, irx, rrx, srx).await;
    // Give the event loop a beat to flush (run_session sends synchronously,
    // but be tolerant).
    tokio::time::sleep(Duration::from_millis(50)).await;
    drain(&mut erx)
}

#[tokio::test]
async fn m5_unknown_host_refused_with_fingerprint() {
    let _guard = serial_lock();
    let _iso = IsolatedStore::new("unknown");
    // 1. unknown host -> not connected
    let evs = run_worker_once(test_cfg()).await;
    // 2. fingerprint exposed via HostKeyPrompt event
    let prompt = find_prompt(&evs).expect("unknown host must emit HostKeyPrompt");
    check("unknown emits prompt", true);
    check("prompt is not 'changed'", !prompt.changed);
    check("fingerprint non-empty", !prompt.fingerprint.is_empty());
    check(
        "fingerprint is SHA256 form",
        prompt.fingerprint.starts_with("SHA256:"),
    );
    check("openssh key non-empty", !prompt.openssh_key.is_empty());
    check("no stored trust", !hostkeys::was_ever_trusted("127.0.0.1", 22222));
    // Typed error, never a silent connect.
    let code = find_error_code(&evs).expect("unknown host must emit typed error");
    check("typed host_key_unknown", code == "host_key_unknown");
    let live = evs
        .iter()
        .any(|e| matches!(e, core::SessionEvent::Status { status: core::SessionStatus::Live }));
    check("never reaches Live", !live);
}

#[tokio::test]
async fn m5_trust_then_reconnect_verified() {
    let _guard = serial_lock();
    let _iso = IsolatedStore::new("trust");
    // Probe live key (no auth) — this is what the UI shows.
    let (kt, openssh, fp) = ssh_worker::probe_host_key("127.0.0.1", 22222)
        .await
        .expect("probe localhost sshd");
    check("probe key type", !kt.is_empty());
    check("probe fingerprint", fp.starts_with("SHA256:"));
    // 3. accept -> stored trust (simulates still_trust_host TOCTOU path:
    // re-probe must equal what the user approved).
    let ( _kt2, live2, _fp2) = ssh_worker::probe_host_key("127.0.0.1", 22222).await.unwrap();
    check("live key stable across probes", live2.trim() == openssh.trim());
    hostkeys::store_trusted("127.0.0.1", 22222, openssh.trim()).expect("store trust");
    check("trusted now", hostkeys::is_trusted("127.0.0.1", 22222, openssh.trim()));
    // 4. reconnect with WRONG credentials but trusted key -> must get PAST
    // host verification to auth failure (proves verification passed).
    let evs = run_worker_once(test_cfg()).await;
    let code = find_error_code(&evs).expect("trusted+bad-auth must emit error");
    check("trusted host passes verification to auth", code == "auth_failed");
    check("no prompt when trusted", find_prompt(&evs).is_none());
}

#[tokio::test]
async fn m5_changed_key_refused_and_never_overwritten() {
    let _guard = serial_lock();
    let _iso = IsolatedStore::new("changed");
    hostkeys::store_trusted("127.0.0.1", 22222, "ssh-ed25519 AAAAFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE")
        .expect("seed fake trust");
    let evs = run_worker_once(test_cfg()).await;
    // 5. changed key -> connection refused with typed error + changed prompt.
    let prompt = find_prompt(&evs).expect("changed key must emit prompt");
    check("changed flag set", prompt.changed);
    check("changed fingerprint exposed", prompt.fingerprint.starts_with("SHA256:"));
    let code = find_error_code(&evs).expect("changed key must emit typed error");
    check("typed host_key_changed", code == "host_key_changed");
    // Stored key must NOT be silently replaced.
    let stored = hostkeys::lookup_trusted("127.0.0.1", 22222).unwrap().unwrap();
    check(
        "stored key untouched",
        stored.contains("AAAAFAKEFAKEFAKEFAKEFAKEFAKE"),
    );
}

#[tokio::test]
async fn m5_reject_stores_nothing() {
    let _guard = serial_lock();
    let _iso = IsolatedStore::new("reject");
    // 6. reject = simply never call store_trusted (UI Reject path).
    let evs = run_worker_once(test_cfg()).await;
    check("prompt shown", find_prompt(&evs).is_some());
    // Explicitly do nothing (user pressed Reject) ...
    check("still untrusted", !hostkeys::was_ever_trusted("127.0.0.1", 22222));
    // ... and the next attempt refuses again.
    let evs2 = run_worker_once(test_cfg()).await;
    check("refuses again", find_prompt(&evs2).is_some());
}

#[tokio::test]
async fn m5_malformed_store_fails_closed() {
    let _guard = serial_lock();
    let _iso = IsolatedStore::new("malformed");
    // 8. malformed trust data -> fail safely (never verified, refused).
    let path = hostkeys::store_path();
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).unwrap();
    }
    std::fs::write(&path, b"{ this is not valid json").unwrap();
    check(
        "lookup errors on malformed",
        hostkeys::lookup_trusted("127.0.0.1", 22222).is_err(),
    );
    check(
        "is_trusted false on malformed",
        !hostkeys::is_trusted("127.0.0.1", 22222, "ssh-ed25519 AAAA"),
    );
    let evs = run_worker_once(test_cfg()).await;
    // Must refuse (unknown path), never connect.
    let live = evs
        .iter()
        .any(|e| matches!(e, core::SessionEvent::Status { status: core::SessionStatus::Live }));
    check("malformed store never connects", !live);
    check("prompt still emitted", find_prompt(&evs).is_some());
}

#[tokio::test]
async fn m5_existing_trusted_host_connects() {
    let _guard = serial_lock();
    let _iso = IsolatedStore::new("existing");
    // 7. existing trusted host -> full connection with real credentials.
    let home = std::env::var("HOME").expect("HOME set");
    let key_data = std::fs::read_to_string(format!("{home}/.ssh/still_poc_test"))
        .expect("test key readable");
    let user = std::env::var("USER").unwrap_or("Darsh".into());
    let (_, openssh, _) = ssh_worker::probe_host_key("127.0.0.1", 22222)
        .await
        .expect("probe");
    hostkeys::store_trusted("127.0.0.1", 22222, openssh.trim()).expect("pre-trust");
    let cfg = core::SshConfig {
        host: "127.0.0.1".into(),
        port: 22222,
        username: user,
        tmux_session: "still-m5-live".into(),
        working_directory: None,
        cols: 80,
        rows: 24,
    };
    let (etx, mut erx) = tokio::sync::mpsc::unbounded_channel();
    let (itx, irx) = tokio::sync::mpsc::unbounded_channel();
    let (_rtx, rrx) = tokio::sync::mpsc::unbounded_channel();
    let (_stx, srx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        ssh_worker::run_session(cfg, None, Some(key_data), etx, irx, rrx, srx).await;
    });
    // Wait for Live status (real auth + tmux through the verified path).
    let mut saw_live = false;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(15000);
    while tokio::time::Instant::now() < deadline {
        if let Ok(ev) = tokio::time::timeout(
            deadline.saturating_duration_since(tokio::time::Instant::now()),
            erx.recv(),
        )
        .await
        {
            if let Some(core::SessionEvent::Status { status: core::SessionStatus::Live }) = ev {
                saw_live = true;
                break;
            }
            if let Some(core::SessionEvent::Error { error }) = ev {
                panic!("trusted connection failed: [{}] {}", error.code, error.message);
            }
        } else {
            break;
        }
    }
    check("trusted host reaches Live", saw_live);
    itx.send(b"echo M5-TRUSTED-OK\n".to_vec()).unwrap();
    let mut buf = Vec::<u8>::new();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(8000);
    loop {
        let ev = tokio::time::timeout(
            deadline.saturating_duration_since(tokio::time::Instant::now()),
            erx.recv(),
        )
        .await
        .expect("timed out waiting for data")
        .expect("channel closed");
        if let core::SessionEvent::Data { data } = ev {
            buf.extend_from_slice(&data);
            if String::from_utf8_lossy(&buf).contains("M5-TRUSTED-OK") {
                break;
            }
        }
    }
    check("data flows on verified connection", true);
    handle.abort();
}
