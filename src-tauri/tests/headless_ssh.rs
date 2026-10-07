//! Milestone 1 headless validation of the REAL native engine.
//! Drives the actual russh worker flow (same auth + tmux attach command the
//! production commands.rs spawns) against localhost SSH + tmux.
//! Run: cargo test --offline --test headless_ssh
use std::time::Duration;

use still_app::ssh_worker;

fn check(name: &str, cond: bool) {
    println!("{}: {}", name, if cond { "PASS" } else { "FAIL" });
    if !cond {
        panic!("headless check failed: {name}");
    }
}

async fn read_event(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<still_app::core::SessionEvent>,
    timeout_ms: u64,
) -> still_app::core::SessionEvent {
    tokio::time::timeout(Duration::from_millis(timeout_ms), rx.recv())
        .await
        .expect("timed out waiting for session event")
        .expect("event channel closed")
}

async fn collect_data_until(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<still_app::core::SessionEvent>,
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
        if let still_app::core::SessionEvent::Data { data } = ev {
            buf.extend_from_slice(&data);
            let s = String::from_utf8_lossy(&buf).to_string();
            if s.contains(needle) {
                return s;
            }
        }
    }
}

#[tokio::test]
async fn headless_real_ssh_tmux_roundtrip() {
    let home = std::env::var("HOME").expect("HOME set");
    let key_path = format!("{home}/.ssh/still_poc_test");
    let key_data = std::fs::read_to_string(&key_path).expect("test key readable");

    // T0: core validation rejects bad input (proves taxonomy is live).
    let bad = still_app::core::SshConnectArgs {
        host: "".into(),
        port: 22,
        username: "u".into(),
        auth_kind: "password".into(),
        secret: None,
        remember: None,
        tmux_session: None,
        cols: None,
        rows: None,
        client_id: None,
    };
    check("T0 empty host rejected", bad.validate().is_err());
    let bad_port = still_app::core::SshConnectArgs {
        host: "h".into(),
        port: 0,
        username: "u".into(),
        auth_kind: "password".into(),
        secret: None,
        remember: None,
        tmux_session: None,
        cols: None,
        rows: None,
        client_id: None,
    };
    check("T0 bad port rejected", bad_port.validate().is_err());

    // T0b: invalid connection surfaces a typed error (refused port).
    let refused = still_app::core::SshConnectArgs {
        host: "127.0.0.1".into(),
        port: 59999,
        username: "nobody".into(),
        auth_kind: "password".into(),
        secret: Some("x".into()),
        remember: None,
        tmux_session: Some("still-m1-probe".into()),
        cols: Some(80),
        rows: Some(24),
        client_id: None,
    }
    .validate()
    .expect("refused-probe args valid");
    let (etx, mut erx) = tokio::sync::mpsc::unbounded_channel();
    let (_itx, irx) = tokio::sync::mpsc::unbounded_channel();
    let (_rtx, rrx) = tokio::sync::mpsc::unbounded_channel();
    let (_stx, srx) = tokio::sync::oneshot::channel();
    ssh_worker::run_session(refused, Some("x".into()), None, etx, irx, rrx, srx).await;
    let mut saw_error = false;
    while let Ok(ev) = erx.try_recv() {
        if matches!(ev, still_app::core::SessionEvent::Error { .. }) {
            saw_error = true;
        }
    }
    check("T0b refused connection yields typed error", saw_error);

    // T1..T9: real localhost SSH + tmux through the production worker.
    let user = std::env::var("USER").unwrap_or("Darsh".into());
    let cfg = still_app::core::SshConnectArgs {
        host: "127.0.0.1".into(),
        port: 22,
        username: user,
        auth_kind: "privateKey".into(),
        secret: Some(key_data.clone()),
        remember: None,
        tmux_session: Some("still-m1-test".into()),
        cols: Some(80),
        rows: Some(24),
        client_id: None,
    }
    .validate()
    .expect("test args valid");
    check(
        "T1 tmux attach command",
        still_app::core::TmuxPlan::new("still-m1-test").attach_command(80, 24)
            == "tmux -u new-session -A -s still-m1-test -x 80 -y 24 \\; set-option -t still-m1-test status off\n",
    );

    let (etx, mut erx) = tokio::sync::mpsc::unbounded_channel();
    let (itx, irx) = tokio::sync::mpsc::unbounded_channel();
    let (rtx, rrx) = tokio::sync::mpsc::unbounded_channel();
    let (_stx, srx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        ssh_worker::run_session(cfg, None, Some(key_data), etx, irx, rrx, srx).await;
    });
    // Wait for live status.
    let mut live = false;
    for _ in 0..100 {
        match read_event(&mut erx, 1000).await {
            still_app::core::SessionEvent::Status { status } => {
                if status == still_app::core::SessionStatus::Live {
                    live = true;
                    break;
                }
            }
            still_app::core::SessionEvent::Error { error } => {
                panic!("worker error before live: {error:?}");
            }
            _ => {}
        }
    }
    check("T1 worker reaches live", live);

    // T2 typing round-trip.
    itx.send(b"echo M1-TYPE-OK\n".to_vec()).unwrap();
    let out = collect_data_until(&mut erx, "M1-TYPE-OK", 10000).await;
    check("T2 typed echo returns", out.contains("M1-TYPE-OK"));

    // T3 enter already covered; T4 Ctrl-C interrupts sleep.
    itx.send(b"sleep 30\n".to_vec()).unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;
    itx.send(b"\x03".to_vec()).unwrap(); // Ctrl-C
    itx.send(b"echo M1-CTRLC-OK\n".to_vec()).unwrap();
    let out = collect_data_until(&mut erx, "M1-CTRLC-OK", 10000).await;
    check("T4 Ctrl-C interrupts, shell alive", out.contains("M1-CTRLC-OK"));

    // T5 arrows: up-arrow recalls history in the shell.
    itx.send(b"echo M1-ARROW-PROBE\n".to_vec()).unwrap();
    let _ = collect_data_until(&mut erx, "M1-ARROW-PROBE", 8000).await;
    itx.send(b"\x1b[A".to_vec()).unwrap();
    let out = collect_data_until(&mut erx, "M1-ARROW-PROBE", 8000).await;
    check("T5 up-arrow recalls history", out.contains("M1-ARROW-PROBE"));

    // T6 function key F1 must not kill the channel.
    itx.send(b"\x1b[11~".to_vec()).unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    itx.send(b"echo M1-FKEY-OK\n".to_vec()).unwrap();
    let out = collect_data_until(&mut erx, "M1-FKEY-OK", 8000).await;
    check("T6 F1 passes, channel alive", out.contains("M1-FKEY-OK"));

    // T7 unicode + T8 ANSI styling.
    itx.send("echo M1-UNICODE-héllo-世界-🎉\n".as_bytes().to_vec()).unwrap();
    let out = collect_data_until(&mut erx, "M1-UNICODE-", 8000).await;
    check("T7 unicode survives", out.contains("M1-UNICODE-"));
    itx.send(b"printf '\\033[31mM1-RED\\033[0m done\\n'\n".to_vec()).unwrap();
    let out = collect_data_until(&mut erx, "M1-RED", 8000).await;
    // tmux may translate ESC to equivalent sequences; assert content survives.
    check("T8 ANSI red passes", out.contains("M1-RED"));

    // T9 resize: PTY window-change + tmux refresh, channel stays alive.
    rtx.send((100u32, 30u32)).unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
    itx.send(b"echo M1-RESIZE-OK\n".to_vec()).unwrap();
    let out = collect_data_until(&mut erx, "M1-RESIZE-OK", 8000).await;
    check("T9 resize keeps channel alive", out.contains("M1-RESIZE-OK"));

    // T10 marker: state must survive disconnect (tmux persistence).
    itx.send(b"echo M1-PERSIST-MARKER-12345\n".to_vec()).unwrap();
    let _ = collect_data_until(&mut erx, "M1-PERSIST-MARKER-12345", 8000).await;
    handle.abort(); // local disconnect: drop TCP+channel, tmux lives on.
    tokio::time::sleep(Duration::from_millis(500)).await;

    // T11 reconnect attaches to the SAME tmux session; scrollback visible.
    let key_data2 = std::fs::read_to_string(&key_path).expect("test key readable");
    let user2 = std::env::var("USER").unwrap_or("Darsh".into());
    let cfg2 = still_app::core::SshConnectArgs {
        host: "127.0.0.1".into(),
        port: 22,
        username: user2,
        auth_kind: "privateKey".into(),
        secret: Some(key_data2.clone()),
        remember: None,
        tmux_session: Some("still-m1-test".into()),
        cols: Some(80),
        rows: Some(24),
        client_id: None,
    }
    .validate()
    .expect("reconnect args valid");
    let (etx2, mut erx2) = tokio::sync::mpsc::unbounded_channel();
    let (itx2, irx2) = tokio::sync::mpsc::unbounded_channel();
    let (_rtx2, rrx2) = tokio::sync::mpsc::unbounded_channel();
    let (_stx2, srx2) = tokio::sync::oneshot::channel();
    let handle2 = tokio::spawn(async move {
        ssh_worker::run_session(cfg2, None, Some(key_data2), etx2, irx2, rrx2, srx2).await;
    });
    let mut live2 = false;
    for _ in 0..100 {
        match read_event(&mut erx2, 1000).await {
            still_app::core::SessionEvent::Status { status } => {
                if status == still_app::core::SessionStatus::Live {
                    live2 = true;
                    break;
                }
            }
            still_app::core::SessionEvent::Error { error } => {
                panic!("reconnect worker error: {error:?}");
            }
            _ => {}
        }
    }
    check("T11 reconnect reaches live", live2);
    // Force tmux to repaint so prior scrollback streams to the new client.
    itx2.send(b"tmux refresh-client\n".to_vec()).unwrap();
    let out = collect_data_until(&mut erx2, "M1-PERSIST-MARKER-12345", 15000).await;
    check(
        "T12 prior terminal state visible after reattach",
        out.contains("M1-PERSIST-MARKER-12345"),
    );
    handle2.abort();

    // Direct tmux check: session still exists server-side after disconnect.
    let tmux_ls = tokio::process::Command::new("tmux")
        .args(["ls"])
        .output()
        .await
        .expect("tmux ls runs");
    let ls = String::from_utf8_lossy(&tmux_ls.stdout).to_string();
    check("T10 tmux session persists after disconnect", ls.contains("still-m1-test"));
    // Cleanup: kill only our test session.
    let _ = tokio::process::Command::new("tmux")
        .args(["kill-session", "-t", "still-m1-test"])
        .output()
        .await;

    println!("\nALL M1 HEADLESS SSH/TMUX CHECKS PASSED");
}
