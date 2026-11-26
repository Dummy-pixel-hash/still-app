// Accessibility source regressions — run: node tests-m3/a11y-regressions.mjs (from still-app/).
// Static guards for rules that axe cannot see in a single render.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  — " + e : ""}`); c ? pass++ : fail++; };

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}
// Agents keep their own smoked-glass system; the rules below cover the workspace.
const isAgent = (p) => /(^|\/)(Agent|RemoteAgent|CustomAgent)[A-Za-z]*\.tsx$/.test(p) || p.includes("/agents/");
const files = walk("src").filter((p) => !isAgent(p));

// 1. No text below 12px outside Agents (decorative aria-hidden mini-chrome is
//    exempt when it follows an `a11y-exempt` comment within 12 lines).
const small = [];
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!/text-\[(?:[0-9]|1[01])px\]/.test(line)) return;
    const exempt = lines.slice(Math.max(0, i - 12), i + 1).some((l) => l.includes("a11y-exempt"));
    if (!exempt) small.push(`${f}:${i + 1}`);
  });
}
ok("no text-[<12px] outside Agents (except marked decorative chrome)", small.length === 0, small.slice(0, 5).join(", "));

// 2. No bare outline-none: the global :focus-visible ring must stay visible.
const bare = files.filter((f) => /(^|[\s"'`])outline-none(?=[\s"'`])/.test(readFileSync(f, "utf8")));
ok("no outline-none classes in workspace components", bare.length === 0, bare.join(", "));
const theme = readFileSync("src/styles/theme.css", "utf8");
ok("global zero-specificity focus ring exists",
  /:where\(button, a, input, select, textarea, summary, \[tabindex\]\):not\(\.xterm-helper-textarea\):focus-visible/.test(theme) &&
  /outline: 2px solid var\(--ring\)/.test(theme));

// 3. The drag grip is decorative: never a separator, hidden from AT.
const card = readFileSync("src/components/SessionCard.tsx", "utf8");
ok("card grip has no role=separator", !card.includes('role="separator"'));
const grip = card.split("data-drag-handle")[1]?.slice(0, 120) ?? "";
ok("card grip is aria-hidden", grip.includes("aria-hidden"));
ok("card menu is a sibling of the Open button, not nested in it",
  /data-card-open[\s\S]*?rounded-\[20px\]"\s*\/>/.test(card) &&
  card.lastIndexOf("data-menu-button") > card.indexOf("data-card-open"));

// 4. aria-label must not sit on the same element as aria-labelledby.
const clash = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  let m;
  const re = /aria-labelledby=/g;
  while ((m = re.exec(src))) {
    const start = src.lastIndexOf("<", m.index);
    const next = src.slice(m.index).search(/<\/?[A-Za-z]/);
    const tag = src.slice(start, m.index + (next < 0 ? 400 : Math.min(next, 400)));
    if (/aria-label=/.test(tag)) clash.push(`${f}@${src.slice(0, m.index).split("\n").length}`);
  }
}
ok("no aria-label on elements that also have aria-labelledby", clash.length === 0, clash.slice(0, 5).join(", "));

console.log(`\n==== ${pass}/${pass + fail} a11y regression checks passed ====`);
process.exit(fail ? 1 : 0);
