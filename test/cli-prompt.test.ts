import { describe, expect, it } from "vitest";
import {
  hasCliInitialPrompt,
  shouldSkipDueOnSessionStart,
} from "../src/cli-prompt.js";

describe("hasCliInitialPrompt", () => {
  it("detects trailing message args", () => {
    expect(
      hasCliInitialPrompt(["node", "pi", "check this and that"]),
    ).toBe(true);
  });

  it("returns false for flag-only launches", () => {
    expect(hasCliInitialPrompt(["node", "pi"])).toBe(false);
    expect(hasCliInitialPrompt(["node", "pi", "--help"])).toBe(false);
  });

  it("detects -p / print-style messages when present as positionals", () => {
    expect(hasCliInitialPrompt(["node", "pi", "-p", "do work"])).toBe(true);
  });
});

describe("shouldSkipDueOnSessionStart", () => {
  it("skips only startup when CLI prompt present", () => {
    const yes = () => true;
    const no = () => false;
    expect(shouldSkipDueOnSessionStart("startup", yes)).toBe(true);
    expect(shouldSkipDueOnSessionStart("new", yes)).toBe(false);
    expect(shouldSkipDueOnSessionStart("resume", yes)).toBe(false);
    expect(shouldSkipDueOnSessionStart("startup", no)).toBe(false);
  });
});
