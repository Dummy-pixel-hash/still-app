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
        time::{Duration, Instant},
    };

    #[test]
    fn pty_runs_a_local_command_in_the_requested_directory_and_resizes() {
        let cwd = env::current_dir().unwrap();
        #[cfg(windows)]
        let shell = "cmd.exe";
        #[cfg(not(windows))]
        let shell = "/bin/sh";

        let mut pty = LocalPty::spawn(&cwd, 80, 24, Some(shell)).unwrap();
        #[cfg(windows)]
        pty.writer()
            .write_all(b"echo STILL_LOCAL_PTY_OK\r\nexit\r\n")
            .unwrap();
        #[cfg(not(windows))]
        {
            // The shell path is configurable, but command arguments are not
            // user-controlled in this focused PTY smoke test.
            pty.writer()
                .write_all(b"printf 'STILL_LOCAL_PTY_OK:%s\\n' \"$PWD\"\nexit\n")
                .unwrap();
        }
        pty.resize(120, 40).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = Vec::new();
        let mut buffer = [0u8; 4096];
        while Instant::now() < deadline {
            match pty.reader().read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => output.extend_from_slice(&buffer[..count]),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let output = String::from_utf8_lossy(&output);
        assert!(
            output.contains("STILL_LOCAL_PTY_OK"),
            "unexpected PTY output: {output}"
        );
        let _ = pty.terminate();
    }
}
