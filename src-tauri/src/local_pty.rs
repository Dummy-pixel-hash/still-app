//! Cross-platform PTY primitives used by the detached local-session host.
//! This module owns only the PTY; process lifetime and reattach belong to the
//! host process, not to a Tauri window or renderer.

use anyhow::{Context, Result, bail};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MIN_COLS: u16 = 20;
const MAX_COLS: u16 = 500;
const MIN_ROWS: u16 = 5;
const MAX_ROWS: u16 = 200;

pub struct LocalPty {
    master: Box<dyn MasterPty + Send>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl LocalPty {
    pub fn spawn(cwd: &Path, cols: u16, rows: u16, shell: Option<&str>) -> Result<Self> {
        let cwd = fs::canonicalize(cwd).with_context(|| {
            format!(
                "Could not resolve local working directory {}",
                cwd.display()
            )
        })?;
        if !cwd.is_dir() {
            bail!("Local working directory is not a directory.");
        }
        #[cfg(windows)]
        let cwd = {
            use std::path::{Component, Prefix};
            let mut components = cwd.components();
            if let Some(Component::Prefix(prefix)) = components.next()
                && let Prefix::VerbatimDisk(drive) = prefix.kind()
            {
                // canonicalize() returns \\?\C:\..., which cmd.exe treats as
                // unsupported UNC and silently replaces with C:\Windows.
                let mut directory = PathBuf::from(format!("{}:", char::from(drive)));
                directory.push(components.as_path());
                if fs::canonicalize(&directory)? != cwd {
                    bail!(
                        "Local working directory requires unsupported Windows verbatim-path semantics."
                    );
                }
                directory
            } else {
                cwd
            }
        };

        let shell = shell
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .or_else(default_shell);
        let Some(shell) = shell else {
            bail!("No supported local shell was found.");
        };
        let mut command = CommandBuilder::new(&shell);
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");

        let system = native_pty_system();
        let pair = system
            .openpty(PtySize {
                rows: rows.clamp(MIN_ROWS, MAX_ROWS),
                cols: cols.clamp(MIN_COLS, MAX_COLS),
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("Could not allocate a local pseudo-terminal")?;
        let child = pair
            .slave
            .spawn_command(command)
            .with_context(|| format!("Could not start local shell {shell}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .context("Could not read local terminal output")?;
        let writer = pair
            .master
            .take_writer()
            .context("Could not write to local terminal")?;
        Ok(Self {
            master: pair.master,
            reader,
            writer,
            child,
        })
    }

    pub fn reader(&mut self) -> &mut (dyn Read + Send) {
        &mut *self.reader
    }
    pub fn writer(&mut self) -> &mut (dyn Write + Send) {
        &mut *self.writer
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .resize(PtySize {
                rows: rows.clamp(MIN_ROWS, MAX_ROWS),
                cols: cols.clamp(MIN_COLS, MAX_COLS),
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("Could not resize local terminal")
    }

    pub fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
        self.child.try_wait()
    }

    pub fn terminate(&mut self) -> std::io::Result<()> {
        self.child.kill()
    }
}

fn default_shell() -> Option<String> {
    #[cfg(windows)]
    {
        for candidate in ["pwsh.exe", "powershell.exe", "cmd.exe"] {
            if std::env::var_os("PATH").is_some_and(|path| {
                std::env::split_paths(&path).any(|dir| dir.join(candidate).is_file())
            }) {
                return Some(candidate.to_owned());
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL")
            .ok()
            .filter(|shell| PathBuf::from(shell).is_file())
            .or_else(|| {
                ["/bin/bash", "/bin/zsh", "/bin/sh"]
                    .into_iter()
                    .find(|path| Path::new(path).is_file())
                    .map(str::to_owned)
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env,
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };

    fn cursor_requests(output: &[u8], previous_len: usize) -> usize {
        output[previous_len.saturating_sub(3)..]
            .windows(4)
            .filter(|bytes| *bytes == b"\x1b[6n")
            .count()
    }

    fn has_cwd_marker(output: &[u8], expected: &Path) -> bool {
        // ConPTY interleaves terminal controls with text. Ignore CSI/OSC sequences
        // rather than comparing their raw bytes with a filesystem path.
        let text = String::from_utf8_lossy(output);
        let mut chars = text.chars().peekable();
        let mut plain = String::new();
        while let Some(ch) = chars.next() {
            if ch != '\x1b' {
                plain.push(ch);
                continue;
            }
            match chars.next() {
                Some('[') => {
                    for ch in chars.by_ref() {
                        if ('@'..='~').contains(&ch) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(ch) = chars.next() {
                        if ch == '\x07' || ch == '\x1b' && chars.next_if_eq(&'\\').is_some() {
                            break;
                        }
                    }
                }
                _ => {}
            }
        }
        plain.split("STILL_LOCAL_PTY_OK:").skip(1).any(|part| {
            let Some((reported, _)) = part.split_once(":STILL_LOCAL_PTY_END") else {
                return false;
            };
            // canonicalize() uses a verbatim \\?\ prefix on Windows, whereas
            // cmd.exe's %CD% need not. Compare directory identities, not spellings.
            Path::new(reported).is_absolute()
                && fs::canonicalize(reported).is_ok_and(|path| path == expected)
        })
    }

    #[test]
    fn cursor_requests_handle_split_and_repeated_queries_without_replaying_old_ones() {
        assert_eq!(cursor_requests(b"\x1b[6", 0), 0);
        assert_eq!(cursor_requests(b"\x1b[6n", 3), 1);
        assert_eq!(cursor_requests(b"\x1b[6ntext", 4), 0);
        assert_eq!(cursor_requests(b"\x1b[6ntext\x1b[6n", 8), 1);
    }

    #[test]
    fn cwd_marker_requires_real_output_and_accepts_terminal_controls_and_canonical_paths() {
        let cwd = env::current_dir().unwrap();
        let expected = fs::canonicalize(&cwd).unwrap();
        assert!(!has_cwd_marker(
            b"echo STILL_LOCAL_PTY_OK:%CD%:STILL_LOCAL_PTY_END\r\n",
            &expected
        ));
        let output = format!(
            "\x1b[6n\x1b]0;terminal\x07\x1b[?25lSTILL_LOCAL_PTY_OK:{}:STILL_LOCAL_PTY_END\r\n",
            cwd.display()
        );
        assert!(has_cwd_marker(output.as_bytes(), &expected));
    }

    #[test]
    fn pty_runs_a_local_command_in_the_requested_directory_and_resizes() {
        let cwd = env::current_dir().unwrap();
        #[cfg(windows)]
        let shell = "cmd.exe";
        #[cfg(not(windows))]
        let shell = "/bin/sh";

        let mut pty = LocalPty::spawn(&cwd, 80, 24, Some(shell)).unwrap();
        let expected_cwd = fs::canonicalize(&cwd).unwrap();
        #[cfg(windows)]
        let command = b"@echo STILL_LOCAL_PTY_OK:%CD%:STILL_LOCAL_PTY_END\r\n".as_slice();
        #[cfg(not(windows))]
        let command =
            b"printf 'STILL_LOCAL_PTY_OK:%s:STILL_LOCAL_PTY_END\\n' \"$PWD\"\n".as_slice();

        // Start draining before writing/resizing, and keep draining during close:
        // ConPTY shutdown can block if its output pipe is not being consumed.
        let mut reader = pty.master.try_clone_reader().unwrap();
        let (output_tx, output_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let reader_thread = thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        if output_tx.send(Ok(buffer[..count].to_vec())).is_err() {
                            break;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        let _ = output_tx.send(Err(error.to_string()));
                        break;
                    }
                }
            }
            let _ = done_tx.send(());
        });

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = Vec::new();
        let mut command_sent = false;
        let observed = loop {
            // portable-pty enables PSEUDOCONSOLE_INHERIT_CURSOR on Windows.
            // Answer its startup cursor query before sending keyboard input.
            if !command_sent && !cfg!(windows) {
                if let Err(error) = pty
                    .writer()
                    .write_all(command)
                    .and_then(|_| pty.writer().flush())
                {
                    break Err(error.to_string());
                }
                command_sent = true;
            }
            let chunk =
                match output_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(Ok(chunk)) => chunk,
                    Ok(Err(error)) => break Err(error),
                    Err(error) => break Err(error.to_string()),
                };
            let previous_len = output.len();
            output.extend_from_slice(&chunk);
            let requests = cursor_requests(&output, previous_len);
            let mut write_error = None;
            for _ in 0..requests {
                if let Err(error) = pty
                    .writer()
                    .write_all(b"\x1b[1;1R")
                    .and_then(|_| pty.writer().flush())
                {
                    write_error = Some(error.to_string());
                    break;
                }
            }
            if let Some(error) = write_error {
                break Err(error);
            }
            if !command_sent && requests > 0 {
                if let Err(error) = pty
                    .writer()
                    .write_all(command)
                    .and_then(|_| pty.writer().flush())
                {
                    break Err(error.to_string());
                }
                command_sent = true;
            }
            if has_cwd_marker(&output, &expected_cwd) {
                break pty.resize(120, 40).map_err(|error| error.to_string());
            }
            if output.len() > 64 * 1024 {
                break Err("PTY output exceeded the smoke-test limit".to_owned());
            }
        };

        let _ = pty.terminate();
        let reap_deadline = Instant::now() + Duration::from_secs(2);
        let reaped = loop {
            match pty.try_wait() {
                Ok(Some(_)) => break true,
                Ok(None) if Instant::now() < reap_deadline => {
                    thread::sleep(Duration::from_millis(10))
                }
                _ => break false,
            }
        };
        drop(pty);
        let reader_done = done_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        if reader_done {
            reader_thread.join().expect("PTY reader thread panicked");
        }
        for chunk in output_rx.try_iter().flatten() {
            output.extend_from_slice(&chunk);
        }
        assert!(
            observed.is_ok(),
            "local PTY failed: {observed:?}; captured output: {:?}",
            String::from_utf8_lossy(&output)
        );
        assert!(reaped, "local PTY child did not exit after termination");
        assert!(
            reader_done,
            "local PTY reader did not stop after closing the terminal"
        );
    }
}
