//! M5 — SSH host-key trust store (Rust-owned, native layer).
//!
//! - Trust data lives in a JSON file under the OS config dir
//!   (`$XDG_CONFIG_HOME/still/known_hosts.json`, fallback `~/.config/still/`).
//!   On Windows, `%APPDATA%\Still\known_hosts.json` (Roaming) is preferred:
//!   GUI-launched processes there frequently lack HOME/XDG_CONFIG_HOME and
//!   there is no `/tmp`, so the Unix fallback chain would scatter or fail.
//! - The file maps `host-lower:port` -> trusted OpenSSH public-key string
//!   (`"ssh-ed25519 AAAA..."`).
//! - Secrets (passwords / private keys) are NEVER stored here; only the
//!   server's *public* host key. The renderer never writes this file.
//! - Malformed files fail closed: verification treats them as untrusted
//!   (unknown-host path), never as verified.

use std::collections::HashMap;
use std::path::PathBuf;

/// Map key: `"<lowercased-host>:<port>"`.
pub fn endpoint_key(host: &str, port: u16) -> String {
    format!("{}:{port}", host.trim().to_lowercase())
}

/// Resolve the trust-store path. `STILL_KNOWN_HOSTS` overrides (tests).
pub fn store_path() -> PathBuf {
    if let Ok(p) = std::env::var("STILL_KNOWN_HOSTS")
        && !p.trim().is_empty()
    {
        return PathBuf::from(p);
    }
    // Windows: APPDATA (Roaming) is the canonical per-user config location.
    // Checked before the Unix chain because it is effectively never set on
    // non-Windows hosts, and HOME is frequently unset in GUI-launched
    // Windows processes (where `/tmp` also does not exist).
    if let Ok(appdata) = std::env::var("APPDATA")
        && !appdata.trim().is_empty()
    {
        return PathBuf::from(appdata)
            .join("Still")
            .join("known_hosts.json");
    }
    let base = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .map(|h| PathBuf::from(h).join(".config"))
        })
        .or_else(|| {
            // Windows fallback when HOME is unset (USERPROFILE always exists).
            std::env::var("USERPROFILE")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .map(|h| PathBuf::from(h).join(".config"))
        })
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    base.join("still").join("known_hosts.json")
}

/// Parse store bytes. `Err` on any malformed content (fail closed).
fn parse_store(bytes: &[u8]) -> anyhow::Result<HashMap<String, String>> {
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(HashMap::new());
    }
    let v: serde_json::Value = serde_json::from_slice(bytes)?;
    let obj = v
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("known_hosts root must be an object"))?;
    let mut out = HashMap::new();
    for (k, val) in obj {
        let s = val
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("known_hosts value for {k} must be a string"))?;
        let s = s.trim();
        if !s.starts_with("ssh-") && !s.starts_with("ecdsa-") && !s.starts_with("sk-") {
            return Err(anyhow::anyhow!("known_hosts value for {k} is not an OpenSSH key"));
        }
        out.insert(k.clone(), s.to_string());
    }
    Ok(out)
}

