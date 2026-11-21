# dsh-session-guild

English | [中文](README.zh-CN.md)

Publish a quest from a DeepSeek Harness session to a fresh ordinary session:
it works out the detailed plan itself, does the work in its own context, and —
once the user in that session has confirmed the result — reports a summary back
as a background-job result, so the delegating session keeps only the goal and
the result. No user message is inserted into the client session.

> **Status: public beta (0.0.2).** Published on npm under the `beta` tag;
> install with `dsh-session-guild@beta`. The tool contract may still change
> between beta releases.

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
session; the contractor owns the execution plan and decides how to proceed,
shows the result to the user in that session, and reports it back to the client
session once the user confirms.

A quest is human-in-the-loop by default (`mode: "review"`): the plugin appends
that rule to the delivered requirement, so the contractor does not report in the
same turn it finishes. For unattended work that needs no human involvement, use
a standard subagent; use `mode: "unattended"` only when the user explicitly asked
for an unattended run and the work must happen in another workspace, where a
subagent cannot go.

## Two scenarios

### 1. The work belongs to another workspace

The repo, plugin, service, or path the user names lives in another workspace.
Publish the quest there and let that workspace's own session read, run, and
edit; this session never reaches across, and receives only the summary.

### 2. This session does not need the details

The task stays in this workspace, but the session is already long, or you would
rather not follow the design and execution here. The quest opens a sub-session
beside this one in the same workspace: the plan, the file reads, and the edits
stay there, and only the goal and the summary stay here.

## Requirements

- Requires **DSH ≥ 0.1.5-rc.1**; this package **0.0.2** adds per-quest model selection, follow-up rounds, byte-budgeted quest titles, and the `mode` reporting rule (`review` / `unattended`)
- No npm dependencies; requires the DSH `permission-presets` plugin (`ctx.permissionPresets`)
- Reports travel through the DSH background-job plugins (`@deepseek-ai/dsh-jobs` + `@deepseek-ai/dsh-tool-jobs`);
  without them the plugin falls back to message delivery
- No new commands or UI to learn; the assistant uses the plugin on your behalf
- Every registered workspace can host a quest by default
- Quests are `mode: "review"` (human-in-the-loop) by default: the contractor
  shows the result and waits for your confirmation before reporting;
  `mode: "unattended"` reports as soon as the work is done

Two sides of one relationship: the **client** session posts the quest; the
**contractor** sub-session executes it.


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
  │                                        the result is shown to you there
  ◀──────── summary settles a job ───────── you confirm, then it reports
  │
  the quest is marked completed
  you continue with the result
```

1. Ask your assistant to publish the quest. Name the repo, plugin, service, or
   path; if the target is ambiguous, it lists the registered workspaces first.
2. A fresh **ordinary session** is created in that workspace and titled
   `📜 <title> (from <source workspace>)`, where the title is the publishing
   model's `title` argument. It is not a hidden sub-agent: you can open it, talk
   to it, and change its permission at any time.
3. The contractor starts **read-only by default**. How it plans and executes is
   its concern; when it needs write access, it asks, and you grant it in that
   session.
4. When the work is done the contractor shows the result in its own session and
   waits for your confirmation. Once you confirm, the report settles a
   background job on your session: `job_output` returns the summary, or
   `guild_collect` reads it later. No user message is inserted, and you keep
   working in the original session. Until then the quest stays `in_progress` —
   that is a normal state, not a failure.
   The quest is complete; you keep working in your original session.

Several quests can be in flight at once. Each workspace has its own files
and state; contractors are independent of each other.

## Choosing the model, and follow-up rounds

Since 0.0.2 a quest can name the model the contractor must use:

- `guild_publish_quest` takes optional `provider`, `model`, and `reasoning_effort`.
  The contractor's first model step uses that route, and the **deployment default
  model is not changed** (the plugin selects at Agent level, not through the
  call that saves a new default).
- An unavailable route fails the publish before the requirement is delivered,
  and the error carries the session id — a quest never runs on the wrong model.
- Only a host without Agent-level selection falls back to
  `sessionController.selectModel`, whose deployment-default side effect is
  stated in the returned `notes`; a host with neither capability refuses a
  publish that names a model.

`guild_append` is how you ask for more:

- While the quest is `in_progress`, the follow-up is only delivered (steering):
  no new job, and the round does not change.
- When it is `completed`, the append opens round N+1: a new report job is
  registered first, the quest is reopened, and only then is the message
  delivered. The next `guild_report` sends that round's summary to the new
  job, so `job_output` returns the new answer.
- An archived contractor refuses the append with the executable path: resume it
  first with `guild_resume` naming the quest's `questIds` (a `completed` quest
  is restored that way too — restore and wake only, no status change), then
  append again.
- One report per round; `cancelled`/`failed` quests cannot be appended.

The motivating use: a main session delegates a code review to a read-only
sub-session running the main session's model, then appends follow-ups to the
same sub-session and collects each round's report.

## Quest status is not session status

A quest stays **in progress** until the contractor reports back. The
contractor being idle, waiting for the user's confirmation, waiting for
permission, interrupted, or archived does **not** complete it. Only the
contractor's report does.

Nothing resumes automatically after a DSH restart. When you want to continue,
ask your assistant to resume the open quests; archived contractors are
restored from the archive rather than recreated. The archived contractor of a
`completed` quest can be restored the same way when you name its quest id —
the restore only prepares the next `guild_append` and never reopens the round.

## Configuration

Config lives in the profile patch for the plugin row:

```yaml
- id: session-guild
  config:
    defaultPermissionPreset: read-only   # default; null inherits the caller permission
    titleMaxBytes: 80                    # byte budget for the contractor session title
    requireApproval: false               # true shows a confirmation card
    approveAppend: false                   # true confirms every follow-up
