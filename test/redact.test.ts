/**
 * redactSecrets — conservative credential redaction for persisted output.
 *
 * Test inputs are assembled at runtime (concatenated fragments) so no
 * token-shaped literals live in the source — GitHub push protection and
 * secret scanners flag realistic-looking fixtures.
 */

import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redact.js";

/** Fixture tokens built from fragments (no complete shapes in source). */
const fixtures = {
  ghPAT: `ghp_${"01".repeat(18)}`,
  ghApp: `github_pat_${"11AAAAAAA0"}${"aa".repeat(11)}`,
  npmToken: `npm_${"01".repeat(18)}`,
  openAI: `sk-${"ab".repeat(15)}`,
  stripe: `sk_live_${"0123456789abcdef"}`,
  slack: `xox${"b-"}${"12".repeat(12)}-${"34".repeat(12)}-${"ab".repeat(11)}`,
  aws: `AK${"IA"}${"IOSFODNN7EXAMPLE"}`,
  google: `AI${"zaSyA"}${"01".repeat(16)}`,
  jwt: `${"eyJhbGciOiJIUzI1NiJ9"}.${"eyJzdWIiOiIxIn0".repeat(1)}.${"dozjgNryP4J3jVmNHl0w5N"}`,
};

describe("redactSecrets", () => {
  it("redacts well-known token shapes", () => {
    for (const c of Object.values(fixtures)) {
      const out = redactSecrets(`token: ${c}`);
      expect(out, c).not.toContain(c);
      expect(out, c).toContain("[REDACTED]");
    }
  });

  it("redacts Bearer headers", () => {
    expect(redactSecrets(`Authorization: Bearer ${"ab".repeat(12)}`)).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  it("redacts explicit assignments in headers, JSON, and CLI forms", () => {
    expect(redactSecrets(`api_key=${"0".repeat(16)}`)).toBe(
      "api_key=[REDACTED]",
    );
    expect(redactSecrets(`"token": "${"0".repeat(16)}"`)).toBe(
      '"token": "[REDACTED]"',
    );
    expect(redactSecrets(`password: ${"h".repeat(4)}${"2".repeat(8)}`)).toBe(
      "password: [REDACTED]",
    );
    expect(redactSecrets(`client_secret=${"0".repeat(16)}`)).toBe(
      "client_secret=[REDACTED]",
    );
  });

  it("leaves ordinary text and short values alone", () => {
    const benign =
      "Tests: 42 passed, 0 failed\n" +
      "Build finished in 12s\n" +
      "token=abc\n" + // too short to look like a secret
      "see https://example.com/status for details\n" +
      "error ECONNREFUSED 127.0.0.1:8080";
    expect(redactSecrets(benign)).toBe(benign);
  });

  it("is idempotent (redacted output passes through unchanged)", () => {
    const once = redactSecrets(
      `Authorization: Bearer ${"super".repeat(5)}${"token"}`,
    );
    expect(redactSecrets(once)).toBe(once);
  });

  it("handles empty input", () => {
    expect(redactSecrets("")).toBe("");
  });
});
