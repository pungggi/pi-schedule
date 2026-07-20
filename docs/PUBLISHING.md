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
2. **Two-factor auth (2FA) enabled** on the account — required for provenance
   and enforced for publish. Account → Settings → 2FA → enable for
   *authentication and publish*.
3. Confirm the package name is still free (it was at the time of writing):
   ```bash
   npm view pi-schedule version   # 404 = free; a version = taken (pick a new name)
   ```
   `pi-schedule` is **unscoped**, so the first publish claims the name
   permanently. Claim it before someone else does.

---

## 2. Create the npm access token (one-time)

We publish from CI, so we need a token — **not** an interactive login. Use a
**Granular Access Token** (npm's recommended, scoped, expiring type):

1. Sign in at `https://www.npmjs.com` → click your avatar → **Access Tokens**.
2. **Generate New Token → Granular Access Token**.
3. Configure:
   - **Name:** `pi-schedule CI publish` (your label)
   - **Expiration:** 365 days (or your org policy)
   - **Packages and scopes → Select packages:** after first publish add
     `pi-schedule`; for the **very first** publish choose *Only select packages
     and scopes* and grant **Read and write** — npm lets a granular token
     publish a not-yet-existing package if it has write permission.
     - If it won't let you pre-select a name that doesn't exist yet, temporarily
       use a **Classic → Automation** token (account-wide, 2FA-bypassing) for
       the first release, then switch to a scoped Granular token.
   - **Organizations:** *No access* (we don't need it).
4. **Generate** → copy the token (`npm_…`). It is shown **once**.

> The token needs **publish** permission and must bypass 2FA in CI. Granular
> tokens with *Read and write* on the package satisfy this; a Classic
> **Automation** token also does (it exists precisely for CI).

---

## 3. Add the token to GitHub as `NPM_TOKEN` (one-time)

The release workflow reads `${{ secrets.NPM_TOKEN }}`. Add it via **either** path:

**Option A — web UI**
`https://github.com/pungggi/pi-schedule` → Settings → Secrets and variables →
Actions → **New repository secret** → Name `NPM_TOKEN`, paste the token →
Add secret.

**Option B — `gh` CLI (fastest, no clicking)**
```bash
gh auth login                       # if not already authenticated to GitHub
gh secret set NPM_TOKEN --repo pungggi/pi-schedule
# pastes from stdin / prompts securely
gh secret list --repo pungggi/pi-schedule   # confirm NPM_TOKEN is present
```

`gh` never prints the value back, and the web UI masks it too.

---

## 4. Publish a release (each time)

The package version lives in `package.json`. Keep it and the git tag in sync —
`release.yml` enforces this (the job fails on drift).

**First release (`v0.3.0` is already the current version):**
```bash
git tag v0.3.0
git push origin v0.3.0
```

**Subsequent releases:**
```bash
npm version patch -m "release: %s"      # bumps package.json + creates the tag
git push origin master --follow-tags
```
Use `patch` (0.3.0→0.3.1), `minor` (→0.4.0), or `major` (→1.0.0) per semver.

Then watch it land:
```bash
gh run watch                           # live tail of the release.yml job
npm view pi-schedule version           # once green: prints 0.3.0
```
Install anywhere: `pi install npm:pi-schedule`.

---

## 5. Verify a release

```bash
npm view pi-schedule                    # full metadata (provenance link present)
npm view pi-schedule version            # the published version
npm view pi-schedule dist.tarball       # the published tarball URL
```
On the npm page (`https://www.npmjs.com/package/pi-schedule`) you should see a
**"Provenance"** badge linking back to the GitHub workflow run that produced it.

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `release.yml` fails at `Publish` with 403 / `npm error ENEEDAUTH` | `NPM_TOKEN` missing, wrong, or expired. Regenerate + `gh secret set NPM_TOKEN`. |
| **`npm error EOTP` / "requires a one-time password"** | Wrong token type for CI. Account has 2FA on *publish*, but the token cannot bypass OTP. Use a **Classic → Automation** token (or a Granular token with publish + 2FA bypass). Replace `NPM_TOKEN`, then re-run the failed release job. See [§2b](#2b-eotp--the-token-must-bypass-2fa). |
| `403 Forbidden — You must sign the npm CLA` or similar on first publish | Accept the npm CLA / verify the account email at npmjs.com first. |
| `version drift: tag != package.json` | Run `npm version <X> -m 'release: %s'` (bumps **and** tags) instead of hand-editing. |
| Provenance step fails with `ENOTSUPPORTED` | Publish must come from GitHub Actions with `id-token: write` (already set in `release.yml`). Provenance needs a public repo + the `repository` field (present). |
| Name is taken (`npm view` returns a version that isn't ours) | Pick a scoped name, e.g. `@pungitore/pi-schedule`, update `package.json` `name` + `release.yml` references. |
| Token expired after 365 days | Regenerate (step 2) and update the secret (step 3). Set a calendar reminder. |
| Want to publish **now** and CI is misbehaving | Temporarily lift the guard: `CI=1 npm publish --access public --provenance` from a local terminal *after* `npm login` (browser flow). Re-add the guard before the next release. |

### 2b. EOTP — the token must bypass 2FA

`v0.3.0` hit this in CI:

```text
npm error code EOTP
npm error This operation requires a one-time password from your authenticator.
```

Provenance/OIDC can succeed while the package write still fails: the **token**
is the problem, not the workflow.

**Fix (recommended for CI):**

1. npmjs.com → avatar → **Access Tokens** → **Generate New Token**
2. Prefer **Classic → Automation**
   - Automation tokens are made for CI: they **bypass 2FA on publish**
   - Do **not** use Classic *Publish* or *Read-only* for GitHub Actions
3. Or **Granular** with:
   - Packages: `pi-schedule` (or "all packages" until first claim)
   - Permissions: **Read and write**
   - Ensure the token is allowed to publish without interactive OTP
     (if npm still prompts OTP in CI, fall back to Classic Automation)
4. Replace the GitHub secret:
   ```bash
   gh secret set NPM_TOKEN --repo pungggi/pi-schedule
   # paste the new token
   ```
5. Re-run the failed release (tag already exists — do **not** retag):
   ```bash
   gh run rerun 29745047954 --failed
   # or: gh run list --workflow=release.yml --limit 3
   #     gh run rerun <id> --failed
   ```

After a green run: `npm view pi-schedule version` → `0.3.0`.

---

## 7. Why not `npm login` + manual publish locally?

It works, but every manual publish:
- skips the CI test gate (a red suite could still ship),
- can publish a version whose `package.json` doesn't match a git tag,
- needs your laptop's 2FA/OTP interactively.

The CI flow (tag → `release.yml`) removes all of those foot-guns and adds
cryptographic provenance for free. That's why the `prepublishOnly` guard
throws unless `CI=true`. Keep releases on the tag path.
