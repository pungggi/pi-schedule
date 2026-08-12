# Publishing `pi-schedule` to npm

`pi-schedule` ships **raw TypeScript source** (pi loads `.ts` extensions at
runtime — no build step, no native binaries). Releases are **CI-driven**:
push a `v*.*.*` git tag and GitHub Actions publishes to npm with
[provenance](https://docs.npmjs.com/generating-provenance-statements) (SLSA).

Manual `npm publish` is intentionally blocked by the `prepublishOnly` guard in
`package.json` so every release goes through CI (guarantees version sync +
provenance + a clean test run).

```
git tag vX.Y.Z && git push origin vX.Y.Z
        │
        ▼
release.yml  ──►  npm ci → typecheck → test → version-sync check → npm publish --provenance
                                                                      │
                                                                      ▼
                                                            npmjs.com/package/pi-schedule
```

---

## 1. Prerequisites (one-time)

1. An **npm account** (`https://www.npmjs.com/signup`) with **2FA enabled**
   (required for modern publish).
2. **Repo must be public** for `--provenance` (npm sigstore requirement).
   ```bash
   gh repo edit pungggi/pi-schedule --visibility public --accept-visibility-change-consequences
   ```
   If you must keep it private, remove `--provenance` from `release.yml` and
   `publishConfig.provenance` from `package.json` (you lose the SLSA badge).

> The package is already on npm; releases use OIDC trusted publishing (§2 A) by
> default. The one-time first-publish bootstrap (manual, without provenance, to
> attach the Trusted Publisher) is a one-off already completed.

---

## 2. Auth for CI (pick ONE)

### Option A — Trusted Publishing / OIDC (preferred, no long-lived token)

No `NPM_TOKEN`. GitHub Actions proves identity via OIDC (`id-token: write` is
already in `release.yml`). Requires **npm ≥ 11.5.1** (the workflow upgrades
npm) and must **not** export an empty `NODE_AUTH_TOKEN` (that breaks OIDC).

1. Sign in at [npmjs.com](https://www.npmjs.com).
2. Open `https://www.npmjs.com/package/pi-schedule` → **Settings → Trusted
   Publisher** → Add GitHub Actions:
   - **Organization or user:** `pungggi`
   - **Repository:** `pi-schedule`
   - **Workflow filename:** `release.yml` (exact name, no path)
   - Environment: leave empty unless you use GitHub Environments
3. On GitHub, **delete** a bad/legacy token so it cannot override OIDC:
   ```bash
   gh secret delete NPM_TOKEN --repo pungggi/pi-schedule
   ```
4. Re-run the release job (see §4).

Docs: https://docs.npmjs.com/trusted-publishers

### Option B — Classic **Automation** token (fallback if OIDC ever breaks)

`EOTP` means the token still requires an authenticator code. CI cannot type OTP.

1. npmjs.com → avatar → **Access Tokens** → **Generate New Token**.
2. Choose **Classic token → Automation**
   - **Not** "Publish"
   - **Not** "Read-only"
   - Automation exists specifically to **bypass 2FA on publish** in CI.
3. Copy `npm_…` (shown once).
4. Set the GitHub secret (replaces any previous value):
   ```bash
   gh secret set NPM_TOKEN --repo pungggi/pi-schedule
   # paste token, Enter
   gh secret list --repo pungggi/pi-schedule
   ```
5. Re-run the release job (see §4).

> Granular tokens often still surface **EOTP** when account 2FA is
> "authorization and writes". If you see EOTP twice, stop using Granular for CI
> and switch to **Classic Automation** or Trusted Publishing.

---

## 3. Publish a release (each time)

Keep `package.json` version and the git tag in sync (`release.yml` enforces it).

```bash
npm version patch -m "release: %s"   # or minor / major
git push origin master --follow-tags
gh run watch
```

---

## 4. Re-run a failed tag release (do not retag)

```bash
gh run list --workflow=release.yml --limit 5
gh run rerun <run-id> --failed
gh run watch <run-id>
npm view pi-schedule version          # expect the new version when green
```

Do **not** delete/recreate a tag for a version that already landed on npm —
bump instead. Move a tag only if that version never published.

---

## 5. Verify a release

```bash
npm view pi-schedule
npm view pi-schedule version
npm view pi-schedule dist.tarball
```

On the npm page you should see a **Provenance** badge linking to the Actions run.

Install: `pi install npm:pi-schedule`

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| **`EOTP` / one-time password** | Token is not Automation (or Granular still requires OTP). Use **Classic → Automation**, or delete `NPM_TOKEN` and use **Trusted Publisher** OIDC. Then `gh run rerun … --failed`. |
| **`E422` — "Unsupported … repository visibility: private"** | `--provenance` requires a **public** repo. `gh repo edit pungggi/pi-schedule --visibility public --accept-visibility-change-consequences`. (Or drop `--provenance` + `publishConfig.provenance` if you must stay private.) |
| `ENEEDAUTH` / 403 | No token and no trusted publisher. Configure §2 A or B. |
| `version drift: tag != package.json` | `npm version <X> -m 'release: %s'` then push tags. |
| Provenance `ENOTSUPPORTED` | Needs GHA + `id-token: write` (already set) + public repo. |
| Token expired | Regenerate Automation token; `gh secret set NPM_TOKEN`. |
| Local emergency publish | `CI=1 npm publish --access public --provenance` after `npm login` (interactive OTP OK). Prefer CI. |

---

## 7. Why not only manual `npm publish`?

Manual publish skips the CI test gate, can desync tags, and needs laptop OTP.
Tag → `release.yml` keeps tests, version sync, and provenance. Keep
`prepublishOnly` blocking non-CI publishes.
