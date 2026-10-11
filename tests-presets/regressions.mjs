// Preset regression tests — run: node tests-presets/regressions.mjs (from still-app/).
// Guards the "presets are not being saved" fix: auto-save on create,
// builtin-excluded cap, case-insensitive upsert, legacy migration.
import { readFileSync } from "node:fs";

// ---- localStorage mock (presets.ts touches it at call time) ----
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
  clear: () => void store.clear(),
};

const {
  BUILTIN_PRESETS,
  MAX_PRESETS,
  PRESETS_KEY,
  isBuiltinPreset,
  loadPresets,
  savePresets,
  upsertPreset,
} = await import("../src/session/presets.ts");

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  — " + e : ""}`); c ? pass++ : fail++; };
const reset = () => store.clear();

// 1. Roundtrip: saved users reload intact, builtins re-added, builtins never persisted.
reset();
{
  const users = [
    { id: "preset-a", name: "Prod FRA", host: "10.0.0.1", port: "22", username: "deploy", workingDirectory: "~" },
    { id: "preset-b", name: "Staging", host: "10.0.0.2", port: "2222", username: "app", workingDirectory: "/srv" },
  ];
  const next = savePresets([...BUILTIN_PRESETS, ...users]);
  const raw = JSON.parse(store.get(PRESETS_KEY));
  ok("builtins never persisted", raw.every((p) => !isBuiltinPreset(p.id)));
  ok("save returns builtins + users", next.length === BUILTIN_PRESETS.length + users.length);
  const loaded = loadPresets();
  ok("roundtrip reloads users", loaded.some((p) => p.name === "Prod FRA" && p.host === "10.0.0.1"));
}

// 2. Cap applies to users only — builtins don't eat the budget.
reset();
{
  const many = Array.from({ length: MAX_PRESETS + 5 }, (_, i) => ({
    id: `preset-${i}`, name: `Box ${i}`, host: `10.0.1.${i}`, port: "22", username: "u", workingDirectory: "~",
  }));
  const next = savePresets([...BUILTIN_PRESETS, ...many]);
  const usersKept = next.filter((p) => !isBuiltinPreset(p.id));
  ok(`cap keeps exactly ${MAX_PRESETS} users`, usersKept.length === MAX_PRESETS, `got ${usersKept.length}`);
  ok("builtins still present after cap", next.length === MAX_PRESETS + BUILTIN_PRESETS.length);
  const raw = JSON.parse(store.get(PRESETS_KEY));
  ok("storage holds capped users only", raw.length === MAX_PRESETS);
}

// 3. Case-insensitive upsert reuses id, updates fields, no duplicate.
reset();
{
  let list = savePresets([...BUILTIN_PRESETS,
    { id: "preset-1", name: "Prod FRA", host: "old", port: "22", username: "a", workingDirectory: "~" }]);
  const before = list.find((p) => p.name === "Prod FRA");
  list = upsertPreset(list, { name: "  prod fra ", host: "new-host", port: "22", username: "b", workingDirectory: "" });
  const matches = list.filter((p) => p.name.toLowerCase() === "prod fra");
  ok("upsert dedups case variants", matches.length === 1);
  ok("upsert reuses id", matches[0].id === before.id);
  ok("upsert updates host", matches[0].host === "new-host");
  ok("upsert defaults dir to ~", matches[0].workingDirectory === "~");
  ok("upsert moves to front of users", list.filter((p) => !isBuiltinPreset(p.id))[0].id === before.id);
}

// 4. New name creates entry with fallback; blank host is a no-op.
reset();
{
  let list = loadPresets();
  const n0 = list.length;
  const same = upsertPreset(list, { name: "X", host: "   ", port: "22", username: "u", workingDirectory: "~" });
  ok("blank host no-op (same ref)", same === list && same.length === n0);
  list = upsertPreset(list, { name: "", host: "db-01", port: "22", username: "u", workingDirectory: "~", queryFallback: "Typed Name" });
  ok("query fallback names preset", list.some((p) => p.name === "Typed Name"));
  list = upsertPreset(list, { name: "", host: "bare-host", port: "22", username: "", workingDirectory: "~" });
  ok("host fallback names preset", list.some((p) => p.name === "bare-host"));
}

// 5. Legacy label migrates to name.
reset();
{
  store.set(PRESETS_KEY, JSON.stringify([{ id: "legacy-1", label: "deploy@10.0.0.9", host: "10.0.0.9", port: 22, username: "deploy" }]));
  const loaded = loadPresets();
  ok("legacy label -> name", loaded.some((p) => p.name === "deploy@10.0.0.9"));
}

// 6. Wizard wires auto-save into both submit paths.
{
  const wizard = readFileSync("src/components/NewSessionWizard.tsx", "utf8");
  ok("wizard imports upsertPreset", wizard.includes("upsertPreset"));
  ok("finish() auto-saves", wizard.includes("const finish = ") && /const finish[\s\S]*?autoSavePreset\(\)[\s\S]*?onSubmit/.test(wizard));
  ok("finishFromPreset() auto-saves", /finishFromPreset[\s\S]*?autoSavePreset\(\)[\s\S]*?onSubmit/.test(wizard));
  ok("explicit save + delete kept", wizard.includes("saveCurrentAsPreset") && wizard.includes("removePreset"));
  ok("invalid port never saved", wizard.includes("portError(port)"));
}

console.log(`\n==== ${pass}/${pass + fail} preset regression checks passed ====`);
process.exit(fail ? 1 : 0);
