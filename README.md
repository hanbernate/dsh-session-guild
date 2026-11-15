# dsh-session-guild

English | [中文](README.zh-CN.md)

Publish a quest from a DeepSeek Harness session to a fresh ordinary session —
in another workspace, or beside the current one when this session is already
long — keep it on a quest list, and receive the summary as a background-job
result when the work is done. No user message is inserted into the client
session.

## Standard subagent vs. a contractor sub-session

A standard subagent needs the main session to finish the design and plan first;
the subagent mostly executes, humans rarely intervene, and the main session has
to carry all of that context. The Guild inverts that split:

| | Standard subagent | Contractor sub-session |
|---|---|---|
| Main session | completes the design and plan | fixes only the goal and requirements |
| Where the design is refined | main session | contractor session |
| Human involvement | rare once delegation starts | can step in directly in the contractor session |
| Main-session context | large | relatively small |

Like an adventurers' guild: you publish a quest, the plugin opens a normal
session in the target workspace; the contractor owns the execution plan and
decides how to proceed, and the result is reported back to the client session.

- Requires **DSH ≥ 0.1.5-rc.1**
- No npm dependencies; requires the DSH `permission-presets` plugin (`ctx.permissionPresets`)
- Reports travel through the DSH background-job plugins (`@deepseek-ai/dsh-jobs` + `@deepseek-ai/dsh-tool-jobs`);
  without them the plugin falls back to message delivery
- No new commands or UI to learn; the assistant uses the plugin on your behalf
- Every registered workspace can host a quest by default

Two sides of one relationship: the **client** session posts the quest; the
**contractor** session in the target workspace executes it.


## How it works after installation

```
Your session (client)                     Target workspace (contractor)
─────────────────────                     ────────────────────────────
You describe the quest
  │
  ├─ a normal session is opened there ──▶ appears in that workspace's sidebar
  │  (read-only by default)                owns its own execution plan
  │
  │                                        you switch on write access there
  │                                        the contractor does the work
  │
  ◀──────── summary settles a job ───────── contractor reports when done
  │
  the quest is marked completed
  you continue with the result
```

1. Ask your assistant to publish the quest in another workspace. Name the
   repo, plugin, service, or path; if the target is ambiguous, it lists the
   registered workspaces first.
2. A fresh **ordinary session** is created in that workspace and titled
   `🏰 <label> (from <source workspace>)`. It is not a hidden sub-agent: you can open
   it, talk to it, and change its permission at any time.
3. The contractor starts **read-only by default**. How it plans and executes is
   its concern; when it needs write access, it asks, and you grant it in that
   session.
4. When the work is done, the report settles a background job on your session:
   `job_output` returns the summary, or `guild_collect` reads it later. No user
   message is inserted, and you keep working in the original session.
   The quest is complete; you keep working in your original session.

Several quests can be in flight at once. Each workspace has its own files
and state; contractors are independent of each other.

## Quest status is not session status

A quest stays **in progress** until the contractor reports back. The
contractor being idle, waiting for permission, interrupted, or archived does
**not** complete it. Only the contractor's report does.

Nothing resumes automatically after a DSH restart. When you want to continue,
ask your assistant to resume the open quests; archived contractors are
restored from the archive rather than recreated.

## Configuration

Config lives in the profile patch for the plugin row:

```yaml
- id: session-guild
  config:
    defaultPermissionPreset: read-only   # default; null inherits the caller permission
    maxTaskChars: 20000
    summaryChars: 4000
    requireApproval: false               # true shows a confirmation card
    approveAppend: false                   # true confirms every follow-up
```

| Key | Default | What it controls |
|---|---|---|
| `defaultPermissionPreset` | `read-only` | Initial permission of the contractor session. `null` inherits the caller's current permission. |
| `maxTaskChars` | `20000` | Maximum length of the requirement text. |
| `summaryChars` | `4000` | Maximum length of the summary sent back. |
| `requireApproval` | `false` | Whether to show a confirmation card before opening the contractor session. |
| `approveAppend` | `false` | Whether to confirm every follow-up message sent to a contractor. |

The permission is written once, when the contractor is created. After that, the
contractor session's permission is yours to change.

## Limitations

Read these before relying on the plugin in production.

