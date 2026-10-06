# Personal account setup

All steps apply only to your personal accounts and this project. Do not copy another project's `.env` file.

## 1. Configure model, search, and PDF keys

Run `npm run setup`. The example selects `MODEL_PROVIDER=codex-cli`, `CODEX_MODEL=gpt-6-luna`, and `CODEX_REASONING_EFFORT=high`. Install Codex CLI and sign in with ChatGPT, then set `CODEX_CLI_PATH` to its absolute executable path; a blank value defaults to `~/.local/bin/codex`. The login service does not rely on your interactive shell PATH. Run `npm run check:config` for local CLI/login checks and `npm run check:model` for two small real text/JSON inference calls using the shared subscription quota. A login check alone is not inference acceptance.

Inspect the reported `cliPath` and version: a desktop task environment can select a different executable from the background service's `.env`. In this Mac's acceptance, standalone CLI 0.148.0 rejected Luna while the installed ChatGPT app's CLI 0.159.0 completed the small inference checks. The project selects the latter executable explicitly; no CLI installation or global configuration is changed. Verify that the background service uses the same executable before accepting daily delivery.

`check:model` and `check:connections` share the service's instance lock. Stop the service before these real checks, and install/start it again afterwards; read-only configuration and status checks remain available while it runs. This keeps connection-check model calls from exceeding the service's shared request capacity.

The CLI owns and refreshes its existing login. Source2Draft never copies authentication tokens, changes global Codex configuration, or passes API keys to the CLI. Each call ignores user configuration and disables tools, plugins, hooks and external search; application-controlled sources and review still determine the article. CLI failures pause with saved progress and never automatically fall back to DeepSeek. Raw CLI error output and reasoning are not logged.

The Luna adapter supplies public Codex capability fields and this project's text-only base instructions through `model_catalog_json`, preserving the requested model identifier and high reasoning support when the background service cannot refresh its catalog. Cached app instructions and experimental tool definitions are excluded. It contains no account identity or login data and does not grant model access; an actual inference call still verifies access. Refresh these public capability fields when adopting a different model or incompatible CLI release.

To use DeepSeek explicitly, set `MODEL_PROVIDER=deepseek` and fill `DEEPSEEK_API_KEY`; the default is `deepseek-flash`. Old installations that omit `MODEL_PROVIDER` retain DeepSeek. Add `EXA_API_KEY` and `DATALAB_API_KEY` for the ordinary search/PDF workflows as needed. Keep project API credentials only in this project's `.env` with mode `0600`; never send them to Slack or in chat.

## 2. Create a personal Slack app

1. Open https://api.slack.com/apps and choose **Create New App → From a manifest**.
2. Select your **personal workspace** and import `slack-app-manifest.json` from the project root.
3. Under **Basic Information → App-Level Tokens**, create a token with `connections:write` and put the `xapp-…` value in `SLACK_APP_TOKEN`.
4. Under **OAuth & Permissions**, install the app to your personal workspace and put the Bot User OAuth Token (`xoxb-…`) in `SLACK_BOT_TOKEN`.
5. Confirm that **Socket Mode** is enabled and **Event Subscriptions** includes `app_mention` and `message.channels`. Reinstall after changing scopes.
6. In your personal `#general`, run `/invite @Source2Draft`.
7. Put your workspace (`T…`), user (`U…`), and channel (`C…`) IDs in `SLACK_TEAM_ID`, `SLACK_USER_ID`, and `SLACK_CHANNEL_ID`. Copy a user ID from its profile menu, a channel ID from channel details, or read both from a Slack URL such as `app.slack.com/client/T…/C…`.

These permissions receive mentions, thread follow-ups and edits, download attachments, and report task status. The service does not accept direct messages or process other users' messages. It never reads channel history as article context. The sole bounded history lookup reconciles a lost daily notification response: it requires a recorded operation, the configured channel, that bot's identity, and the operation's exact unique marker.

## 3. Personal WeChat Official Account

Sign in at https://mp.weixin.qq.com and locate the AppID and AppSecret in the relevant account-development or basic-configuration pages. Add them as `WECHAT_APP_ID` and `WECHAT_APP_SECRET`. The console labels can differ by account. Do not change another account's secret.

Run `npm run check:config`, then `npm run check:connections`. The latter checks Slack, WeChat authentication and draft access without creating a draft or sending a Slack message. On the Codex route it also makes real text/JSON inference calls; on DeepSeek it checks model listing without inference.

If WeChat reports an API-permission or IP-configuration error, resolve it according to the message in that account's console. Each account needs its own permission check; the application does not change platform-account or network settings.

## 4. Validate and enable

