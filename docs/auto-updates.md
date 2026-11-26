# Automatic updates

## Windows

The Tauri updater verifies signed installer artifacts against the public key in
`src-tauri/tauri.windows.conf.json`. The app checks shortly after startup and
every six hours while running (with a persisted six-hour check cooldown),
downloads a newer stable release in the background, and waits for the user to
choose **Install and restart**, then confirm **Install now**. Installation is
not enabled until signature verification completes. There is also a manual
**Check for updates** action in Settings. GitHub prereleases are excluded: the
feed is `releases/latest/download/latest.json`.

The first updater-enabled Windows installation must be installed manually.
Automatic updates support NSIS installations; MSI/development installations are
not silently switched to a different installer family. Updater permissions and
the plugin are Windows-only and restricted to the main window. Ordinary builds
do not need signing secrets: `tauri.updater-build.conf.json` enables signed
updater artifacts only for the release pipeline.

The `stable app release` workflow in `.github/workflows/release.yml` runs for
`v*` tags and rejects anything except a stable `vMAJOR.MINOR.PATCH` tag.
Windows builds require these repository Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY` — contents of the private key file.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — passphrase for that key.

The keypair for the current configuration was generated locally at
`~/.tauri/still-app-updater.key` with its passphrase at
`~/.tauri/still-app-updater.password`; both files are mode 600. A second local
copy is at `/mnt/data2/data/still-signing-backup/` (directory mode 700; files
mode 600). This is a separate mounted partition, but not an off-device backup;
make another encrypted copy on storage you control. Losing the private key or
its passphrase means already-installed clients cannot receive future signed
updates. Never commit or paste either file into chat.

Before tagging, synchronize `package.json`, `package-lock.json`,
`src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` with the new version.
The release script checks the app/tag versions and rejects mismatches. The
first new stable tag must be newer than installed versions, for example
`v0.1.2`; the existing `v0.1.1` release is a prerelease and is intentionally not
the stable feed. No new version tag or release has been published by this work.

The workflow validates/tests the source, builds Windows x64 and ARM64 on real
Windows runners, and builds Android ARM64 on Linux. Only after all three build
targets succeed does it assemble a draft release with installers, APK, detached
Windows signatures, `latest.json`, `build-manifest.json`, and `SHA256SUMS.txt`.
It then promotes that complete draft to the latest stable release. Asset URLs
in both manifests are version-pinned; clients never contain a GitHub token.

## Android

### Signing identity and backup

The local APK's signing certificate was inspected on 2026-11-13 and is
`CN=Android Debug`. No existing Android release keystore or published Android
release asset was found in the locations inspected. A new production signing
identity was created without replacing any existing key or modifying an
installed app. This does not prove that an APK installed on an unconnected
phone has the same debug signer; check that device before planning migration.

- Keystore: `/home/Darsh/.tauri/still-android/still-app-release.p12`
- Passphrase: `/home/Darsh/.tauri/still-android/still-app-release.password`
- Public certificate: `/home/Darsh/.tauri/still-android/still-app-release.crt`
- Key alias: `still-app`
- Verified backup: `/mnt/data2/data/still-signing-backup/android/`, containing
  the same three files.

Both directories have mode 700 and all files have mode 600. The PKCS#12
keystore is password-protected; its key uses the same passphrase as the
keystore. Keep this identity for future production APKs. Its public certificate
SHA-256 fingerprint is:

```text
9b022bf0f9e7e4f59f1cc57fecd403cd0728367fe88150e0484524b1119a54c7
```

The repository's GitHub Actions secrets now contain `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`.
Signing was tested successfully on a temporary copy of the development APK;
that test APK was not installed, published, or retained as a release build.
The original development APK was not changed.

This backup is on another partition of the same physical drive, not an
off-device backup. Keep an additional encrypted copy elsewhere. Do not commit
the keystore or passphrase, paste them into chat, rotate the key casually, or
replace a previously distributed production signing identity with this one.

### Android update flow

`src-tauri/android/UpdaterPlugin.kt` uses Android's DownloadManager for downloads
that can continue while the app is backgrounded or its process is killed. The
job ID and validated metadata are persisted so the next launch can recover
progress. Downloads default to unmetered networks; Settings can allow metered
networks. There is no periodic checking service while Still is completely
closed: checking happens at startup/foreground and while the app is running.

The native code accepts only stable, version-pinned release URLs from this
repository and the correct application/architecture/SDK/version metadata. It
checks file size, SHA-256, package identity, a higher `versionCode`, and the
installed app's signing identity before handing the file to Android. These
checks run again immediately before installation. Android's package installer
is the final authority on signature validity. Installation requires explicit
user confirmation; if necessary, Still opens the OS's per-source installation
permission screen and asks the user to return and try again.

Debug builds do not automatically download or install production updates.
The tracked build hook in `scripts/android/prepare.mjs` applies the Kotlin
integration, permission, keep rules, and `release.gradle.kts` to the ignored
generated Android project reproducibly. The release script pins compile/target
SDK 36 and minimum SDK 24, requires production signing credentials, and the
pipeline checks the packaged APK's identity, version, certificate and debug
flag. Android version codes follow Tauri's mapping:
`major * 1_000_000 + minor * 1_000 + patch` (minor and patch must be below 1000).

### Migration and outstanding device verification

Before installing the first production build, inspect the phone's certificate and
`versionCode`. A debug-signed APK cannot be upgraded in place to an APK signed
by this production key. If the phone uses a different signer, first establish
a data-preserving migration; do not uninstall it or clear its data automatically.
If another production key has already been distributed, recover and reuse that
key instead of silently replacing it.

Android updates must use a higher `versionCode`, verify the expected package
identity and signing certificate, and hand installation to Android's
user-confirmed installer. Do not publish a debug APK as a production update.

### Local validation (2026-11-13)

- Frontend production build and desktop `cargo check --locked`: passed.
- `npm run test:updates`: six release/preparation unit tests and six browser
  IPC-fixture tests passed. The browser tests are not physical-device evidence.
- Existing terminal/auth/host-trust regression suite: passed (76 checks).
- Existing mobile browser suite: passed (17 tests).
- Android ARM64 debug build: passed with the native integration.
- Android ARM64 production build: passed with the new release keystore.
- Packaged production APK identity, version, SDK, non-debug flag, certificate
  and checksum verified with the actual Android SDK tools.
- APK: `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`.
- Current local APK is a validation build at version `0.1.1`, versionCode `1001`;
  it is not the next published stable release and has not been installed.

Physical Android installation/upgrade/cancellation/data-preservation testing
and real Windows updater/installer runtime testing remain outstanding. No phone
is connected, no app has been uninstalled, and no release/tag has been pushed.
