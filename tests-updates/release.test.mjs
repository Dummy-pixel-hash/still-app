import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { androidVersionCode, checkTag, prepareAssets } from '../scripts/release/metadata.mjs';
import { prepareAndroidProject } from '../scripts/android/prepare.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'still-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (name, value) => {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  };
  const version = '0.1.2';
  const certificate = 'a'.repeat(64);
  await write('package.json', { version });
  await write('package-lock.json', { version, packages: { '': { version } } });
  await write('src-tauri/tauri.conf.json', { version });
  await write('src-tauri/Cargo.toml', `[package]\nname = "fixture"\nversion = "${version}"\n`);
  await write('src-tauri/android/signing-certificate.sha256', certificate);
  for (const arch of ['x64', 'arm64']) {
    await write(`input/windows-${arch}/nested/Still_setup.exe`, `test-only installer ${arch}`);
    await write(`input/windows-${arch}/nested/Still_setup.exe.sig`, Buffer.from('test-only signature').toString('base64'));
  }
  const apk = Buffer.from('test-only APK bytes');
  await write('input/android-arm64/app.apk', apk);
  await write('input/android-arm64/android-package.json', {
    platform: 'android', architecture: 'arm64', applicationId: 'dev.still.app', version,
    versionCode: 1002, minSdk: 24, certificateSha256: certificate,
    bytes: apk.length, sha256: createHash('sha256').update(apk).digest('hex'),
  });
  return { root, write, options: { root, input: path.join(root, 'input'), output: path.join(root, 'output'), tag: 'v0.1.2', repository: 'owner/repo', now: new Date('2026-11-13T00:00:00Z') } };
}

test('Android version codes are stable, bounded and monotonic', () => {
  assert.equal(androidVersionCode('0.1.1'), 1001);
  assert.equal(androidVersionCode('1.2.3'), 1_002_003);
  assert.ok(androidVersionCode('1.0.0') > androidVersionCode('0.999.999'));
  for (const bad of ['0.0.0', '01.1.2', '1.2.3-beta.1', '1.2.3+meta', '1.1000.0', '1.0.1000', '99999.0.0', 'nope']) {
    assert.throws(() => androidVersionCode(bad), undefined, bad);
  }
});

test('tag checks reject prereleases and mismatched project versions', async t => {
  const { root, write } = await fixture(t);
  assert.equal(await checkTag(root, 'v0.1.2'), '0.1.2');
  await assert.rejects(checkTag(root, 'v0.1.2-preview'), /stable/);
  await assert.rejects(checkTag(root, 'v0.1.3'), /same version/);
  await write('package.json', { version: '0.1.1' });
  await assert.rejects(checkTag(root, 'v0.1.2'), /same version/);
});

test('release preparation generates complete version-pinned feeds and checksums', async t => {
  const { options } = await fixture(t);
  const assets = await prepareAssets(options);
  const latest = JSON.parse(await readFile(path.join(options.output, 'latest.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(options.output, 'build-manifest.json'), 'utf8'));
  assert.equal(assets.length, 8);
  assert.equal(latest.channel, 'stable');
  assert.deepEqual(Object.keys(latest.platforms), ['windows-x86_64', 'windows-aarch64']);
  assert.equal(manifest.version, latest.version);
  assert.equal(manifest.packages.length, 3);
  for (const entry of manifest.packages) {
    assert.equal(entry.url, `https://github.com/owner/repo/releases/download/v0.1.2/${entry.name}`);
    const bytes = await readFile(path.join(options.output, entry.name));
    assert.equal(entry.bytes, bytes.length);
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  const sums = (await readFile(path.join(options.output, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n');
  assert.equal(sums.length, 7);
  await assert.rejects(prepareAssets(options), /refusing to overwrite/);
});

test('incomplete or tampered release inputs never generate an update feed', async t => {
  const { root, options } = await fixture(t);
  await unlink(path.join(root, 'input/windows-arm64/nested/Still_setup.exe.sig'));
  await assert.rejects(prepareAssets(options), /ENOENT/);
  assert.equal(existsSync(path.join(options.output, 'latest.json')), false);
});

test('Android checksum and signing identity mismatches block publication', async t => {
  const { root, write, options } = await fixture(t);
  await write('input/android-arm64/app.apk', 'tampered APK');
  await assert.rejects(prepareAssets(options), /checksum/);
  assert.equal(existsSync(path.join(options.output, 'latest.json')), false);
  const output = path.join(root, 'second-output');
  const metadata = JSON.parse(await readFile(path.join(root, 'input/android-arm64/android-package.json'), 'utf8'));
  await write('input/android-arm64/android-package.json', { ...metadata, certificateSha256: 'b'.repeat(64) });
  await assert.rejects(prepareAssets({ ...options, output }), /incompatible/);
});

test('tracked Android preparation is reproducible and preserves generated configuration', async t => {
  const { root, write } = await fixture(t);
  const base = 'src-tauri/gen/android/app';
  await write(`${base}/src/main/java/dev/still/app/MainActivity.kt`, 'old activity');
  await write('src-tauri/android/MainActivity.kt', 'tracked activity');
  await write('src-tauri/android/UpdaterPlugin.kt', 'tracked updater');
  await write(`${base}/build.gradle.kts`, '// custom generated settings\n');
  await write(`${base}/src/main/AndroidManifest.xml`, '<manifest><application android:label="Still" /></manifest>');
  prepareAndroidProject(root);
  prepareAndroidProject(root);
  const script = await readFile(path.join(root, base, 'build.gradle.kts'), 'utf8');
  const xml = await readFile(path.join(root, base, 'src/main/AndroidManifest.xml'), 'utf8');
  assert.equal(script.match(/release\.gradle\.kts/g).length, 1);
  assert.ok(script.startsWith('// custom generated settings'));
  assert.equal(xml.match(/REQUEST_INSTALL_PACKAGES/g).length, 1);
  assert.ok(xml.includes('android:label="Still"'));
  assert.equal(await readFile(path.join(root, base, 'src/main/java/dev/still/app/UpdaterPlugin.kt'), 'utf8'), 'tracked updater');
  assert.equal(script.includes('PASSWORD'), false);
});
