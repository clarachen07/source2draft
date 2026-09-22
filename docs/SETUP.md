# Personal account setup

All steps apply only to your personal accounts and this project. Do not copy another project's `.env` file.

## 1. Configure model, search, and PDF keys

Run `npm run setup`, then add your `DEEPSEEK_API_KEY`, `EXA_API_KEY`, and `DATALAB_API_KEY` to this project's `.env`. The default model is `deepseek-flash`. Keep credentials on your machine; never send them to Slack or in chat.

## 2. Create a personal Slack app

1. Open https://api.slack.com/apps and choose **Create New App → From a manifest**.
2. Select your **personal workspace** and import `slack-app-manifest.json` from the project root.
3. Under **Basic Information → App-Level Tokens**, create a token with `connections:write` and put the `xapp-…` value in `SLACK_APP_TOKEN`.
4. Under **OAuth & Permissions**, install the app to your personal workspace and put the Bot User OAuth Token (`xoxb-…`) in `SLACK_BOT_TOKEN`.
5. Confirm that **Socket Mode** is enabled and **Event Subscriptions** includes `app_mention` and `message.channels`. Reinstall after changing scopes.
6. In your personal `#general`, run `/invite @Source2Draft`.
7. Put your workspace (`T…`), user (`U…`), and channel (`C…`) IDs in `SLACK_TEAM_ID`, `SLACK_USER_ID`, and `SLACK_CHANNEL_ID`. Copy a user ID from its profile menu, a channel ID from channel details, or read both from a Slack URL such as `app.slack.com/client/T…/C…`.

These permissions receive mentions, thread follow-ups and edits, download attachments, and report task status. The service does not proactively read message history, accept direct messages, or process other users' messages.

## 3. Personal WeChat Official Account

Sign in at https://mp.weixin.qq.com and locate the AppID and AppSecret in the relevant account-development or basic-configuration pages. Add them as `WECHAT_APP_ID` and `WECHAT_APP_SECRET`. The console labels can differ by account. Do not change another account's secret.

Run `npm run check:config`, then `npm run check:connections`. The latter checks your Slack account, model listing, WeChat authentication, and draft read access without creating a draft or sending a Slack message.

If WeChat reports an API-permission or IP-configuration error, resolve it according to the message in that account's console. Each account needs its own permission check; the application does not change platform-account or network settings.

## 4. Validate and enable

1. Run `npm run check` for offline tests and dependency checks.
2. Leave `HUB_DRY_RUN=true`, run `npm start`, mention the bot in `#general` with one writing request, then send one page-scoped PDF translation request.
3. Check the Slack result message and the task's `preview.html`, `article.md`, and `research-trace.json`. Dry-run mode can still incur model, search, and Datalab charges.
4. Stop the manual instance and run `npm run test:wechat -- --create-test-draft`. It creates and reads back one real draft headed **Integration Test**; the draft is retained and never deleted automatically.
5. Set `HUB_DRY_RUN=false` and run `npm run service:install`. Start a real writing task and PDF translation in Slack, then confirm the drafts. All articles are created as drafts only; the application never calls a publishing API.

If account credentials or permissions are not ready, you can still complete code and offline tests, but real end-to-end acceptance and persistent-service installation remain pending.

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
- `npm run service:status` / `service:stop` / `service:install` / `service:restart`: view, stop, reload, or restart your personal service. Restart it after changing `.env`.
- `npm run retry -- <task ID>`: stop the service, requeue a failed task, then reload the service.
- `npm run run:local -- --prompt-file /absolute/path/prompt.txt`: run a local simulation; add `--publish` to explicitly create a real draft.
- `npm run preview -- /absolute/path/article.md`: generate a local preview without calling a model or WeChat. Image paths are limited to the task directory; standalone input may use public image URLs.

Data is stored in `runtime/` and logs in `~/Library/Logs/source2draft/`. For a backup, stop the service and copy the complete `runtime/` directory, including adjacent database files; restart after restoration. Removing the service does not delete content, and articles and history are not cleaned up automatically.

The service and maintenance commands use a dedicated exclusive lock at `.local/instance-lock.sqlite`. The system releases it when the process exits or is forcibly ended; **never delete the lock file to unlock it**. It contains no business data and cannot be replaced with `runtime/runs.db`. When upgrading from the older socket lock, stop the old service and confirm its process has exited before starting this version.

Each task's `metrics.jsonl` is an append-only performance record, and `upload-receipts.json` retains receipts for successfully uploaded images. Both remain with the task directory. Image receipts are isolated by WeChat account, file content, and purpose. Draft creation is still governed by the operation record and `media_id` in the database; an unknown result is only verified.

After power, wake, network, and login are available, the service can run while the screen is locked or off. Sleep, closing the lid, logout, and shutdown can interrupt it; queued work resumes after the next login. The application does not change system power settings.

For an existing installation, renaming the local manifest does not automatically update the Slack app's display name in Slack. Continue mentioning the already installed bot; identity checks still use the Bot ID, workspace, channel, and user.
