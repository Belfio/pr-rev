import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
const repoDir = "/Users/alfredobelfiori/Work/pr-rev/work/Belfio-ourway-408fe166f315";
console.log("tsconfig exists:", existsSync(repoDir + "/tsconfig.json"));
const raw = readFileSync(repoDir + "/tsconfig.json", "utf8");
const cfg = JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1"));
console.log("paths:", cfg.compilerOptions?.paths);
console.log("probe target exists:", existsSync(repoDir + "/src/lib/admin.ts"), existsSync(repoDir + "/src/lib/admin.tsx"));