- **A report is a background job result, not a message.** Publishing registers
  a `guild-quest` job owned by your session and returns immediately, so your
  session stays idle while the contractor works. When the contractor reports,
  the job settles: `job_output` returns the summary, `guild_collect` can read
  it later, and no user message is admitted. The job must belong to a live
  session, counts against that session's background-job limit, and keeps the
  session from being archived until it settles. Hosts without the `jobs`
  service fall back to the old message delivery (configure `reportDelivery`).
- **A quest completes only when the contractor reports.** If the
  contractor finishes but does not report, the quest stays in progress;
  neither idleness nor archiving changes it.
- **No automatic resume.** After a restart, nothing is woken or replayed. You
  must ask for the open quests to be continued.
- **A follow-up does not reopen a completed quest.** You can wake a
  contractor to ask for corrections, but the quest remains completed and
  the same quest cannot submit a second report. Create a new quest if
  you need a new tracked result.
- **Contractors start read-only.** You must grant write access in the
  contractor session, or set `defaultPermissionPreset` to a writable preset.
  The plugin never bypasses the sandbox or approval policy.
- **Quests start without a confirmation card by default.** Any registered
  workspace can be a target. Set `requireApproval: true` if that is too
  permissive for your deployment.
- **Cross-session quest publishing needs host services.** `permissionPresets` is
  a hard dependency; without the DSH `permission-presets` plugin the Guild does
  not mount. `sessionController` and `workspaceRegistry` are also required for
  quest tools; a headless or minimal deployment lacking them may only provide
  workspace discovery.
- **The current workspace is a valid target.** A quest published there opens a
  sub-session beside this one, which is how a long task leaves the main
  session's context. That sub-session shares the same checkout and the plugin
  does not detect concurrent edits to the same files; keep the two off each
  other's work.
- **Older DSH versions degrade.** On 0.2.1 and earlier there is no live
  `running` state, so the quest list cannot show that a contractor is
  executing. On 0.2.1 and earlier the assistant always sees the quest
  actions, even in sessions where they do not apply (a small context cost). On
  0.1.5 an archived contractor can be woken but not un-archived, and archiving a
  client does not cascade.
- **0.1.2-rc.1 itself is unusable for publishing quests.** That release fails to
  mount the `standard` preset when creating a session; this is a host bug, not a
  plugin bug. Use 0.1.5-rc.1 or newer.
- **Size caps apply.** Requirements are capped by `maxTaskChars`; summaries by
  `summaryChars`. A summary over the cap is truncated.

See [docs/limitations.md](docs/limitations.md) for the version-by-version
details.

## Compatibility

| DSH range | What works |
|---|---|
| 0.2.2-rc.1+ | Full: quest actions appear only where they apply, live contractor status, archive restore, archive cascade |
| 0.1.7-rc.1 – 0.2.1 | Full quest lifecycle; no live contractor status, quest actions always listed, `workingDirectory` only from 0.2.1 |
| 0.1.2-rc.1 – 0.1.5 | Questing and reporting work from 0.1.5-rc.1; resume wakes an archived contractor in place but cannot un-archive it; no cascade. 0.1.2-rc.1 cannot create sessions (host bug). |
| < 0.1.2 | Workspace discovery only; the plugin warns instead of pretending to quest |

The plugin chooses its compatibility adapter by probing live services, not by
reading a version string. See [docs/compatibility.md](docs/compatibility.md) and
the measured [COMPATIBILITY.md](COMPATIBILITY.md) matrix.

## Installation

Link the `0.0.x` directory into a profile, or add it with Plugin Manager:

```bash
dsh plugin --profile <name> add /path/to/dsh-session-guild/0.0.x
```

Enable it for the profile. The workspace registry and session services are
provided by the Harness; no separate configuration is required.

## Development

```bash
node --test
node .script/smoke.mjs
npm run check
```

The code is split so each tool can be reviewed on its own:

- `index.js` — entry point, host facade, and runtime assembly
- `lib/register.js` — tool set, registration lifecycle, adapter mount, event subscriptions
- `lib/tools/` — one file per tool
- `lib/compat.js` — host-generation adapters

## Documentation

All files under `docs/` are written in Chinese; this English README is the
default package entry.

- [docs/tools.md](docs/tools.md) — tool reference and visibility rules
- [docs/lifecycle.md](docs/lifecycle.md) — quest/session lifecycle, archive, resume
- [docs/architecture.md](docs/architecture.md) — purpose of every code file and the state model
- [docs/compatibility.md](docs/compatibility.md) — adapter matrix and degraded behavior
- [docs/limitations.md](docs/limitations.md) — detailed limitations

