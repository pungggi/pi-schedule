import { describe, it, expect } from "vitest";
import { decideDelivery } from "../src/delivery.js";

describe("decideDelivery — origin-first delivery ladder", () => {
  it("delivers a full turn in the session that created the job when it is alive", () => {
    expect(
      decideDelivery({
        selfSessionId: "A",
        originSessionId: "A",
        aliveSessionIds: ["A", "B", "C"],
      }),
    ).toBe("turn");
  });

  it("defers in a non-origin session while the origin session is alive", () => {
    expect(
      decideDelivery({
        selfSessionId: "B",
        originSessionId: "A",
        aliveSessionIds: ["A", "B", "C"],
      }),
    ).toBe("defer");
  });

  it("delivers a full turn in a lone session even when it is not the origin (single-session projects stay simple)", () => {
    expect(
      decideDelivery({
        selfSessionId: "B",
        originSessionId: "A", // A has since closed
        aliveSessionIds: ["B"],
      }),
    ).toBe("turn");
  });

  it("downgrades to a notify in the deterministically-elected owner when origin is gone and several sessions are open", () => {
    // owner = lexicographically smallest live id = "B"
    expect(
      decideDelivery({
        selfSessionId: "B",
        originSessionId: "A",
        aliveSessionIds: ["B", "C", "D"],
      }),
    ).toBe("notify");
  });

  it("defers in the non-owner sessions when origin is gone and several are open", () => {
    expect(
      decideDelivery({
        selfSessionId: "C",
        originSessionId: "A",
        aliveSessionIds: ["B", "C", "D"],
      }),
    ).toBe("defer");
  });

  it("treats a job with no recorded origin (legacy row) as origin-absent", () => {
    // multi-session → notify in the elected owner, not a surprise turn
    expect(
      decideDelivery({
        selfSessionId: "B",
        originSessionId: undefined,
        aliveSessionIds: ["B", "C"],
      }),
    ).toBe("notify");
    // lone session → full turn
    expect(
      decideDelivery({
        selfSessionId: "B",
        originSessionId: undefined,
        aliveSessionIds: ["B"],
      }),
    ).toBe("turn");
  });

  it("always counts self as alive even if the presence set omits it", () => {
    // origin gone, presence hasn't recorded self yet: self is the only known
    // live session → lone-session turn, never a phantom multi-session notify.
    expect(
      decideDelivery({
        selfSessionId: "Z",
        originSessionId: "A",
        aliveSessionIds: [],
      }),
    ).toBe("turn");
  });

  it("is deterministic across sessions: every session agrees on the same owner", () => {
    const alive = ["D", "B", "C"]; // unsorted on purpose
    const roles = alive.map((self) =>
      decideDelivery({
        selfSessionId: self,
        originSessionId: "A",
        aliveSessionIds: alive,
      }),
    );
    // exactly one "notify" (the owner "B"), the rest "defer"
    expect(roles.filter((r) => r === "notify")).toHaveLength(1);
    expect(roles.filter((r) => r === "defer")).toHaveLength(2);
    expect(
      decideDelivery({
        selfSessionId: "B",
        originSessionId: "A",
        aliveSessionIds: alive,
      }),
    ).toBe("notify");
  });
});
