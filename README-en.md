# dsh-model-fallback

简体中文 | [English](README-en.md)

This plugin gives every primary model in DeepSeek Harness an **ordered candidate list**: when a request fails and the error class matches a trigger you checked, the next model on the chain takes over that request. The turn survives, and the session records why it moved.

The usual case: you have hooked up a few free quota channels, or several small-quota, capped channels, and on long runs the model keeps hitting a wall and killing the task. model-fallback takes care of that to a degree.

Beyond that, a lot of time also went into the interface and the feel of it. If anything about the look or the handling does not sit right, issues are welcome.

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dependencies](https://img.shields.io/badge/dependencies-zero-blue.svg)](#build)
[![build step](https://img.shields.io/badge/build%20step-none-lightgrey.svg)](#build)
[![dsh](https://img.shields.io/badge/dsh-0.2.0--rc.2-green.svg)](https://github.com/yn2aa/dsh-model-fallback)
[![status](https://img.shields.io/badge/status-beta-orange.svg)](#status)

- **Visual editing**: Settings → Model Fallback Chains. Multiple chains live in one roster, drag to reorder, sort candidates by billing multiplier or context window.
- **Triggers** (each independently switchable): rate limit (TPM/RPM), quota exhaustion, HTTP 5xx, timeout and network errors.
- **Safe by default**: with no chains the plugin does not intervene — no interception, no failover, no annotations. One file turns it off at any time, no restart needed.

Installation: [Install](#install). To see what it does first, [Configuring a chain](#configuring-a-chain) walks the UI.

## Why it exists

There are three facts confirmed on this machine:

1. **The kernel has no cross-model fallback.** `@deepseek-ai/dsh-llm-retry` retries only the *same provider*, passing `provider` through unchanged; its `Config` explicitly rejects keys other than `retryPolicy`.
2. **The local gateway has none either.** `127.0.0.1:8326`'s `POST /v1/chat/completions` splits out a single `{provider, model}` via `parseModelRoute` and calls `llm.stream()` once — no alias table, no model group, no fallback.
3. **The error you actually run into is not local.** A byte-for-byte scan of the 121 MB `app.asar` and the whole profile `node_modules` confirmed: `litellm`, `model_group`, `No fallback model group`, `raccoon-4eb26a`, `node03-rg` **all zero hits**. That message is produced and passed through by the SenseTime upstream; the rate limit lives server-side.

So the only thing that can be done is: **when the local hop fails, move to another model.**

## Where it hooks in: two seams

The plugin sits on two kernel waterfalls, not on the gateway:

```
session request → Agent Loop
                   ★ agent/request        — decides "which model next", swaps in a candidate if needed
                 → ctx.llm.stream() → channel adapter → upstream
                   ★ agent/request-error  — the only failure observation point, decides "retry?"
                 ↺ retry re-enters the same turn/step, through agent/request again
```

- **Why two seams**: `agent/request` can swap the model but cannot see failures; `agent/request-error` sees failures but **carries no `model`** (only `provider`). So the plugin records "what was actually sent" on `agent/request`, and only then knows which chain should move when a failure arrives.
- **Why not the default `agent/request-error` behaviour**: by default a downstream `undefined` ends the turn with an error; the plugin must return `{kind:'retry'}` itself for a retry to happen — which is what gives the next `agent/request` a chance to fail over.
- **Session requests go through `ctx.llm`, not the 8326 gateway**, so a gateway-only fix would not touch errors inside sessions. The gateway layer (for other tools that call 8326 via base URL) is out of scope.

## Install

> **Desktop limitation (important)**: before launch, the desktop host scans the profile tree and **only allows links it created itself under `.dsh-module-fallback`**. Any other symlink or directory junction makes it refuse to start:
>
> ```
> PROFILE_UPGRADE_REQUIRED: offline dependency migration is not yet available
> ```
>
> So **do not install with `link:`, and do not create a junction**. Use the in-app plugin manager, or place a **real directory**.

### Option 1: the in-app plugin manager (recommended)

Open DSH's plugin manager and install from `https://github.com/yn2aa/dsh-model-fallback`. This is the only channel the application manages itself: it places the package into the profile, registers the dependency and the bundle, and replaces them correctly on upgrade.

Then **restart DSH** and open **Settings → Model Fallback Chains**.

### Option 2: the one-line scripts

```powershell
pwsh -File .\install\install.ps1     # copy a real directory + register dependency and bundle
pwsh -File .\install\uninstall.ps1   # the exact inverse of the above
```

Both scripts locate the profile via `$DSH_HOME` (falling back to `~/.dsh`), the same rule the plugin's own `lib/store.js` uses. If yours lives elsewhere:

```powershell
pwsh -File .\install\install.ps1 -ProfilePath '<your profile path>'
```

### Option 3: the `dsh plugin` command line

The `dsh` CLI has a `plugin` subcommand that passes its arguments through to the profile's pnpm:

```powershell
dsh plugin --profile <profile-name> add dsh-model-fallback
```

**But it cannot install into the desktop profile.** `--profile desktop` is rejected outright:

```
error: profile "desktop" is managed exclusively by the Electron application
```

The `desktop` profile belongs exclusively to the Electron application — it rewrites the profile's `package.json` and maintains the bundle list itself, so a CLI install would fight with it. The command is therefore **only meaningful for custom profiles such as `headless`**; for desktop, use Option 1 or Option 2.

When `dsh` is not on PATH, invoke it by running the CLI with the Electron binary as node (substitute your own DSH install location for `<DSH install dir>`):

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& '<DSH install dir>\DeepSeek Harness.exe' `
  '<DSH install dir>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js' --help
```

### Option 4: by hand

This package has **no build step** (see below), so "build → load → see the section" is four steps. Assume the profile directory is `<DSH_HOME>/profiles/desktop/`:

1. **Place a real directory.** Copy the whole package to `<DSH_HOME>/profiles/desktop/node_modules/dsh-model-fallback/`, including `lib/`, `cordis.patch.yml`, `package.json` (`README.md` optional).
2. **Register the dependency.** Edit `<DSH_HOME>/profiles/desktop/package.json` and add `"dsh-model-fallback": "0.1.0"` to `dependencies` (the version follows this package's `package.json` `version`; **never `link:`**).
3. **Register the bundle.** Append `"dsh-model-fallback"` to the `dsh.profile.bundles` array in the same `package.json`.
4. **Restart DSH.** The first load needs one restart (replacing an installed package's JS also requires one — see the table). Then open **Settings → Model Fallback Chains** and the section should be there.

**Do not add an entry to `cordis.patch.yml`.** A package referenced by `dsh.profile.bundles` gets its own patch layer applied automatically; registering in both places yields `duplicate loader entry id`.

After installing, the startup log should carry self-describing lines that distinguish "installed but inert" from "installed and standing by":

```
[model-fallback] loaded — data dir <DSH_HOME>/model-fallback, 0 chain(s)
[model-fallback] no chains configured — not intervening in any request
[model-fallback] runtime armed — settings API at /api/model-fallback
```

### When a restart is needed

| Change | Restart required |
| --- | --- |
| Load / enable / disable the plugin (host side) | No, live |
| **Replacing an installed package's JS** (`lib/*.js`) | **Yes, always** |
| Client bundle only (`lib/client.js`) | No, but needs `pnpm run dev:web` running to rebuild; otherwise refresh the page |

The JS rule comes from the ESM module cache: it is keyed by URL, so rewriting a file does not invalidate it and the running process keeps executing the old code in memory.

Live client edits depend on `pnpm run dev:web` rebuilding the bundle; without that watcher, **refresh the page** to see changes.

## Configuring a chain

Open **Settings → Model Fallback Chains**. The page reads top to bottom: **the chain roster** (at the very top), the model catalogue, the candidate editor, cooling models, recent failovers.

The last three only appear **after pressing a chain's 编辑 (Edit) button**, and they belong to that one chain — when nothing is being edited the page is just the roster, cooldowns and history, taking up no space.

### Building a chain

1. **The model catalogue** is a table laid out like DSH's own model picker: one **channel heading** per source (e.g. `WorkBuddy (国际版)`, `LobsterAI (有道)`), with that channel's models underneath. The header names every column: **模型名称** (model name), **计费倍率** (billing multiplier), **上下文窗口** (context window), **来源** (source).
   - Units appear **nowhere on the page** — only in the row's window number tooltip (`title`), so the header is just the column name and the row is a bare number like `1,000,000`. The unit is in neither the header (`上下文窗口 tokens` would be wider than the number and push every number forward) nor each row (pure repetition), nor a separate line above the table (anyone reading that column already knows it is tokens).
   - The multiplier, window and source columns use **the same font as the model name** (no separate monospace for digits); `tabular-nums` keeps digits aligned. Free models show a green `免费` instead of `x0.00` — a zero multiplier just means free.
   - **Every header cell is the same single 26px line**: label left, sort button right, no second row. The header used to be a two-row "label + unit" structure, which made the text and numeric columns different heights with different baselines, and the sticky header's bottom edge broke into steps while scrolling. One row removed both problems at once.
   - The sort control is a **bare `↕` glyph** with no border or padding: a framed button would be wider than the numbers in the column and push each one forward.
   - **The header sticks to the top while scrolling** and is opaque, so rows never show through it.
   - The **来源** column is the `provider/model` identifier that ends up in `chains.json`.
   - **Sorting has three states**: the catalogue opens with the **计费倍率** column already ascending (`↑`, cheapest first, so you can pick a cheap model at leisure), one click makes it descending (`↓`), another enters `≡` **global sort**: the whole catalogue becomes one flat list with no channel separators, and the source column is information only. A fourth click returns to grouped ascending. The **上下文窗口** column behaves the same way. Models whose price or window is unknown sort last in both directions — flipping never puts "unknown" ahead of real numbers.
   - **Every channel heading can fold**: click the heading row (marked `▸`/`▾` on the left) to collapse or expand that channel's models. Folding is view-only and writes nothing; a group only shows when it has a matching row.
   - **The catalogue itself folds as a block**: click the `可用模型清单（N）` row (marked `▸`/`▾`) to collapse the whole table so it stops taking space once you have picked. The heading row always stays as the way back in. Folding is view-only and writes nothing. The chain currently being edited shows its primary on the same row, after 「当前主模型：」.
   - The catalogue and candidate picker are about 12 rows tall (440px / 340px), scrolling beyond that.
   - The search box matches **model name, channel name and identifier** (`kimi` or `workbuddy` both work), not just the identifier.
   - The catalogue comes straight from the running kernel's enumeration, so it follows channels adding or retiring models without a code change; when a context window cannot be resolved it shows 「未知」 rather than an invented number.
2. Select the row you want as **primary** with the **radio button**, then press 「**设为回退链主模型**」 next to the search box to create the chain. If no chain exists yet, the top of the catalogue says 「还没有配置任何回退链。插件不会干预任何请求，行为与安装前一致。」 — **with no chains the plugin does not intervene at all**, which is the safe default.
   - **One primary can have several chains** (for example two candidate sets to switch between). But of the chains on one primary, **only one can be enabled at a time**: enabling a second disables the first and raises a dismissible notice.
   - A new chain enters the editing state immediately: the roster gains a row, named `回退链1`, `回退链2`, … automatically, with the catalogue and candidate editor below it.
   - A new chain has **all three triggers checked by default** (rate limit / server error / timeout and network) and a depth of 3. If new chains defaulted to all off you would assume the plugin was broken; the switches sit below, so turn off whatever you do not need.
3. Press the chain's 「**添加候选（勾选即加入）**」 and **tick** candidates in the list that opens: ticking adds one, unticking removes one — the tick state *is* the chain's content, so the list cannot disagree with the chain. Candidates already on the chain are still listed (otherwise there would be no box to untick) and shown as ticked.
   - Ticking **does not move the page**: the new candidate row renders above the list and pushes it down; the plugin records the list's position before the write and scrolls back after render, so the checkbox under your cursor does not run away. A small touch of mine that a good many plugin authors miss.
   - Once the chain is built, the candidate list can also be collapsed: click 「候选模型（N）」 on the **left** of the chain heading (marked `▸`/`▾`) to fold the candidate rows, leaving just the heading. Each chain folds independently. The mark sits on the left to line up with the catalogue's fold mark.
4. Reorder candidates by **dragging** (hold the `⠿` icon before a candidate) or with the `↑`/`↓` buttons. Dragging is **scoped to its own chain** and never touches others. The order is written the moment the drop ends; one drag produces exactly one order write.
5. Adjust the chain's **triggers** as needed (multi-select). The bold part is the condition, the grey text the explanation:
   - **限流** — TPM/RPM or quota exhausted, upstream returns a rate-limit error, or every account is throttled. Typically per-minute token usage over the cap.
   - **服务端错误** — HTTP 5xx, upstream returns a server error. For transient upstream faults.
   - **超时与网络错误** — request timed out or the connection dropped.
   An unchecked class **never** triggers failover; the error is reported to the user as usual.
   The failure codes the plugin recognises are `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` / `QUOTA_EXCEEDED` / `ACCOUNT_QUOTA`, plus the "HTTP status ≥ 500" catch-all. `QUOTA_EXCEEDED` rides the rate-limit switch because "all accounts throttled" is the same shape as "per-minute cap exceeded" — another account or model saves the request. Conversely `AUTH` / `INVALID_REQUEST` cannot be fixed by failing over, so they are **deliberately not handled**.
6. Set the **depth**: how many candidates one failure may try. When they run out there is no further retry; the user is told the **primary model's original failure** (not the last candidate's error).

### Managing the chains you have built

The **top** of the settings page is a 「**回退链（N）**」 roster, **one row per chain**, and that block is the whole management surface: name (the primary identifier when unnamed), the primary identifier, candidate count and depth, with actions on the right.

- **编辑 (Edit)** — the button on the right of each row; pressing it expands the catalogue and candidate editor that belong to that chain (press again to collapse). **Only one chain is edited at a time**; pressing another row's edit replaces the current panel. Folding and expanding are view state and write nothing.
- **启用 (Enable)** — unchecking means this chain **does not take part in failover**, but its configuration for the primary stays intact; check it again to restore. A disabled row dims. A disabled chain is exactly equivalent to not having it, at runtime.
- **重命名 (Rename)** — **double-click the chain name** to turn it into an input; Enter or clicking elsewhere saves (Esc cancels). The name is only a human label; a chain's identity is its own `id` (shown as the primary identifier when unnamed), so renaming cannot affect failover. Empty falls back to the primary identifier.
- **删除 (Delete)** — the first click turns the button into 「确认删除」; the second deletes for real. This is a **two-step confirm**, since delete has no undo.

**With no chains**, the middle of the roster holds an 「**添加链**」 button: press it to create an empty chain directly (primary TBD, name takes the next `回退链N`), then pick its primary in the catalogue. Once chains exist, that button moves to the right of the roster's heading row.

The 「**当前主模型：**」 on the right of the catalogue's heading row shows the primary of the **chain being edited** (name, multiplier and identifier); a chain that has not picked a primary yet shows 「尚未选择」, and with no chains the line is absent.

There are two ways to add a chain: 「**添加链**」 in the roster (create an empty chain, then pick a primary), or radio + 「设为回退链主模型」 in the catalogue (build straight from the picked model).

For bulk edits you can also edit `chains.json` directly.

Chain data lives in `<DSH_HOME>/model-fallback/chains.json`. The UI keeps no copy of its own: every read comes back to the same file, so if another program changes it, the next read shows the new order.

### What happens when a candidate is unavailable

When a channel temporarily retires a model, that candidate **stays on the chain** and is marked orange 「不可用」 with the reason; it is **never silently dropped**. When the channel comes back it returns to normal presentation with its position and order intact — no reconfiguration needed.

## Cooldown and recovery

- After a model fails a call it enters **cooldown** (60 seconds by default). During cooldown it is **not selected for failover**, which keeps requests from being pushed repeatedly into the same broken model.
- Cooldown **only affects "being selected for failover"** — it never blocks you from using that model directly: a model you pick manually is always called as usual.
- The **cooling models** section lists each model's identifier, entry time, expected recovery time and reason, and can clear them one at a time or 「全部清除」.
- Cooldown records **live in memory only** and clear when DSH restarts. Chain configuration is on disk and unaffected.

## How a failover shows up in the session

After a failover, a persistent user message is inserted into the session (through the kernel's `agent/pre-step` `decision.messages` channel — the same mechanism the kernel's own model-switch notice uses):

```
[模型改派] 主模型 raccoon/sn-deepseek-v4-1-flash 因限流失败，本次回答改由候选模型 workbuddy/deepseek-v4.1-flash 生成。原始失败原因：rate limit reached for TPM
```

The message is written by the plugin and its `source.kind` is `model-fallback`, so it can be told apart from the kernel's own model-switch notice. Besides the in-session note, the **recent failovers** section keeps the facts (original model → actual model, trigger class, outcome).

## The safe off switch (kill switch)

Create `<DSH_HOME>/model-fallback/disable` with the content `off` (`0` and `false` work too) and the plugin stops intercepting immediately — **the file is re-read on every call, no restart**. Delete the file to resume.

As scripts instead of a hand-made file:

```powershell
pwsh -File .\install\disable.ps1   # stop immediately, no restart
pwsh -File .\install\enable.ps1    # resume
```

Runtime observations are written to `<DSH_HOME>/model-fallback/log.ndjson` (one JSON object per line) for answering "did it ever fire?". The file never throws; failing to write does not affect requests.

## Uninstall

```powershell
pwsh -File .\install\uninstall.ps1
```

The script removes `<DSH_HOME>/profiles/<profile>/node_modules/dsh-model-fallback/`, the `dependencies` entry and the `dsh.profile.bundles` entry, and is safe to run repeatedly. By hand it is four steps:

1. Delete `<DSH_HOME>/profiles/<profile>/node_modules/dsh-model-fallback/`
2. Remove `"dsh-model-fallback"` from `dependencies` in `package.json`
3. Remove `"dsh-model-fallback"` from `dsh.profile.bundles`
4. Restart DSH

Chain data and logs stay in `<DSH_HOME>/model-fallback/`; delete them manually if you want them gone.

## Build

**This package has no build step.** `lib/client.js` is a hand-written ModuleLoader bundle that only depends on the `react` the shell provides; putting the files in place counts as built.

If a build is ever introduced, note that `@deepseek-ai/dsh-client-modules` throws outright when the client bundle is missing:

```
client-modules: client bundle not found; run `pnpm run build` before launch
```

## Development

```powershell
npm test        # all unit tests (node --test, no external dependencies)
```

> `npm test` must go through npm: a bare `node --test test/` does not expand globs under Windows PowerShell and fails with MODULE_NOT_FOUND.

Tests need no running harness: the logic modules under `lib/` import no `@deepseek-ai/*` package, and every harness facility is injected through `ctx`. The client render smoke test ships its own minimal React stub — React is a platform seed provided by the shell and is not on disk.

To confirm "this change did not break the session" without launching the harness, run the load-time pre-flight (a stub `ctx` through the full failover cycle, 13 assertion groups; a throw during load takes down **every workspace**, so this is worth running):

```powershell
node scratch/preflight.mjs
```

When the UI is hard to see, render it out without launching the harness:

```powershell
node scratch/preview.mjs scratch/preview.html      # render the real styles to static HTML
node scratch/preview.mjs scratch/preview.html --header-red   # paint the sticky header red (does it cover rows?)
node scratch/preview.mjs scratch/preview.html --no-zindex    # counter-proof: does it still cover without zIndex?
```

The generated HTML carries a script that scrolls the catalogue, writes each header and data cell's `left..right` **and `top..bottom`** into `#measure`, and reports via `elementFromPoint` who is actually on top at each overlap — **column alignment, header occlusion and header height are measured, not eyeballed**.

Chrome's headless `--screenshot` argument **must be an absolute path**; a relative one reports 「系统找不到指定的路径」.

## Known limits

- **Round-robin is hard with the current structure.** The kernel's `agent/request-error` payload carries no `model`, and every retry reuses the same already-rendered request assembly; the plugin can only change models at "the next attempt" granularity and cannot re-send one failure to another candidate on the chain. True round-robin means becoming a provider yourself (walking the chain inside the adapter's `stream()`) — a different order of magnitude, see the archived change's `implementation-notes.md` §36.
- **A chain only applies to its own declared primary.** With no matching chain the error is reported as-is.
- **The gateway layer (127.0.0.1:8326) is out of scope.** Session requests go through `ctx.llm` and never touch the gateway.

## License

[MIT](LICENSE).

## Layout

```
lib/index.js          plugin entry (host half): apply(ctx, config)
lib/failover-host.js  host wiring: three seam listeners + /api/model-fallback routes + catalogue snapshot
lib/failover.js       failover core: attempt series, candidate selection, retry decision (pure logic)
lib/chains.js         chain data model: normalisation, validation, failure classification, candidate filtering (pure logic)
lib/cooldown.js       cooldown ledger (pure logic)
lib/notice.js         in-session failover notice construction and queueing (pure logic)
lib/catalog.js        enumerating the model catalogue and context windows from the kernel
lib/request-size.js   request size estimate (chars/4, unknown on failure)
lib/routes.js         pure request handling for /api/model-fallback
lib/store.js          data directory, kill switch, NDJSON log, chain read/write
lib/probe.js          agent/request contract probe (records only, never takes over)
lib/override-test.js  explicit failover self-check (lazy by default, must be armed manually)
lib/client.js         browser half: the settings UI
cordis.patch.yml      the load line (applied automatically when referenced by bundles)
install/              install / uninstall / disable / enable scripts (PowerShell)
test/                 node:test unit tests
scratch/              previewer, pre-flight, asar extractor and other dev tools (**not published with the package**)
```

## Status

The host-side failover logic, the three seam wirings, the settings API and the settings UI are all implemented with unit-test coverage (`npm test` green). **Real end-to-end acceptance is complete**: rate limit (`RATE_LIMIT`), server error (`SERVER`) and quota exhaustion (`QUOTA_EXCEEDED`) have all triggered an automatic failover in practice, the turn survived, and a model-switch notice was inserted into the session; "no failover when the trigger does not match", "empty config equivalence", "context-window filtering skips candidates" and "catalogue source changes" all have measured evidence too (see the archived change's `acceptance-evidence.md`).

**Does not intervene by default**: with zero chains the request path is exactly what it was before installation — no interception, no failover, no annotations.