```

| Key | Default | What it controls |
|---|---|---|
| `defaultPermissionPreset` | `read-only` | Initial permission of the contractor session. `null` inherits the caller's current permission. |
| `titleMaxBytes` | `80` | UTF-8 byte budget for the contractor session title. The `(from …)` attribution gives way first; the title itself is cut only after it is gone. Keep it equal to or below the deployment's `session-title` `maxTitleBytes`. |
| `requireApproval` | `false` | Whether to show a confirmation card before opening the contractor session. |
| `approveAppend` | `false` | Whether to confirm every follow-up message sent to a contractor. |

Quest text and report summaries have no plugin-side length limit: the model
decides how long they need to be. The host's own tool-output policy still bounds
what a single tool result shows to the model.

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
  Reloading the plugin's code (HMR) does not break settlement: the settlement
  handle outlives plugin instances. If you ever see a `completed` quest whose
  job is still `running` (a zombie from before that fix, or a replaced jobs
  service), `guild_collect`'s `note` names the job and `job_kill` frees the
  slot — it cannot alter the completed quest record.
- **A quest completes only when the contractor reports.** If the
  contractor finishes but does not report, the quest stays in progress;
  neither idleness nor archiving changes it.
- **No automatic resume.** After a restart, nothing is woken or replayed. You
  must ask for the open quests to be continued.
- **One report per round; a follow-up opens the next round.** While a quest is
  in progress an append only steers. After a report, an append reopens the
  quest for round N+1 with a fresh report job, so the contractor can report
  once more; a repeated report for the same round is refused. A cancelled or
  failed quest cannot be appended — publish a new quest instead. The default
  `mode: "review"` makes the contractor show the result in its own session and
  wait for the user's confirmation before reporting; `unattended` is the only
  mode that reports as soon as the work is done.
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
- **Model selection degrades by host capability (0.0.2).** Agent-level
  selection leaves the deployment default alone; only the
  `sessionController.selectModel` fallback rewrites it (the notes say so). A
  host with no model directory cannot pre-check a route and says so in the
  notes; a host with no selection capability at all refuses a publish that
  names a model instead of silently running the default.
- **Older DSH versions degrade.** On 0.2.1 and earlier there is no live
  `running` state, so the quest list cannot show that a contractor is
  executing. On 0.2.1 and earlier the assistant always sees the quest
  actions, even in sessions where they do not apply (a small context cost). On
  0.1.5 an archived contractor can be woken but not un-archived, and archiving a
  client does not cascade.
- **0.1.2-rc.1 itself is unusable for publishing quests.** That release fails to
  mount the `standard` preset when creating a session; this is a host bug, not a
  plugin bug. Use 0.1.5-rc.1 or newer.
- **No plugin-side length caps.** Quest text and report summaries are as long as
  the model makes them; the host's own tool-output policy still bounds what a
  single tool result shows to the model.

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

Install the public beta from npm, or link the `0.0.x` directory for development:

```bash
dsh plugin --profile <name> add dsh-session-guild@beta
# or, from a checkout:
dsh plugin --profile <name> add /path/to/dsh-session-guild/0.0.x
```

Enable it for the profile. The workspace registry and session services are
provided by the Harness; no separate configuration is required.

`0.0.2` is the first public beta and `0.0.1` was never published. Existing
installations keep working without the new arguments; a client that passes
`provider`/`model`, relies on follow-up rounds, uses the `review` reporting
mode, or expects the byte-budgeted quest title needs `0.0.2` or newer. See the
[compatibility notes](COMPATIBILITY.md) for the exact version boundary.

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
- `lib/quest-mode.js` — `review` / `unattended` reporting mode and the texts injected into publish, append, and resume

## Releasing

Pushing a `v*` tag publishes the package through GitHub Actions
([.github/workflows/publish.yml](.github/workflows/publish.yml)):

1. Bump `version` in `package.json` and commit it.
2. Create and push the matching tag:
   `git tag -a v0.0.2 -m "dsh-session-guild 0.0.2" && git push origin v0.0.2`.
3. CI checks the tag against `package.json`, runs the tests, then publishes.

The npm dist-tag defaults to `beta`, so a tagged beta cannot replace `latest`.
Set the repository variable `NPM_DIST_TAG=latest` before a stable release.
Exception: npm's staged publishing for a brand-new package promotes the first
reviewed version to `latest` as well, so the very first release may appear on
both tags.
Publishing needs an `NPM_TOKEN` repository secret: a granular access token with
read/write access to this package and 2FA bypass enabled (or an Automation
token). The workflow also generates npm provenance, so the published version
links back to this repository and commit.

## Documentation

All files under `docs/` are written in Chinese; this English README is the
default package entry.

- [docs/tools.md](docs/tools.md) — tool reference and visibility rules
- [docs/lifecycle.md](docs/lifecycle.md) — quest/session lifecycle, archive, resume
- [docs/architecture.md](docs/architecture.md) — purpose of every code file and the state model
- [docs/compatibility.md](docs/compatibility.md) — adapter matrix and degraded behavior
- [docs/limitations.md](docs/limitations.md) — detailed limitations

