//! Connect-phase timeout regression tests (Windows ARM64 hang fix).
//!
//! - A stalled/silent peer must surface a TYPED failure within the explicit
//!   phase bounds instead of hanging the worker forever (previously: no
//!   timeout on TCP/KEX/probe/auth/channel — permanent "connecting").
//! - A timed-out (or still-pending) connection must NOT hold
//!   HANDSHAKE_SERIAL: a second attempt proceeds while the first is stalled.
//! - A normal localhost connection still succeeds (no behavior change).
//! - A timed-out attempt writes no host-key trust.
//!
//! Fixture needs mirror `headless_ssh.rs`: localhost sshd on :22,
//! `~/.ssh/still_poc_test`, and the `USER` env var. `STILL_KNOWN_HOSTS` is
//! isolated per test; tests are serialized because the env var is global.
//!
//! Run: cargo test --locked --test connect_timeouts
//! (Excluded from the Windows CI gate like the other live suites.)

use std::time::Duration;

use still_app::{core, hostkeys, ssh_worker};

static SERIAL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn serial_lock() -> SerialGuard {
    while SERIAL
        .compare_exchange_weak(
            false,
            true,
            std::sync::atomic::Ordering::Acquire,
            std::sync::atomic::Ordering::Relaxed,
        )
        .is_err()
    {
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

struct IsolatedStore {
    dir: std::path::PathBuf,
}

impl IsolatedStore {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "still-conn-timeout-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        unsafe { std::env::set_var("STILL_KNOWN_HOSTS", dir.join("known_hosts.json")) };
        Self { dir }
    }
}

impl Drop for IsolatedStore {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn check(name: &str, cond: bool) {
    println!("{}: {}", name, if cond { "PASS" } else { "FAIL" });
    if !cond {
        panic!("connect_timeouts check failed: {name}");
    }
}

/// A peer that accepts TCP and then NEVER speaks SSH (banner stall).
/// Returns the bound port. Sockets are held open for the test duration.
async fn silent_listener() -> u16 {
    let ln = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind silent listener");
    let port = ln.local_addr().expect("listener addr").port();
    tokio::spawn(async move {
        loop {
            match ln.accept().await {
                Ok((sock, _)) => {
                    tokio::spawn(async move {
                        // Hold the socket open without a single byte: the
                        // client KEX must stall here until its deadline.
                        let _held = sock;
                        tokio::time::sleep(Duration::from_secs(120)).await;
                    });
                }
                Err(_) => return,
            }
        }
    });
    port
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

fn error_code(evs: &[core::SessionEvent]) -> Option<String> {
    for ev in evs {
        if let core::SessionEvent::Error { error } = ev {
            return Some(error.code.clone());
        }
    }
    None
}

fn has_prompt(evs: &[core::SessionEvent]) -> bool {
    evs.iter().any(|e| {
        matches!(
            e,
            core::SessionEvent::HostKeyPrompt { .. }
        )
    })
}

fn reached_live(evs: &[core::SessionEvent]) -> bool {
    evs.iter().any(|e| {
        matches!(
            e,
            core::SessionEvent::Status {
                status: core::SessionStatus::Live
            }
        )
    })
}

async fn wait_for_live(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<core::SessionEvent>,
    budget: Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + budget;
    while tokio::time::Instant::now() < deadline {
        let rest = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(rest, rx.recv()).await {
            Ok(Some(core::SessionEvent::Status {
                status: core::SessionStatus::Live,
            })) => return true,
            Ok(Some(core::SessionEvent::Error { error })) => {
                panic!("unexpected worker error while waiting for Live: {error:?}")
            }
            Ok(_) => {}
            Err(_) => return false,
        }
    }
    false
}

#[tokio::test]
async fn stalled_peer_returns_typed_failure_and_writes_no_trust() {
    let _guard = serial_lock();
    let _iso = IsolatedStore::new("silent");
    let port = silent_listener().await;

    let cfg = core::SshConfig {
        host: "127.0.0.1".into(),
        port,
        username: "nobody".into(),
        tmux_session: "still-timeout-probe".into(),
        working_directory: None,
        cols: 80,
        rows: 24,
    };
    let (etx, mut erx) = tokio::sync::mpsc::unbounded_channel();
    let (_itx, irx) = tokio::sync::mpsc::unbounded_channel();
    let (_rtx, rrx) = tokio::sync::mpsc::unbounded_channel();
    let (_stx, srx) = tokio::sync::oneshot::channel();

    // Outer tripwire: the whole establishment MUST terminate. Under the old
    // unbounded design this awaited forever (KEX stall with no deadline).
    tokio::time::timeout(Duration::from_secs(60), ssh_worker::run_session(
        cfg, None, None, etx, irx, rrx, srx,
    ))
    .await
    .expect("stalled peer must terminate (regression: unbounded handshake)");

    let evs = drain(&mut erx);
    check("silent peer yields an error event", error_code(&evs).is_some());
    check(
        "silent peer classified unreachable (existing taxonomy, no new kinds)",
        error_code(&evs).as_deref() == Some("unreachable"),
    );
    check("no host-key prompt from a stall (nothing was verified)", !has_prompt(&evs));
    check("never reaches Live", !reached_live(&evs));
    check(
        "timeout writes no trust",
        !hostkeys::was_ever_trusted("127.0.0.1", port),
    );
}

#[tokio::test]
async fn stalled_attempt_does_not_block_later_attempts() {
    let _guard = serial_lock();
    let _iso = IsolatedStore::new("serial");
    let home = std::env::var("HOME").expect("HOME set");
    let key_data = std::fs::read_to_string(format!("{home}/.ssh/still_poc_test"))
        .expect("test key readable");
    let user = std::env::var("USER").unwrap_or("Darsh".into());

    // Pre-trust the real localhost sshd (explicit local trust, as usual).
    let (_, openssh, _) = ssh_worker::probe_host_key("127.0.0.1", 22)
        .await
        .expect("probe localhost sshd");
    hostkeys::store_trusted("127.0.0.1", 22, openssh.trim()).expect("pre-trust");

    // First worker: stalls in KEX against the silent peer (holds NO mutex
    // while stalled under the fixed pacing scope).
    let stall_port = silent_listener().await;
    let stall_cfg = core::SshConfig {
        host: "127.0.0.1".into(),
        port: stall_port,
        username: "nobody".into(),
        tmux_session: "still-timeout-stalled".into(),
        working_directory: None,
        cols: 80,
        rows: 24,
    };
    let (stall_etx, _stall_erx) = tokio::sync::mpsc::unbounded_channel();
    let (_stall_itx, stall_irx) = tokio::sync::mpsc::unbounded_channel();
    let (_stall_rtx, stall_rrx) = tokio::sync::mpsc::unbounded_channel();
    let (_stall_stx, stall_srx) = tokio::sync::oneshot::channel();
    let stalled = tokio::spawn(async move {
        ssh_worker::run_session(
            stall_cfg, None, None, stall_etx, stall_irx, stall_rrx, stall_srx,
        )
        .await;
    });
    // Let the stalled worker get into its KEX wait (pacing is 300ms; the
    // stall itself is ~20s, so this sleep only aligns the overlap — the
    // assertion below is deadline-based, not sleep-based).
    tokio::time::sleep(Duration::from_millis(1500)).await;

    // Second worker: real localhost session. Under the old design it queued
    // behind the stalled handshake on HANDSHAKE_SERIAL and could not reach
    // Live within any short budget; now only start-spacing applies.
    let good_cfg = core::SshConfig {
        host: "127.0.0.1".into(),
        port: 22,
        username: user,
        tmux_session: "still-timeout-live".into(),
        working_directory: None,
        cols: 80,
        rows: 24,
    };
    let (etx, mut erx) = tokio::sync::mpsc::unbounded_channel();
    let (itx, irx) = tokio::sync::mpsc::unbounded_channel();
    let (_rtx, rrx) = tokio::sync::mpsc::unbounded_channel();
    let (_stx, srx) = tokio::sync::oneshot::channel();
    let good = tokio::spawn(async move {
        ssh_worker::run_session(
            good_cfg, None, Some(key_data), etx, irx, rrx, srx,
        )
        .await;
    });
    let live = wait_for_live(&mut erx, Duration::from_secs(15)).await;
    check("second attempt reaches Live while first is stalled", live);

    // Data still flows on the healthy session (no behavior change).
    itx.send(b"echo TIMEOUT-SERIAL-OK\n".to_vec()).unwrap();
    let mut buf = Vec::<u8>::new();
    let out = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            match erx.recv().await {
                Some(core::SessionEvent::Data { data }) => {
                    buf.extend_from_slice(&data);
                    if String::from_utf8_lossy(&buf).contains("TIMEOUT-SERIAL-OK") {
                        return true;
                    }
                }
                Some(core::SessionEvent::Error { error }) => {
                    panic!("healthy session errored: {error:?}")
                }
                _ => {}
            }
        }
    })
    .await
    .expect("healthy session data must arrive");
    check("data flows on unblocked session", out);

    good.abort();
    stalled.abort();
    let _ = tokio::join!(good, stalled);
}
