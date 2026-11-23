import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function prepareAndroidProject(root) {
  const app = path.join(root, 'src-tauri/gen/android/app');
  const java = path.join(app, 'src/main/java/dev/still/app');
  if (!existsSync(path.join(java, 'MainActivity.kt'))) {
    throw new Error('Android project is not initialized. Run npm run tauri -- android init first.');
  }
  for (const name of ['MainActivity.kt', 'UpdaterPlugin.kt']) {
    copyFileSync(path.join(root, 'src-tauri/android', name), path.join(java, name));
  }
  const manifest = path.join(app, 'src/main/AndroidManifest.xml');
  const xml = readFileSync(manifest, 'utf8');
  if (!xml.includes('android.permission.REQUEST_INSTALL_PACKAGES')) {
    if (!xml.includes('<application')) throw new Error('Unrecognized Android manifest; refusing to patch it.');
    writeFileSync(manifest, xml.replace('<application', '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />\n\n    <application'));
  }
  const gradle = path.join(app, 'build.gradle.kts');
  const script = 'apply(from = file("../../../android/release.gradle.kts"))';
  const original = readFileSync(gradle, 'utf8');
  if (!original.includes(script)) writeFileSync(gradle, `${original.trimEnd()}\n\n${script}\n`);
  const proguard = path.join(app, 'still-updates.pro');
  writeFileSync(proguard, '-keep class dev.still.app.UpdaterPlugin { *; }\n');
}
