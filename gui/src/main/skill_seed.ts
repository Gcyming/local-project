

















import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";


const SEED_MANIFEST = ".seed-manifest.json";


function readSeedManifest(skillsDir: string): string[] {
  const p = join(skillsDir, SEED_MANIFEST);
  if (!existsSync(p)) { return []; }
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeSeedManifest(skillsDir: string, names: string[]): void {
  try {
    writeFileSync(join(skillsDir, SEED_MANIFEST), `${JSON.stringify([...names].sort(), null, 2)}\n`, "utf8");
  } catch {
    
  }
}

function subdirsOf(base: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }
  return entries.filter((e) => {
    if (e.startsWith(".")) { return false; }
    try {
      return statSync(join(base, e)).isDirectory();
    } catch {
      return false;
    }
  });
}

















export function seedDefaultSkills(seedDir: string, skillsDir: string): string[] {
  const names = subdirsOf(seedDir);
  if (names.length === 0) { return []; }
  const known = new Set(readSeedManifest(skillsDir));
  const seeded: string[] = [];
  try {
    mkdirSync(skillsDir, { recursive: true });
    for (const name of names) {
      if (known.has(name)) { continue; }
      const target = join(skillsDir, name);
      
      if (existsSync(target)) { continue; }
      cpSync(join(seedDir, name), target, { recursive: true });
      known.add(name);
      seeded.push(name);
    }
  } catch {
    return seeded;
  }
  if (seeded.length > 0) { writeSeedManifest(skillsDir, [...known]); }
  return seeded;
}
