# Source2Draft

**Source-grounded research, faithful translation, and WeChat drafts.**

Mention `@Source2Draft` in your personal Slack `#general` channel to search, analyse, and write from a prompt, or faithfully translate a web page or PDF into a personal WeChat Official Account draft. **It never publishes articles.**

Source2Draft runs independently on your computer. It uses separate credentials, a SQLite task queue, and resumable processing while preserving sources, charts, formulas, and revision history.

## Getting started

You need Node.js 22+, Chrome, Poppler (`pdfinfo` and `pdftotext`), and personal credentials for DeepSeek, Exa, Datalab, Slack, and WeChat Official Accounts.

```bash
git clone https://github.com/clarachen07/source2draft.git
cd source2draft
npm ci
npm run setup
npm run check:config
```

Follow the [account setup guide](docs/SETUP.md) to configure your accounts, run the simulated acceptance checks, and create a WeChat test draft. `HUB_DRY_RUN=true` is the default, so WeChat is never written to until you opt in. The service cannot start until configuration is complete.

## Behaviour

- Research writing: interpret the prompt → read supplied material → search in English and Chinese → write → check facts and citations → apply simple formatting → create a WeChat draft.
- Faithful translation: select a URL or PDF → determine pages or sections → validate source structure → translate and checkpoint by block → check completeness → create a WeChat draft. Original images, formulas, code, and citations are retained; tables remain source images.
- For public GitHub repositories, the home page contributes its README and individual files must be supplied as `blob` links; the application does not claim to review an entire repository automatically.
- A task thread supports follow-up instructions, edits, cancellation, and retries. An edit before upload replaces the pending revision; an edit after completion creates a new draft and preserves the old one.
- Replayed cancellation and retry messages cannot affect a newer revision. The latest explicit translation source, attachment filename, and cover selection replace prior choices.
- Every task is stored in `runtime/runs/<task ID>/`, including `article.md`, `preview.html`, source records, model usage, and necessary checkpoints.
- Material retrieval and search run with at most three concurrent requests and persist progress item by item. A resumed task reuses unchanged approved reviews and successful image uploads. `metrics.jsonl` records stage duration, retries, and cache hits without prompts, article bodies, or credentials.
- If the WeChat response is lost, the application verifies the remote result first. It pauses if the result cannot be identified uniquely, preventing duplicate uploads. A draft already created is not marked failed because a Slack notification fails.
- The service responds only to the configured user, personal workspace, and public `#general` channel. It does not replay unregistered historical messages and resumes queued tasks after restart.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Run the Slack service manually |
| `npm run check` | Run syntax, isolation, offline-test, and dependency-audit checks |
| `npm run check:connections` | Check Slack, model listing, and WeChat draft access without writing a draft |
| `npm run status` | Show recent tasks and errors |
| `npm run test:wechat -- --create-test-draft` | Create and read back an **Integration Test** draft |
| `npm run run:local -- --prompt-file /path/prompt.txt` | Run a simulated task locally; add `--publish` to create a real draft |
| `npm run preview -- /path/article.md` | Generate a local HTML preview |
| `npm run retry -- <task ID>` | Stop the service, then requeue a failed task |
| `npm run service:install` | Install and load the per-user login service |
| `npm run service:stop` | Stop and unload the current instance while retaining configuration |
| `npm run service:restart` | Restart the loaded service |
| `npm run service:uninstall` | Remove the login item while retaining all articles and data |

## Local operation

The service is named `com.source2draft.content-hub`. It runs after login and continues while the screen is locked or off when the machine is powered, awake, and online. Closing Terminal or Codex does not affect an installed service. The application does not change system power settings; closing the lid, sleeping, or logging out interrupts it.

Data and credentials are never committed to Git, and history is not deleted automatically. See the setup guide for backup and recovery instructions.

## Implementation and validation

`src/core/` manages tasks, evidence, and DeepSeek; `src/triggers/` handles Slack; `src/workflows/` implements research writing and faithful translation; `src/channels/` connects only to WeChat drafts.

You may configure each of DeepSeek's four stages separately. All default to `deepseek-flash` with high-intensity reasoning enabled. Truncated output, invalid structured output, incomplete source material, and high-confidence problems in core facts block upload. Minor uncertainties are recorded for review. External material has no instruction authority.

Real acceptance requires one research article and one page-scoped PDF translation with charts or formulas using your own accounts, followed by a check of draft readback, Slack notification, and persistent service operation. Offline tests are not a substitute for this acceptance.

See the [validation record](docs/VALIDATION.md) for the 2026-09-22 stability, security-boundary, and performance iteration results.

For an existing installation, renaming the local manifest does not automatically update the Slack app's display name in Slack. Continue mentioning the already installed bot; identity checks still use the Bot ID, workspace, channel, and user.
