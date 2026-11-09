import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Nearest directory at or above `start` with .uniqlaw/settings.json (like git), so commands work from a
 *  subdirectory or from inside .uniqlaw/ itself. Falls back to `start`. */
export function findProjectDir(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".uniqlaw", "settings.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}
