import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps application package and lockfile metadata at the current release", () => {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));
  const pkg = read("package.json");
  const lock = read("package-lock.json");
  expect(pkg.version).toBe("1.0.0");
  expect(lock.version).toBe(pkg.version);
  expect(lock.packages[""].version).toBe(pkg.version);
});
