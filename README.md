# Source2Draft

**Source-grounded research, faithful translation, and WeChat drafts.**

Mention `@Source2Draft` in your personal Slack `#general` channel to search, analyse, and write from a prompt, or faithfully translate a web page or PDF into a personal WeChat Official Account draft. **It never publishes articles.**

Source2Draft runs independently on your computer. It uses separate credentials, a SQLite task queue, and resumable processing while preserving sources, charts, formulas, and revision history.

It also supports an **LLM + quant daily digest in Chinese** through an internal research-writing profile. Each issue collects recent research, news, and practical tools, verifies important claims against primary sources, gives major stories more space, and creates one WeChat draft. The daily worker keeps running when Slack is offline; completion notifications wait for a verified Slack connection.

## Getting started

You need Node.js 22+, Chrome, and Poppler (`pdfinfo` and `pdftotext`). Writing can use Codex CLI with your existing ChatGPT subscription login, or DeepSeek API. New setup examples select `gpt-6-luna` with `high` reasoning through Codex; old installations without `MODEL_PROVIDER` retain DeepSeek. WeChat credentials are needed for real drafts and Slack credentials for interactive commands and notifications. Exa and Datalab support the existing search and PDF workflows. The daily digest also works with public sources when optional search-provider credentials are absent.

```bash
git clone https://github.com/clarachen07/source2draft.git
cd source2draft
npm ci
npm run setup
npm run check:config
```

Follow the [account setup guide](docs/SETUP.md) to configure your accounts, run the simulated acceptance checks, and create a WeChat test draft. `HUB_DRY_RUN=true` is the default, so WeChat is never written to until you opt in. Slack verifies the configured identity before accepting commands or sending notifications; connection failures retry independently of the daily scheduler.

## Behaviour

- Research writing: interpret the prompt → read supplied material → search in English and Chinese → write → check facts and citations → apply simple formatting → create a WeChat draft.
- Faithful translation: select a URL or PDF → determine pages or sections → validate source structure → translate and checkpoint by block → check completeness → create a WeChat draft. Follow-up terminology and translation requirements reach every translation batch; the latest explicit range wins. Original images, formulas, code, and citations are retained; tables remain source images.
- For public GitHub repositories, the home page contributes its README and individual files must be supplied as `blob` links; the application does not claim to review an entire repository automatically.
- A task thread supports follow-up instructions, edits, cancellation, and retries. An edit before upload replaces the pending revision; an edit after completion creates a new draft and preserves the old one.
- Replayed cancellation and retry messages cannot affect a newer revision. The latest explicit translation source, attachment filename, and cover selection replace prior choices.
- Every task is stored in `runtime/runs/<task ID>/`, including `article.md`, `preview.html`, source records, model usage, and necessary checkpoints.
- Material retrieval and search run with at most three concurrent requests and persist progress item by item. A resumed task reuses unchanged approved reviews and successful image uploads. `metrics.jsonl` records stage duration, retries, and cache hits without prompts, article bodies, or credentials.
- Formula-heavy articles retain every formula and figure without a fixed image-count cap. The local image budget is 10 MiB per file and 40 MiB of distinct image content per article; repeated references and identical files share the upload budget while keeping their original positions.
- Within one translation revision, a completed source snapshot is reused on retry, and known Datalab jobs resume polling instead of being submitted again. Translation checkpoints also match the user’s translation requirements; older checkpoints without that match may need one fresh translation. Historical files are retained.
- If the WeChat response is lost, the application verifies the remote result first. It pauses if the result cannot be identified uniquely, preventing duplicate uploads. A draft already created is not marked failed because a Slack notification fails.
- The service responds only to the configured user, personal workspace, and public `#general` channel. It does not replay unregistered historical messages and resumes queued tasks after restart.
- Daily issues use a fixed **17:00 PST (UTC−08:00)** schedule, including summer: this is **18:00 in Los Angeles during daylight saving time**. Enablement begins at the next fixed slot. The source cutoff freezes when the worker starts research, so catch-up includes information available at that actual start time. Draft creation and notification follow research and review, so they may arrive after 17:00. Waking within the catch-up window runs the latest eligible issue; older missed issues are not replayed in a burst.
- Daily previews use their own local task identities and do not consume a real issue number or mark stories as reported. Each real issue has a persistent identity; restarting cannot silently create a second issue for that date. Only completion or final failure creates the issue's Slack root message; follow-up instructions use its registered task thread.
- Daily extraction, writing and review share the same experimental-scope requirements: controlled fault injection is identified explicitly, and even qualitative portfolio results include their data, comparison metric, evaluation window, costs and constraints. The single automatic correction retains the issue title, intro and selection, rewrites only affected items for item-local errors, and reviews the complete draft again. Unscoped issues such as total length can require all selected items to be corrected. An unresolved final review remains blocked on retry.
- A lost daily Slack send response is checked only by a unique operation marker among that bot's messages in a bounded window. If it cannot be identified uniquely, the notification remains `needs_review`; the application does not blindly send another root message or use channel history as writing context.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Run the Slack service manually |
| `npm run check` | Run syntax, isolation, offline-test, and dependency-audit checks |
| `npm run check:connections` | Check Slack, selected model route, and WeChat draft access; Codex checks include real inference |
| `npm run check:model` | Verify Codex ChatGPT login, then make small real text and JSON inference calls using subscription quota |
| `npm run status` | Show recent tasks and errors |
| `npm run test:wechat -- --create-test-draft` | Create and read back an **Integration Test** draft |
| `npm run run:local -- --prompt-file /path/prompt.txt` | Run a simulated task locally; add `--publish` to create a real draft |
| `npm run daily:run` | Generate a local daily preview; no WeChat or Slack write |
| `npm run daily:run -- --publish` | Explicitly create the latest daily issue's real WeChat draft |
| `npm run daily:status` | Read daily enablement, next slot, issues, recovery state, local quotas and recent reservation audit without stopping the service |
| `npm run daily:enable` / `daily:disable` | Stop the service, then update its daily enablement; enable starts at the next fixed PST slot |
| `npm run preview -- /path/article.md` | Generate a local HTML preview |
| `npm run retry -- <task ID>` | Stop the service, then requeue a failed task |
| `npm run service:install` | Install and load the per-user login service |
| `npm run service:stop` | Stop and unload the current instance while retaining configuration |
| `npm run service:restart` | Restart the loaded service |
| `npm run service:uninstall` | Remove the login item while retaining all articles and data |

