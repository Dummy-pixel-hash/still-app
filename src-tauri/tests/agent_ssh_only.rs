#![cfg(unix)]
//! Opt-in real SSH fixture: an agent transport never opens a PTY/tmux pane.
//! Run against the existing local fixture with `cargo test --test agent_ssh_only -- --ignored`.
use std::{process::Command, time::Duration};
use still_app::{core, hostkeys, ssh_worker};

#[tokio::test]
#[ignore = "requires the existing localhost sshd and ~/.ssh/still_poc_test fixture"]
async fn ssh_only_leaves_terminal_identity_and_directory_untouched() {
    let home = std::env::var("HOME").unwrap();
    let key = format!("{home}/.ssh/still_poc_test");
    let user = std::env::var("USER").unwrap_or_else(|_| "Darsh".into());
    let dir = std::path::PathBuf::from("/tmp/opencode")
        .join(format!("still-ssh-only-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    unsafe {
        std::env::set_var("STILL_KNOWN_HOSTS", dir.join("still-known-hosts.json"));
    }
    let (_, public, _) = ssh_worker::probe_host_key("127.0.0.1", 22).await.unwrap();
    hostkeys::store_trusted("127.0.0.1", 22, public.trim()).unwrap();
    // Separate OpenSSH verification file contains the same explicitly observed fixture key.
    let ssh_hosts = dir.join("ssh-known-hosts");
    std::fs::write(&ssh_hosts, format!("127.0.0.1 {}\n", public.trim())).unwrap();
    let tmux = format!("still-agent-test-{}", std::process::id());
    let inspect = || {
        Command::new("ssh")
            .args([
                "-i",
                &key,
                "-o",
                "BatchMode=yes",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                &format!("UserKnownHostsFile={}", ssh_hosts.display()),
                &format!("{user}@127.0.0.1"),
                &format!("tmux has-session -t '{tmux}' 2>/dev/null"),
            ])
            .status()
            .unwrap()
            .success()
    };
    assert!(!inspect(), "fixture identity must not already exist");
    let config = core::SshConfig {
        host: "127.0.0.1".into(),
        port: 22,
        username: user.clone(),
        tmux_session: tmux.clone(),
        working_directory: Some("/a/directory/that/does/not/exist".into()),
        ssh_only: true,
        cols: 80,
        rows: 24,
    };
    let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let (_input, input_rx) = tokio::sync::mpsc::unbounded_channel();
    let (_resize, resize_rx) = tokio::sync::mpsc::unbounded_channel();
    let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
    let worker = tokio::spawn(ssh_worker::run_session(
        "agent-ssh-fixture".into(),
        config,
        None,
        Some(std::fs::read_to_string(&key).unwrap()),
        events,
        input_rx,
        resize_rx,
        shutdown_rx,
    ));
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            match receiver.recv().await.unwrap() {
                core::SessionEvent::Status {
                    status: core::SessionStatus::Live,
                } => break,
                core::SessionEvent::Error { error } => panic!("SSH-only failed: {}", error.message),
                core::SessionEvent::Data { .. } => panic!("SSH-only must not emit terminal output"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert!(
        !inspect(),
        "opening Agents must not create its saved tmux terminal"
    );
    shutdown.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), worker)
        .await
        .unwrap()
        .unwrap();
    assert!(
        !inspect(),
        "closing the agent transport leaves terminal ownership untouched"
    );
    let _ = std::fs::remove_dir_all(dir);
}
