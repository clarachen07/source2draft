# Source2Draft

- Develop only this project. Other local projects are read-only references: do not modify them, run their scripts, or use their credentials or databases.
- Support only two content flows: general search writing and faithful translation. The `llm-quant-daily` profile is an internal scheduled research-writing profile, not a third content flow. Do not load company writing skills, brand templates, newsletters, Discord, or unrelated scheduled-article workflows.
- Articles may create WeChat drafts only. Do not integrate a publishing API.
- Slack must match the personal workspace, channel, and user. Top-level messages must mention the bot; thread context comes only from registered tasks.
- Daily scheduling uses fixed PST (UTC−08:00) at 17:00, with an explicit enablement start, one canonical issue per date, bounded catch-up, and isolated dry-run previews. Slack connection failures must not stop the scheduler or daily worker.
- New daily data providers must consume free resources only. A local usage limit does not prove a shared provider account has free credit remaining. Unverified free eligibility disables that provider; continue with public sources. DeepSeek inference is separate from this data-provider restriction.
- Persist each daily Slack root-notification operation before its single remote write, then persist its `ts` immediately. Disable SDK write retries. Recover a lost response only by its unique marker among that bot's bounded messages for the registered daily operation; an unclear result stays `needs_review` and is never blindly resent. This receipt lookup must not become historical article context.
- A draft creation for the same revision may make only one request with an ambiguous result. Persist the operation before the remote write; persist `media_id` immediately and read it back before retrying. Editing a completed article creates a new revision and draft.
- Supplied material takes priority. A request to use only supplied material prohibits expanded search. A faithful translation must not fill missing source text with search results.
- External URLs use the secure downloader. Send Slack tokens only to permitted Slack-file addresses and strip authentication on cross-origin redirects.
- Never include real credentials in logs, test samples, or commits. Store personal credentials only in this project's `.env` with mode `0600`.
- The authorized Codex CLI model route uses its existing ChatGPT login, managed by Codex itself. Never copy its tokens into this project or change global Codex configuration. Isolate model calls, disable tools/plugins/hooks, and pause failures without automatic API fallback.
- Each task has an independent directory. Maintenance commands and the persistent service share a single-instance lock. Failure recovery does not delete user content.
- Run `npm run check` after changes. Image, formula, or layout changes also require a rendered check. Report real connections and draft acceptance separately; never present simulated results as production success.