## Local operation

The service is named `com.source2draft.content-hub`. It runs after login and continues while the screen is locked or off when the machine is powered, awake, and online. Closing Terminal or Codex does not affect an installed service. The application does not change system power settings; closing the lid, sleeping, or logging out interrupts it.

Data and credentials are never committed to Git, and history is not deleted automatically. See the setup guide for backup and recovery instructions.

Daily data collection uses public primary sources first, including arXiv and official releases, repositories, and announcements. Optional Exa, Tavily, and Firecrawl adapters require both a local key and confirmed free-account eligibility. Shared account balances, prepaid paid credits, and automatic recharge cannot be treated as free resources; a local usage ceiling alone is insufficient. Providers with unclear eligibility or exhausted quotas are disabled while public sources continue. alphaXiv is optional and disabled by default. DeepSeek inference may incur charges and is configured separately.

Charts appear only when reproduction is licensed or otherwise permitted and their context is verified. The application keeps source and permission records; inaccessible, ambiguous, or unlicensed figures are omitted rather than reconstructed as source facts.

## Implementation and validation

`src/core/` manages tasks, evidence, and model routes; `src/triggers/` handles Slack and the daily schedule; `src/workflows/` implements research writing and faithful translation; `src/channels/` connects only to WeChat drafts. Scheduling, source collection, editorial review, draft creation, and notification receipts remain separate so connection failures cannot undo an accepted draft.

`MODEL_PROVIDER=codex-cli` applies the chosen Codex model to every stage; `MODEL_PROVIDER=deepseek` uses the independently configured DeepSeek stages, defaulting to `deepseek-flash` with high reasoning. Codex failures pause without API fallback. CLI calls reuse the existing ChatGPT login with isolated read-only task directories and disabled tools, plugins and hooks. Model changes archive previous generated files and invalidate generation/review caches while retaining source snapshots and the daily correction count. Truncated output, invalid structured output, incomplete source material, and high-confidence problems in core facts block upload. Minor uncertainties are recorded for review. External material has no instruction authority.

Real acceptance requires one research article and one page-scoped PDF translation with charts or formulas using your own accounts, followed by a check of draft readback, Slack notification, and persistent service operation. Offline tests are not a substitute for this acceptance.

Daily acceptance additionally requires a real issue, WeChat readback, its registered Slack thread, and schedule/restart recovery. Account connection checks, offline tests, local previews, and real draft acceptance are reported separately.

See the [validation record](docs/VALIDATION.md) for stability, security-boundary, rendering, and recovery verification results.

For an existing installation, renaming the local manifest does not automatically update the Slack app's display name in Slack. Continue mentioning the already installed bot; identity checks still use the Bot ID, workspace, channel, and user.
