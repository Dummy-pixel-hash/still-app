/** Pure project identity helpers shared by the desktop and phone indexes. */
export const projectKey = (project: { host: string; folder: string }) => JSON.stringify([project.host, project.folder])
export function folderName(cwd: string) { return cwd.split("/").filter(Boolean).pop() || cwd }
export function normalizeFolder(cwd: string) { return cwd === "/" ? cwd : cwd.trim().replace(/\/+$/, "") || "~" }
