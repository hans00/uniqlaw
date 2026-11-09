import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findProjectDir } from "../src/project.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("finds the project from a subdirectory or from inside .uniqlaw/; falls back to the start dir", () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "uq-proj-")));
  mkdirSync(join(dir, ".uniqlaw", "jobs"), { recursive: true });
  writeFileSync(join(dir, ".uniqlaw", "settings.json"), "{}");
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  expect(findProjectDir(join(dir, ".uniqlaw"))).toBe(dir);
  expect(findProjectDir(join(dir, ".uniqlaw", "jobs"))).toBe(dir);
  expect(findProjectDir(join(dir, "src", "deep"))).toBe(dir);
  expect(findProjectDir(tmpdir())).toBe(resolve(tmpdir())); // nothing above: the start dir
});
