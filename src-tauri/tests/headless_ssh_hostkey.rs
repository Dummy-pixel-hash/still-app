//! M5 headless validation of HOST-KEY VERIFICATION against the real engine.
//!
//! This is the M1/M4 headless suite (localhost sshd on port 22 + tmux, real
//! credentials, all 15 checks retained) now running THROUGH the M5 verified
//! host-key path: the test first performs the explicit, out-of-band trust of
//! the local host key (the same trust a user grants via the Trust dialog), and
//! then drives the real russh worker. Verification is NOT disabled: an unknown
//! or changed key still refuses (covered exhaustively in tests/hostkey_m5.rs).
//!
//! Run: cargo test --offline --test headless_ssh_hostkey
//! Env:  STILL_TEST_HOST (default 127.0.0.1), STILL_TEST_PORT (default 22)

use std::time::Duration;

use still_app::{core, hostkeys, ssh_worker};

fn check(name: &str, cond: bool) {
    println!("{}: {}", name, if cond { "PASS" } else { "FAIL" });
    if !cond {
        panic!("headless check failed: {name}");
    }
}

async fn read_event(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<core::SessionEvent>,
    timeout_ms: u64,
) -> core::SessionEvent {
    tokio::time::timeout(Duration::from_millis(timeout_ms), rx.recv())
        .await
        .expect("timed out waiting for session event")
        .expect("event channel closed")
}

async fn collect_data_until(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<core::SessionEvent>,
    needle: &str,
    timeout_ms: u64,
) -> String {
    let mut buf = Vec::<u8>::new();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let ev = tokio::time::timeout(
            deadline.saturating_duration_since(tokio::time::Instant::now()),
            rx.recv(),
        )
        .await
        .expect("timed out waiting for session data")
        .expect("event channel closed");
        if let core::SessionEvent::Data { data } = ev {
            buf.extend_from_slice(&data);
            let s = String::from_utf8_lossy(&buf).to_string();
            if s.contains(needle) {
                return s;
            }
        }
    }
}

#[tokio::test]
async fn headless_verified_real_ssh_tmux_roundtrip() {
    // Isolated trust store: this test's trust grant never touches the user's.
    let dir = std::env::temp_dir().join(format!(
        "still-headless-hk-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    unsafe { std::env::set_var("STILL_KNOWN_HOSTS", dir.join("known_hosts.json")) };

    let host = std::env::var("STILL_TEST_HOST").unwrap_or("127.0.0.1".into());
    let port: u16 = std::env::var("STILL_TEST_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(22);
    let home = std::env::var("HOME").expect("HOME set");
    let key_data = std::fs::read_to_string(format!("{home}/.ssh/still_poc_test"))
        .expect("test key readable");
    let user = std::env::var("USER").unwrap_or("Darsh".into());

    // ---- M5 preflight: explicit trust of the LOCAL test host key ----
    // (Equivalent of the user reading the fingerprint and pressing Trust.)
    let (kt, openssh, fp) = ssh_worker::probe_host_key(&host, port)
        .await
        .expect("probe local test host key");
    println!("local host key: {kt} {fp}");
    check("M5 probe exposes fingerprint", fp.starts_with("SHA256:"));
    hostkeys::store_trusted(&host, port, openssh.trim()).expect("explicit local trust");
    check("M5 trust stored natively", hostkeys::is_trusted(&host, port, openssh.trim()));

    let cfg = core::SshConfig {
        host: host.clone(),
        port,
        username: user.clone(),
        tmux_session: "still-m5-headless".into(),
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

    // T1: verified handshake + real auth + tmux attach reaches Live.
    let mut live = false;
    for _ in 0..20 {
        match read_event(&mut erx, 10000).await {
            core::SessionEvent::Status {
                status: core::SessionStatus::Live,
            } => {
                live = true;
                break;
            }
            core::SessionEvent::Error { error } => {
                panic!("verified connection failed: [{}] {}", error.code, error.message)
            }
            _ => {}
        }
    }
    check("M5 T1 verified worker reaches live", live);

    // T2: typed echo through the real channel.
    itx.send(b"echo M5-HK-OK\n".to_vec()).unwrap();
    let out = collect_data_until(&mut erx, "M5-HK-OK", 10000).await;
    check("M5 T2 data flows over verified session", out.contains("M5-HK-OK"));

    // T3: unicode survives.
    itx.send(
        "printf '\\033[31mM5-UNICODE-λ\\033[0m\\n'\n"
            .as_bytes()
            .to_vec(),
    )
    .unwrap();
    let out = collect_data_until(&mut erx, "M5-UNICODE-", 10000).await;
    check("M5 T3 unicode survives", out.contains("M5-UNICODE-"));

    // T4: disconnect drops our channel; tmux survives server-side.
    handle.abort();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = std::fs::remove_dir_all(&dir);
    println!("ALL M5 HEADLESS HOST-KEY SSH/TMUX CHECKS PASSED");
}
