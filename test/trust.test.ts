/**
 * TrustStore — project trust registry for the auto-fire gate.
 *
 * Fail-closed on corrupt/missing files; idempotent trust(); atomic writes.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TrustStore } from "../src/trust.js";

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "pi-sched-trust-"));
  temps.push(root);
  const file = join(root, "trusted.json");
  return { root, file, store: new TrustStore(file) };
}

describe("TrustStore", () => {
  it("is untrusted by default (missing file → fail closed)", () => {
    const { root, store } = setup();
    expect(store.isTrusted(root)).toBe(false);
  });

  it("trust() persists and survives a new store instance", () => {
    const { root, file } = setup();
    new TrustStore(file).trust(root);
    expect(new TrustStore(file).isTrusted(root)).toBe(true);
  });

  it("trust() is idempotent and refreshes trustedAt", () => {
    const { root, file } = setup();
    const s = new TrustStore(file);
    s.trust(root, new Date("2025-01-01T00:00:00.000Z"));
    s.trust(root, new Date("2026-01-01T00:00:00.000Z"));
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const keys = Object.keys(raw.projects);
    expect(keys).toHaveLength(1);
    expect(raw.projects[keys[0]!].trustedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("corrupt file → fail closed for the gate, rewritten on next trust()", () => {
    const { root, file } = setup();
    writeFileSync(file, "{not json", "utf8");
    const s = new TrustStore(file);
    expect(s.isTrusted(root)).toBe(false); // gate: fail closed
    s.trust(root); // write path recovers
    expect(s.isTrusted(root)).toBe(true);
  });

  it("wrong version → fail closed", () => {
    const { root, file } = setup();
    writeFileSync(file, JSON.stringify({ version: 99, projects: {} }), "utf8");
    expect(new TrustStore(file).isTrusted(root)).toBe(false);
  });

  it("different project roots are independent", () => {
    const { root, file } = setup();
    const other = join(root, "other-project");
    const s = new TrustStore(file);
    s.trust(root);
    expect(s.isTrusted(root)).toBe(true);
    expect(s.isTrusted(other)).toBe(false);
    expect(s.list()).toHaveLength(1);
  });

  it("empty file → untrusted", () => {
    const { root, file } = setup();
    writeFileSync(file, "", "utf8");
    expect(new TrustStore(file).isTrusted(root)).toBe(false);
  });

  it("projects entry that is not an object → untrusted", () => {
    const { root, file } = setup();
    const key = process.platform === "win32" ? root.toLowerCase() : root;
    writeFileSync(
      file,
      JSON.stringify({ version: 1, projects: { [key]: "yes" } }),
      "utf8",
    );
    expect(new TrustStore(file).isTrusted(root)).toBe(false);
  });
});
