#![cfg(unix)]
//! Runs the production tmux setup on a PRIVATE socket: never the user's server.
use std::path::PathBuf;
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};
use still_app::core::TmuxPlan;

struct Server(PathBuf);
impl Server {
    fn cmd(&self, args: &[&str]) -> Output {
        Command::new("tmux").arg("-S").arg(&self.0).args(args).output().unwrap()
    }
}
impl Drop for Server {
    fn drop(&mut self) { let _ = self.cmd(&["kill-server"]); }
}

#[test]
fn generated_setup_enables_mouse_and_clipboard_and_preserves_other_sessions() {
    if Command::new("tmux").arg("-V").output().is_err() {
        eprintln!("SKIP: tmux is not installed");
        return;
    }
    let id = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let server = Server(std::env::temp_dir().join(format!("still-test-{}-{id}.sock", std::process::id())));
    assert!(server.cmd(&["-f", "/dev/null", "new-session", "-d", "-s", "unrelated"]).status.success());
    assert!(server.cmd(&["set-option", "-t", "unrelated", "mouse", "off"]).status.success());

    // -d avoids needing a GUI/client PTY; the rest is the real production queue.
    let command = TmuxPlan::new("probe").attach_command(100, 30)
        .replacen("tmux -u", &format!("tmux -S '{}' -u", server.0.display()), 1)
        .replacen("new-session -A", "new-session -Ad", 1);
    let result = Command::new("sh").arg("-c").arg(&command).env_remove("TMUX").output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    for (option, expected) in [("mouse", "on"), ("history-limit", "10000"), ("status", "off")] {
        let out = server.cmd(&["show-options", "-v", "-t", "probe", option]);
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), expected);
    }
    assert_eq!(String::from_utf8_lossy(&server.cmd(&["show-options", "-sv", "set-clipboard"]).stdout).trim(), "on");
    assert_eq!(String::from_utf8_lossy(&server.cmd(&["show-options", "-v", "-t", "unrelated", "mouse"]).stdout).trim(), "off");
    // Quiet unknown options must not prevent subsequent baseline commands.
    assert!(server.cmd(&["set-option", "-sq", "still-unsupported-option", "on", ";", "has-session", "-t", "probe"]).status.success());
    // Reapplying the option queue leaves both sessions and the existing pane intact.
    let before = server.cmd(&["display-message", "-p", "-t", "probe", "#{pane_id}"]).stdout;
    let setup = format!("tmux -S '{}' {}", server.0.display(), command.split_once("\\;").unwrap().1);
    assert!(Command::new("sh").arg("-c").arg(&setup).env_remove("TMUX").status().unwrap().success());
    assert_eq!(before, server.cmd(&["display-message", "-p", "-t", "probe", "#{pane_id}"]).stdout);
}
