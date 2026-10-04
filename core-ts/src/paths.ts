









import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

function resolveProjectRoot(): string {
  const env = process.env.SLIME_ROOT;
  if (env && env.trim()) {
    return resolve(env);
  }
  return resolveProjectRootFrom(new URL("../../", import.meta.url).toString());
}







export function resolveProjectRootFrom(entryUrl: string): string {
  const derived = fileURLToPath(entryUrl);
  let dir = resolve(derived);
  for (;;) {
    if (existsSync(join(dir, "slime.toml"))) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) { break; }
    dir = parent;
  }
  return derived;
}


export const PROJECT_ROOT = resolveProjectRoot();