fn read_store() -> anyhow::Result<HashMap<String, String>> {
    let path = store_path();
    match std::fs::read(&path) {
        Ok(bytes) => parse_store(&bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(e) => Err(anyhow::anyhow!("read known_hosts: {e}")),
    }
}

/// Look up the trusted OpenSSH key string for an endpoint.
/// - `Ok(None)` — never trusted / no store yet (unknown host).
/// - `Err` — malformed store / IO failure (fail closed: caller must refuse).
pub fn lookup_trusted(host: &str, port: u16) -> anyhow::Result<Option<String>> {
    Ok(read_store()?.remove(&endpoint_key(host, port)))
}

/// Atomically store trust for an endpoint. Creates parent dirs as needed.
/// Refuses empty keys.
pub fn store_trusted(host: &str, port: u16, openssh_key: &str) -> anyhow::Result<()> {
    let openssh_key = openssh_key.trim();
    if openssh_key.is_empty() {
        return Err(anyhow::anyhow!("refusing to store empty host key"));
    }
    if !openssh_key.starts_with("ssh-")
        && !openssh_key.starts_with("ecdsa-")
        && !openssh_key.starts_with("sk-")
    {
        return Err(anyhow::anyhow!("refusing to store non-OpenSSH host key"));
    }
    let path = store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut map = read_store().unwrap_or_default();
    map.insert(endpoint_key(host, port), openssh_key.to_string());
    // Atomic write: tmp + rename so a crash never leaves half JSON.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&map)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Is `presented_openssh` the trusted key for this endpoint?
/// Malformed store / mismatch => `Ok(false)` (never verified).
pub fn is_trusted(host: &str, port: u16, presented_openssh: &str) -> bool {
    match lookup_trusted(host, port) {
        Ok(Some(stored)) => stored.trim() == presented_openssh.trim(),
        _ => false,
    }
}

/// Was this endpoint ever explicitly trusted (store has a *valid* entry)?
pub fn was_ever_trusted(host: &str, port: u16) -> bool {
    matches!(lookup_trusted(host, port), Ok(Some(_)))
}

/// Remove trust for an endpoint (best-effort).
pub fn forget_trusted(host: &str, port: u16) -> anyhow::Result<()> {
    let path = store_path();
    let mut map = match std::fs::read(&path) {
        Ok(bytes) => parse_store(&bytes)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(anyhow::anyhow!("read known_hosts: {e}")),
    };
    map.remove(&endpoint_key(host, port));
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&map)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// SHA-256 fingerprint in OpenSSH `SHA256:...` form (no padding `=`).
pub fn sha256_fingerprint(raw_key_bytes: &[u8]) -> String {
    format!("SHA256:{}", base64_nopad(&sha256(raw_key_bytes)))
}

fn base64_nopad(bytes: &[u8]) -> String {
    const ALPH: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        let b0 = bytes[i];
        let b1 = if i + 1 < bytes.len() { bytes[i + 1] } else { 0 };
        let b2 = if i + 2 < bytes.len() { bytes[i + 2] } else { 0 };
        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
        out.push(ALPH[((n >> 18) & 63) as usize] as char);
        out.push(ALPH[((n >> 12) & 63) as usize] as char);
        if i + 1 < bytes.len() {
            out.push(ALPH[((n >> 6) & 63) as usize] as char);
        }
        if i + 2 < bytes.len() {
            out.push(ALPH[(n & 63) as usize] as char);
        }
        i += 3;
    }
    out
}

// Minimal SHA-256 (FIPS 180-4) so hostkeys.rs needs no new dependency.
fn sha256(msg: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut data = msg.to_vec();
    let bitlen = (msg.len() as u64).wrapping_mul(8);
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bitlen.to_be_bytes());
    for chunk in data.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    let mut out = [0u8; 32];
    for (i, v) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

#[cfg(test)]
pub(crate) fn test_serial() -> std::sync::MutexGuard<'static, ()> {
    static M: std::sync::Mutex<()> = std::sync::Mutex::new(());
    M.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_key_lowercases_host() {
        assert_eq!(endpoint_key("Example.COM", 22), "example.com:22");
    }

    #[test]
    fn sha256_fingerprint_matches_known_vector() {
        // SHA-256("abc") — FIPS reference.
        assert_eq!(
            sha256_fingerprint(b"abc"),
            "SHA256:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0"
        );
    }

    #[test]
    fn malformed_store_fails_closed() {
        assert!(parse_store(b"{not json").is_err());
        assert!(parse_store(b"[1,2]").is_err());
        assert!(parse_store(b"{\"h:22\": 42}").is_err());
    }

    #[test]
    fn empty_store_parses_empty() {
        assert!(parse_store(b"").unwrap().is_empty());
        assert!(parse_store(b"  \n ").unwrap().is_empty());
    }

    /// Windows ARM64 validation gate: a GUI-launched Windows process
    /// typically has %APPDATA% set but no HOME/XDG_CONFIG_HOME, and no
    /// `/tmp`. The trust store must resolve under APPDATA (Roaming),
    /// never scatter to CWD or fail. Serialized: mutates process env.
    #[test]
    fn store_path_prefers_windows_appdata() {
        let _g = test_serial();
        // Snapshot real env so the process is left untouched.
        let prev = [
            ("APPDATA", std::env::var("APPDATA").ok()),
            ("USERPROFILE", std::env::var("USERPROFILE").ok()),
            ("XDG_CONFIG_HOME", std::env::var("XDG_CONFIG_HOME").ok()),
            ("HOME", std::env::var("HOME").ok()),
            ("STILL_KNOWN_HOSTS", std::env::var("STILL_KNOWN_HOSTS").ok()),
        ];
        // Simulate a GUI-launched Windows process.
        unsafe {
            std::env::remove_var("STILL_KNOWN_HOSTS");
            std::env::remove_var("XDG_CONFIG_HOME");
            std::env::remove_var("HOME");
            std::env::remove_var("USERPROFILE");
            std::env::set_var("APPDATA", r"C:\Users\tester\AppData\Roaming");
        }
        let p = store_path();
        assert_eq!(
            p,
            PathBuf::from(r"C:\Users\tester\AppData\Roaming")
                .join("Still")
                .join("known_hosts.json")
        );
        // Restore.
        unsafe {
            for (k, v) in prev {
                match v {
                    Some(val) => std::env::set_var(k, val),
                    None => std::env::remove_var(k),
                }
            }
        }
    }

    #[test]
    fn trust_roundtrip_isolated() {
        let _g = test_serial();
        let dir = std::env::temp_dir().join(format!(
            "still-hk-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("known_hosts.json");
        unsafe { std::env::set_var("STILL_KNOWN_HOSTS", &p); }
        assert_eq!(lookup_trusted("H", 22).unwrap(), None);
        store_trusted("H", 22, "ssh-ed25519 AAAAtest").unwrap();
        assert!(is_trusted("h", 22, "ssh-ed25519 AAAAtest"));
        assert!(!is_trusted("h", 22, "ssh-ed25519 AAAAdiff"));
        assert!(was_ever_trusted("H", 22));
        forget_trusted("h", 22).unwrap();
        assert!(!was_ever_trusted("h", 22));
        unsafe { std::env::remove_var("STILL_KNOWN_HOSTS"); }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
