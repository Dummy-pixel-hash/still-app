// Tauri's Android project is ignored/generated. Keep our Activity implementation
// in tracked source and apply it on every Android build before bundling the real UI.
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../', import.meta.url));
const source = new URL('../../src-tauri/android/MainActivity.kt', import.meta.url);
const target = new URL('../../src-tauri/gen/android/app/src/main/java/dev/still/app/MainActivity.kt', import.meta.url);
if (!existsSync(target)) {
  console.error('Android project is not initialized. Run npm run tauri -- android init first.');
  process.exit(1);
}
copyFileSync(source, target);
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