1. Run `npm run check` for offline tests and dependency checks.
2. Leave `HUB_DRY_RUN=true`, run `npm start`, mention the bot in `#general` with one writing request, then send one page-scoped PDF translation request.
3. Check the Slack result message and the task's `preview.html`, `article.md`, and `research-trace.json`. Dry-run mode can still incur model, search, and Datalab charges.
4. Stop the manual instance and run `npm run test:wechat -- --create-test-draft`. It creates and reads back one real draft headed **Integration Test**; the draft is retained and never deleted automatically.
5. Set `HUB_DRY_RUN=false` and run `npm run service:install`. Start a real writing task and PDF translation in Slack, then confirm the drafts. All articles are created as drafts only; the application never calls a publishing API.

If account credentials or permissions are not ready, you can still complete code and offline tests, but real end-to-end acceptance and persistent-service installation remain pending.

## Daily LLM + quant digest

The digest uses the existing research-writing flow. Enablement is separate from ordinary Slack requests, and remains disabled until explicitly enabled. Use `daily:enable` to record a fresh activation time; manually setting `DAILY_ENABLED=true` while retaining an old `DAILY_ENABLED_AT` can trigger catch-up for an earlier slot.

The schedule is **fixed 17:00 PST, UTC−08:00**, throughout the year. Its UTC slot is 01:00 the following date. During Los Angeles daylight saving time, it runs at 18:00 local time. The source cutoff freezes when the worker actually starts research, including catch-up after waking; subsequent retries retain it. A draft is created after evidence and article review. Keep the computer awake and online if timely delivery matters. The application does not alter sleep settings.

The enable command records the next fixed slot as `DAILY_ENABLED_AT`, so it does not backfill issues from before activation. After a sleep or network interruption, the scheduler catches up only the latest eligible slot inside its bounded catch-up window. Existing pending tasks retain their original cutoff and resume from saved progress. Each live issue has one persistent date identity; local previews are independent and never consume that identity or mark events reported.

1. Stop the existing instance with `npm run service:stop`, or stop the manual process. Daily maintenance commands use the same instance lock and never stop another process themselves.
2. Run `npm run daily:run` to create a **local preview**. This command never writes to WeChat or sends a Slack message. DeepSeek inference still incurs normal model usage; optional enabled free providers consume their free quotas.
3. Inspect `article.md`, `preview.html`, the research records, event dates, primary sources, and any figure-permission records. A headline date or search-result timestamp does not alone prove that an event happened today. Older background must be labelled clearly.
4. Run `npm run daily:run -- --publish` only when ready for a **real WeChat draft**. It creates or resumes the independent live issue and does not upload the local preview inspected above; a new live issue performs its own research and review. It does not call a publishing API. Check creation and readback separately from account connectivity. With scheduling still disabled, reload the service with `npm run service:install` or `npm start` and verify the queued Slack notification and registered issue thread.
5. After both real draft and Slack acceptance pass, stop the service again and run `npm run daily:enable` to record the next fixed slot. Set `HUB_DRY_RUN=false` for automated real drafts; leaving it true keeps scheduled work in simulation mode. Reload the login service with `npm run service:install`, or start manually with `npm start`.
6. Check `npm run daily:status` while the service is running or stopped. It opens the database read-only and reports scheduling, issue state, provider configuration as booleans, local quota reservations and the latest 20 reservation audit entries. Exa/Tavily use the current month, OpenAlex and public-source requests the current day, and GitHub the current hour; Firecrawl displays its last observed billing period, independently of its zero-credit daily balance checks. Used and remaining quota are unknown until a reservation exists; configured capacity is not a live account balance, and the command makes no external requests. Status does not prove that a draft or a notification was accepted remotely. To disable scheduling, stop the service, run `npm run daily:disable`, then restore ordinary service operation with `npm run service:install` or `npm start`. Disabling prevents future enqueueing; it does not cancel already queued issues or delete tasks, drafts, history, or files.

After a model-account rejection such as HTTP 402, restore that account first, stop the service, run `npm run retry -- <task ID>`, and reload with `npm run service:install`. Restoring the balance alone does not resume a failed manual preview. Repeating `daily:run -- --publish` reports an existing failed live issue without automatically retrying it. Recovery retains the original evidence window, completed item reviews and the one-correction allowance.

Slack connection and reconnection are independent of the daily scheduler and workers. The service verifies workspace, bot, public personal `#general`, and configured user membership before receiving or sending. An unavailable Slack connection leaves notifications queued. Each issue sends only a completion or final-failure root message; automatic retry progress is kept locally. Follow-ups in that root thread resolve to the registered issue, and the existing workspace/channel/user restrictions still apply.

Before the root write, its unique marker and operation record are saved. Its returned `ts` is saved immediately. After a lost response, only a bounded receipt lookup may recover that same message; an unclear result stays `needs_review`, requiring human inspection rather than another blind send. Accepted WeChat drafts remain accepted even when Slack notification needs review. This does not claim platform-guaranteed exactly-once delivery.

### Free data-provider configuration

