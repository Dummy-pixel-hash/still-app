import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function androidVersionCode(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Only stable MAJOR.MINOR.PATCH versions can publish updates.');
  const [major, minor, patch] = version.split('.').map(Number);
  const code = major * 1_000_000 + minor * 1_000 + patch;
  if (minor > 999 || patch > 999 || !Number.isSafeInteger(code) || code < 1 || code > 2_100_000_000) throw new Error('Version does not fit a monotonic Android versionCode.');
  return code;
}

export async function checkTag(root, tag) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw new Error('The release tag must be a stable vMAJOR.MINOR.PATCH version.');
  const version = tag.slice(1);
  androidVersionCode(version);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const config = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const cargo = await readFile(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
  const cargoVersion = cargo.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
  if ([pkg.version, lock.version, lock.packages?.['']?.version, config.version, cargoVersion].some(value => value !== version)) throw new Error('Release tag, package.json, package-lock.json, tauri.conf.json and Cargo.toml must have the same version.');
  return version;
}

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : entry.isFile() ? [file] : [];
  }));
  return nested.flat();
}

function unique(files, predicate, description) {
  const matches = files.filter(predicate);
  if (matches.length !== 1) throw new Error(`Expected exactly one ${description}, found ${matches.length}.`);
  return matches[0];
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function androidMetadata(root, apk, sdk) {
  if (!sdk) throw new Error('ANDROID_HOME must point to an Android SDK.');
  const analyzer = path.join(sdk, 'cmdline-tools/latest/bin/apkanalyzer');
  const signer = path.join(sdk, 'build-tools/36.0.0/apksigner');
  const manifest = command => execFileSync(analyzer, ['manifest', command, apk], { encoding: 'utf8' }).trim();
  const certificate = execFileSync(signer, ['verify', '--print-certs', apk], { encoding: 'utf8' });
  const expected = (await readFile(path.join(root, 'src-tauri/android/signing-certificate.sha256'), 'utf8')).trim();
  if (!certificate.includes(`Signer #1 certificate SHA-256 digest: ${expected}`) || certificate.includes('Signer #2')) throw new Error('APK signing certificate does not match the production identity.');
  const applicationId = manifest('application-id');
  const version = manifest('version-name');
  const versionCode = Number(manifest('version-code'));
  const minSdk = Number(manifest('min-sdk'));
  if (applicationId !== 'dev.still.app' || manifest('debuggable') !== 'false') throw new Error('Release must be a non-debuggable dev.still.app APK.');
  if (versionCode !== androidVersionCode(version) || minSdk !== 24) throw new Error('Unexpected Android versionCode or minimum SDK.');
  const bytes = await readFile(apk);
  return { platform: 'android', architecture: 'arm64', applicationId, version, versionCode, minSdk, bytes: bytes.length, sha256: hash(bytes), certificateSha256: expected };
}

export async function prepareAssets({ root, input, output, tag, repository, commit = '', now = new Date() }) {
  const version = await checkTag(root, tag);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GitHub repository.');
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error('Release output directory must be empty; refusing to overwrite artifacts.');
  const latest = { version, channel: 'stable', notes: `Still ${version}`, pub_date: now.toISOString(), platforms: {} };
  const packages = [];
  const assets = [];
  const copy = async (source, name) => {
    const target = path.join(output, name);
    await copyFile(source, target, constants.COPYFILE_EXCL);
    assets.push(target);
    const bytes = await readFile(target);
    return { name, url: `https://github.com/${repository}/releases/download/${tag}/${name}`, bytes: bytes.length, sha256: hash(bytes) };
  };
  for (const [arch, target] of [['x64', 'x86_64'], ['arm64', 'aarch64']]) {
    const files = await filesIn(path.join(input, `windows-${arch}`));
    const installer = unique(files, file => /setup\.exe$/i.test(file), `Windows ${arch} installer`);
    const signatureFile = `${installer}.sig`;
    if (!(await stat(signatureFile)).isFile()) throw new Error(`Missing updater signature for ${arch}.`);
    const signature = (await readFile(signatureFile, 'utf8')).trim();
    if (!signature || !/^[A-Za-z0-9+/=\r\n]+$/.test(signature)) throw new Error(`Invalid updater signature for ${arch}.`);
    const name = `Still_${version}_windows-${arch}-setup.exe`;
    const artifact = await copy(installer, name);
    await copy(signatureFile, `${name}.sig`);
    latest.platforms[`windows-${target}`] = { url: artifact.url, signature };
    packages.push({ ...artifact, platform: 'windows', architecture: arch });
  }
  const androidFiles = await filesIn(path.join(input, 'android-arm64'));
  const apk = unique(androidFiles, file => file.endsWith('.apk'), 'Android APK');
  const metadataFile = unique(androidFiles, file => path.basename(file) === 'android-package.json', 'Android package metadata');
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
  const expectedCertificate = (await readFile(path.join(root, 'src-tauri/android/signing-certificate.sha256'), 'utf8')).trim();
  if (metadata.platform !== 'android' || metadata.architecture !== 'arm64' || metadata.applicationId !== 'dev.still.app' || metadata.version !== version || metadata.versionCode !== androidVersionCode(version) || metadata.minSdk !== 24 || metadata.certificateSha256 !== expectedCertificate) throw new Error('Android package metadata is incompatible with this release.');
  const androidAsset = await copy(apk, `Still_${version}_android-arm64.apk`);
  if (metadata.bytes !== androidAsset.bytes || metadata.sha256 !== androidAsset.sha256) throw new Error('APK size or checksum differs from its verified metadata.');
  packages.push({ ...metadata, ...androidAsset });
  for (const [name, value] of [
    ['latest.json', latest],
    ['build-manifest.json', { schemaVersion: 1, version, channel: 'stable', commit, packages }],
  ]) {
    const target = path.join(output, name);
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    assets.push(target);
  }
  const sums = await Promise.all(assets.map(async file => `${hash(await readFile(file))}  ${path.basename(file)}`));
  const checksumFile = path.join(output, 'SHA256SUMS.txt');
  await writeFile(checksumFile, `${sums.join('\n')}\n`, { flag: 'wx' });
  assets.push(checksumFile);
  return assets;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = process.cwd();
  const [action, ...args] = process.argv.slice(2);
  if (action === 'check-tag') console.log(await checkTag(root, args[0] || ''));
  else if (action === 'android-metadata') {
    const metadata = await androidMetadata(root, args[0], process.env.ANDROID_HOME);
    await writeFile(args[1], `${JSON.stringify(metadata, null, 2)}\n`);
    console.log('Verified production APK identity, version, signer, SDK and checksum.');
  } else if (action === 'prepare') {
    const assets = await prepareAssets({ root, input: args[0], output: args[1], tag: process.env.GITHUB_REF_NAME, repository: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA });
    await writeFile('release-assets.txt', `${assets.join('\n')}\n`);
  } else throw new Error('Usage: metadata.mjs check-tag TAG | android-metadata APK OUTPUT | prepare INPUT OUTPUT');
}
