// Tauri's Android project is ignored/generated. Keep our Activity implementation
// in tracked source and apply it on every Android build before bundling the real UI.
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareAndroidProject } from './prepare.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
prepareAndroidProject(root);
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
