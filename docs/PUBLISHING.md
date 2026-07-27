# Publishing `pi-schedule` to npm

`pi-schedule` ships **raw TypeScript source** (pi loads `.ts` extensions at
runtime — no build step, no native binaries). Releases are **CI-driven**:
push a `v*.*.*` git tag and GitHub Actions publishes to npm with
[provenance](https://docs.npmjs.com/generating-provenance-statements) (SLSA).

Manual `npm publish` is intentionally blocked by the `prepublishOnly` guard in
`package.json` so every release goes through CI (guarantees version sync +
provenance + a clean test run).

```
git tag v0.3.0 && git push origin v0.3.0
        │
        ▼
release.yml  ──►  npm ci → typecheck → test → version-sync check → npm publish --provenance
                                                                      │
                                                                      ▼
                                                            npmjs.com/package/pi-schedule
```

---

## 1. Prerequisites (one-time)

1. An **npm account** (`https://www.npmjs.com/signup`).
2. **2FA enabled** on the account (required for modern publish).
3. Confirm the package name is free (or you own it):
   ```bash
   npm view pi-schedule version   # 404 = free / not yet published
   ```
4. **Repo must be public** for `--provenance` (npm sigstore requirement).
   ```bash
   gh repo edit pungggi/pi-schedule --visibility public --accept-visibility-change-consequences
   ```
   If you must keep it private, remove `--provenance` from `release.yml` and
   `publishConfig.provenance` from `package.json` (you lose the SLSA badge).

---

## 2. Auth for CI (pick ONE)

### Option A — Trusted Publishing / OIDC (preferred, no long-lived token)

No `NPM_TOKEN`. GitHub Actions proves identity via OIDC (`id-token: write` is
already in `release.yml`). Requires **npm ≥ 11.5.1** (workflow upgrades npm)
and must **not** export an empty `NODE_AUTH_TOKEN` (that breaks OIDC).

1. Sign in at [npmjs.com](https://www.npmjs.com).
2. Open `https://www.npmjs.com/package/pi-schedule` → **Settings → Trusted Publisher**
   → Add GitHub Actions:
   - **Organization or user:** `pungggi`
   - **Repository:** `pi-schedule`
   - **Workflow filename:** `release.yml` (exact name, no path)
   - Environment: leave empty unless you use GitHub Environments
3. On GitHub, **delete** a bad/legacy token so it cannot override OIDC:
   ```bash
   gh secret delete NPM_TOKEN --repo pungggi/pi-schedule
   ```
4. Re-run the release job (see §5).

Docs: https://docs.npmjs.com/trusted-publishers

### Option B — Classic **Automation** token (works for first publish)

`EOTP` means the token still requires an authenticator code. CI cannot type OTP.

1. npmjs.com → avatar → **Access Tokens** → **Generate New Token**.
2. Choose **Classic token → Automation**  
   - **Not** “Publish”  
   - **Not** “Read-only”  
   - Automation exists specifically to **bypass 2FA on publish** in CI.
3. Copy `npm_…` (shown once).
4. Set the GitHub secret (replaces any previous value):
   ```bash
   gh secret set NPM_TOKEN --repo pungggi/pi-schedule
   # paste token, Enter
   gh secret list --repo pungggi/pi-schedule
   ```
5. Re-run the release job (see §5).

> Granular tokens often still surface **EOTP** when account 2FA is
> “authorization and writes”. If you see EOTP twice, stop using Granular for CI
> and switch to **Classic Automation** or Trusted Publishing.

---

## 3. Why `v0.3.0` failed (attempt 1 and 2)

```text
npm error code EOTP
npm error This operation requires a one-time password from your authenticator.
```

| What worked | What failed |
|-------------|-------------|
| checkout, npm ci, typecheck, test | `npm publish` package write |
| version tag sync | — |
| provenance / sigstore signing | auth for the tarball upload |

So the workflow and package are fine. **`NPM_TOKEN` is not an Automation-class
credential** (or Trusted Publisher is not configured and a non-Automation token
is still set).

Re-running the job **without** replacing the secret will fail the same way.

---

## 4. Publish a release (each time)

Keep `package.json` version and the git tag in sync (`release.yml` enforces it).

**First release (tag already exists as `v0.3.0`):** fix auth (§2), then §5 re-run.

**Later releases:**
```bash
npm version patch -m "release: %s"   # or minor / major
git push origin master --follow-tags
gh run watch
```

---

## 5. Re-run a failed tag release (do not retag)

```bash
gh run list --workflow=release.yml --limit 5
gh run rerun <run-id> --failed
gh run watch <run-id>
npm view pi-schedule version          # expect 0.3.0 when green
```

Do **not** delete/recreate `v0.3.0` unless you must move the tag (discouraged).

---

## 6. Verify a release

```bash
npm view pi-schedule
npm view pi-schedule version
npm view pi-schedule dist.tarball
```

On the npm page you should see a **Provenance** badge linking to the Actions run.

Install: `pi install npm:pi-schedule`

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| **`EOTP` / one-time password** | Token is not Automation (or Granular still requires OTP). Use **Classic → Automation**, or delete `NPM_TOKEN` and use **Trusted Publisher** OIDC. Then `gh run rerun … --failed`. |
| **`E422` — "Unsupported … repository visibility: private"** | `--provenance` requires a **public** repo. `gh repo edit pungggi/pi-schedule --visibility public --accept-visibility-change-consequences`. (Or drop `--provenance` + `publishConfig.provenance` if you must stay private.) |
| `ENEEDAUTH` / 403 | No token and no trusted publisher. Configure §2 A or B. |
| `version drift: tag != package.json` | `npm version <X> -m 'release: %s'` then push tags. |
| Provenance `ENOTSUPPORTED` | Needs GHA + `id-token: write` (already set) + public repo. |
| Name taken by someone else | Rename to scoped `@pungitore/pi-schedule`. |
| Token expired | Regenerate Automation token; `gh secret set NPM_TOKEN`. |
| Local emergency publish | `CI=1 npm publish --access public --provenance` after `npm login` (interactive OTP OK). Prefer CI. |

---

## 8. Why not only manual `npm publish`?

Manual publish skips the CI test gate, can desync tags, and needs laptop OTP.
Tag → `release.yml` keeps tests, version sync, and provenance. Keep
`prepublishOnly` blocking non-CI publishes.
