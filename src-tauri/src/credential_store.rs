//! Platform credential store facade.
//!
//! Desktop keeps keyring's native OS-provider behavior. On Android, keyring's
//! default v1 facade intentionally reports the platform unsupported; select the
//! crate's Android Keystore-backed native store before exposing SSH commands.

#[cfg(target_os = "android")]
pub use keyring_core::{Entry, Error};
#[cfg(not(target_os = "android"))]
pub use keyring::{Entry, Error};

#[cfg(target_os = "android")]
pub fn initialize() -> Result<(), Error> {
    let store = android_native_keyring_store::Store::new()?;
    keyring_core::set_default_store(store);
    Ok(())
}

#[cfg(not(target_os = "android"))]
pub fn initialize() -> Result<(), Error> {
    // keyring's v1 provider initializes lazily on first use on desktop.
    Ok(())
}
