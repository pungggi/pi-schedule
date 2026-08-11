# Spike: per-job model selection (via `ctx.scopedModels`)

Status: **design spike / upstream-blocked.** Not implemented. This note captures
the opportunity opened by pi 0.83.0, the hard blocker, and a proposed design so
we (or an upstream contributor) can pick it up.

## Goal

Let a scheduled job declare which model runs its agent turn, independent of the
session's active model. Examples:

- run a cheap/fast model for a daily dependency-version check (`npm outdated`)
- run a strong model only for a weekly deep security review
- run a vision-capable model for a job that inspects screenshots

Today every `prompt`-kind job fires into whatever model the session is currently
on. The user has to remember to `/model` first, or split reviews across
sessions. A per-job `model` field would make schedules self-describing.

## What pi 0.83.0 gave us

`ctx.scopedModels` (added in [pi#7191](https://github.com/earendil-works/pi/pull/7191),
[#7215](https://github.com/earendil-works/pi/pull/7215)) exposes the session's
resolved model scope to extensions:

```ts
// @earendil-works/pi-coding-agent
interface ScopedModel {
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel; // e.g. "high" if pattern was "model:high"
}

interface ExtensionContext {
  /** Models scoped to this session (resolved from --models / enabledModels
   *  against the catalogue). Empty when no scoping is configured. Read-only. */
  scopedModels: readonly ScopedModel[];
}
```

This is **observability**: it tells an extension which models are *available*
in this session. It is the natural validation source for a per-job `model`
field (reject a job whose model isn't in the scope, just like a bad schedule
string is rejected today).

## The blocker

`ctx.scopedModels` is read-only; it does not let an extension *force a turn onto
a specific model*. And the delivery API has no model parameter:

```ts
ExtensionAPI.sendUserMessage(
  content: string | (TextContent | ImageContent)[],
  options?: { deliverAs?: "steer" | "followUp" },
): Promise<void>;
```

There is no `model` option, no `before_agent_start` result field that switches
the model for the upcoming turn, and no documented way to temporarily override
the session model from an extension. So even with the job's intended model
known and validated against `ctx.scopedModels`, the runner has no API to actually
run the scheduled turn on it.

**Conclusion:** per-job model selection is **upstream-blocked** on pi exposing a
model-scoped turn. Everything else (schema, validation, persistence, docs) we
can do today; the delivery step is the missing piece.

## Proposed design (once pi unblocks it)

### 1. Schema (`types.ts` + `tool.ts`)

Add an optional `model` to `ScheduledJob`:

```ts
interface ScheduledJob {
  // …existing fields…
  /** Optional model id (bare or provider/modelId) the scheduled turn should run
   *  on. Validated against ctx.scopedModels at create time. */
  model?: string;
}
```

`schedule` tool gains `model?: string` on `create`. `schedule.ts`-style parsing
reused: accept bare id or canonical `provider/modelId`, reject ambiguity.

### 2. Validation at create time (`store.ts` / a new validator)

Create needs `ctx`, which the tool's `execute(toolCallId, params, sig, upd, ctx)`
already receives. Validate `params.model` against `ctx.scopedModels`:

- empty scope (no `enabledModels`) → allow any (can't validate; warn at fire)
- non-empty scope → require an exact match, else `ScheduleParseError` mirroring
  the existing bad-schedule-string UX

This mirrors how `every`/`dailyAt`/`once` are validated today: parse-time
rejection, not silent acceptance.

### 3. Delivery (`runner.ts`)

`deliver()` for `prompt`-kind jobs currently calls:

```ts
this.opts.pi.sendUserMessage(body, { deliverAs: … });
```

Becomes (pseudocode — depends on the upstream API shape):

```ts
this.opts.pi.sendUserMessage(body, {
  deliverAs: …,
  model: fresh.model,            // ← the new bit
});
```

If pi instead exposes this through a `before_agent_start` result field
(`{ switchModel?: string }`), the runner would set a one-shot pending-model flag
on enter and clear it in `agent_settled`, parallel to how `PrivilegeGuard` stacks
tiers today.

### 4. Reliability implications (`docs/RELIABILITY.md`)

- **Scope drift:** a job created when model X was scoped can outlive that scope
  (`enabledModels` changes, model deprecated). Fire-time behavior: if the stored
  model is no longer in `ctx.scopedModels`, fall back to the session model and
  record `model:fallback` in the ledger `detail` (visible via `history`). Do not
  silently skip.
- **Cost:** a per-job strong model can be expensive on a frequent schedule.
  Surface model in `schedule action=list` output and in the create confirmation
  so cost is obvious. Consider a soft warning when `tier=mutate` + expensive
  model + short interval.
- **Ledger:** add `model` to the `runs.jsonl` row so `history` shows which model
  actually ran each delivery.

### 5. Skill + README

`skills/schedule/SKILL.md` gains a "per-job model" subsection (when to pin a
cheap vs strong model). README examples add one pinned-model job.

## Open questions

1. **Upstream API shape** — `sendUserMessage({ model })` option, or a
   `before_agent_start` result field, or a dedicated `pi.runScopedTurn(...)`?
   The cleanest for pi-schedule is an option on `sendUserMessage`, since that's
   already the delivery primitive.
2. **Thinking level** — should the job field accept `model:thinkingLevel`
   syntax (like `--models`)? Probably yes, for parity. Reuse pi's
   `parseModelPattern`.
3. **Shell/notify/message jobs** — `model` is meaningless for non-agent kinds
   (shell runs via `pi.exec`, notify/message never start a turn). Reject `model`
   on those at create time, or accept-and-ignore? Prefer **reject** for clarity.
4. **Scope-empty semantics** — when no `enabledModels` is configured, every
   model is usable. Should `model` then be unconstrained, or still matched
   against the full catalogue? Lean unconstrained + fire-time fallback.

## Draft upstream issue for pi

> **Title:** Extension API: run a user-message turn on a specific model
>
> **Context.** Extensions like `pi-schedule` inject scheduled prompts via
> `pi.sendUserMessage(body, { deliverAs })`. Pi 0.83.0 exposed
> `ctx.scopedModels`, which lets an extension know which models are available —
> but there is no way to direct a *specific* injected turn onto a chosen model.
> The turn always runs on the session's active model. This blocks per-job model
> selection (e.g. "run this daily review on a cheap model, this weekly one on a
> strong model").
>
> **Proposal.** Add an optional `model` to `sendUserMessage`:
>
> ```ts
> sendUserMessage(content, options?: {
>   deliverAs?: "steer" | "followUp";
>   model?: string; // bare id or provider/modelId, resolved against scopedModels
> }): Promise<void>;
> ```
>
> The option scopes only the resulting turn; it does not change the session's
> sticky `/model` selection. Resolution rules match `--models` (bare id, alias
> preference, optional `:thinkingLevel`). If the model is not in the session
> scope, reject with a clear error so the extension can fall back.
>
> **Alternatives considered.** A `before_agent_start` result field
> (`{ switchModel?: string }`); a dedicated `pi.runScopedTurn(...)`. The
> `sendUserMessage` option is preferred because it is already the delivery
> primitive extensions use and needs no new lifecycle-coupled state.

## What we can do now (without waiting on pi)

Nothing user-facing — the delivery step is the whole feature. But we can:

- keep this note current as pi's extension API evolves,
- revisit at each pi release (the `ExtensionAPI.sendUserMessage` signature is
  the signal to watch),
- and, if we want to upstream it ourselves, open the issue above against
  `earendil-works/pi`.