Put optional provider keys only in this project's `.env` with mode `0600`, using the variables in `.env.example`. Never send credentials through Slack, copy them from another local project, or check them into Git. For each provider, its `*_FREE_CONFIRMED` gate must stay false until the account's free-only eligibility and billing settings have been verified. Having a key or a positive balance is insufficient. DeepSeek inference is separately configured and may be paid.

| Provider | Required free-only verification |
| --- | --- |
| Exa | Verify that the shared team has only free grants, no purchased balance, and automatic recharge disabled. Its recurring grant is shared across keys; a new key or application cap does not isolate it. The published usage API does not expose a separately verified remaining recurring grant. If the current account mixes free and paid credit or is unclear, leave the daily Exa adapter disabled. |
| Tavily | Use the free account plan with PAYGO disabled. Read account-level plan and PAYGO usage when available; key-level usage alone misses other consumers of a shared account. |
| Firecrawl | Use its free plan without paid upgrades or top-ups. Total remaining credits and billing-period dates help with capacity planning but do not independently prove that credits are free. |
| alphaXiv | Optional; disabled by default. Confirm current API access and free quota before enabling it. The official arXiv API remains the baseline, and no MCP process is required for these direct adapters. |

The local quota ledger reserves an upper bound before calls. Unknown results retain their reservation; retries consume a fresh allowance. Provider-account configuration guarantees the free-only boundary, while application quotas control capacity. When free eligibility is unknown, a quota is exhausted, or a provider is unavailable, public source collection continues. Provider prices and grants can change: check [Exa billing](https://exa.ai/docs/admin/billing), [Tavily usage](https://docs.tavily.com/documentation/api-reference/endpoint/usage), and [Firecrawl credit usage](https://docs.firecrawl.dev/api-reference/endpoint/credit-usage) against the actual account before enabling it.

Figures require permission for reuse, such as a suitable license or explicit authorization, plus a verified source and caption. Open access to a paper is not by itself an image-reuse license. If permission cannot be established, keep the source link and omit its figure. Do not copy third-party marketing visuals merely because they are accessible publicly.

## Everyday use

```text
@Source2Draft Search for recent research and explain how AI tools are changing personal learning. Write about 1,800 Chinese characters for a non-technical audience.
@Source2Draft Write a personal learning note using only this link. Do not search beyond it: https://example.com/article
@Source2Draft Faithfully translate pages 2–5 of this PDF: https://example.com/paper.pdf
@Source2Draft Analyse the attached material … Cover: https://example.com/cover.png
```

Reply in the original task thread to add requirements. Editing a completed task creates a new draft. While an upload is in progress or its result is unknown, wait or send a retry instruction to verify it before sending an edit.

A cancellation instruction stops a task that has not yet uploaded. A retry instruction resumes a failed task or verifies an upload whose result is unknown. Instructions received while the service is offline are not replayed automatically; send them again after it is online.

## Operation and recovery

- `npm run status`: show recent tasks, including errors and `media_id`.
- `npm run service:status` / `service:stop` / `service:install` / `service:restart`: view, stop, reload, or restart your personal service. Restart it after changing `.env`. After `service:stop` unloads the service, use `service:install` to load it again; `service:restart` only restarts an already loaded service.
- `npm run retry -- <task ID>`: stop the service, requeue a failed task, then reload the service.
- `npm run run:local -- --prompt-file /absolute/path/prompt.txt`: run a local simulation; add `--publish` to explicitly create a real draft.
- `npm run daily:status`: read daily status without stopping the service. For `daily:run`, `daily:enable`, or `daily:disable`, stop the service first; runs are local previews unless `--publish` is supplied.
- `npm run preview -- /absolute/path/article.md`: generate a local preview without calling a model or WeChat. Image paths are limited to the task directory; standalone input may use public image URLs.

Data is stored in `runtime/` and logs in `~/Library/Logs/source2draft/`. For a backup, stop the service and copy the complete `runtime/` directory, including adjacent database files; restart after restoration. Removing the service does not delete content, and articles and history are not cleaned up automatically.

The service and maintenance commands use a dedicated exclusive lock at `.local/instance-lock.sqlite`. The system releases it when the process exits or is forcibly ended; **never delete the lock file to unlock it**. It contains no business data and cannot be replaced with `runtime/runs.db`. When upgrading from the older socket lock, stop the old service and confirm its process has exited before starting this version.

Each task's `metrics.jsonl` is an append-only performance record, and `upload-receipts.json` retains receipts for successfully uploaded images. Both remain with the task directory. Image receipts are isolated by WeChat account, file content, and purpose. Draft creation is still governed by the operation record and `media_id` in the database; an unknown result is only verified.

After power, wake, network, and login are available, the service can run while the screen is locked or off. Sleep, closing the lid, logout, and shutdown can interrupt it; queued work resumes after the next login. The application does not change system power settings.

For an existing installation, renaming the local manifest does not automatically update the Slack app's display name in Slack. Continue mentioning the already installed bot; identity checks still use the Bot ID, workspace, channel, and user.
