# Source2Draft

- Develop only this project. Other local projects are read-only references: do not modify them, run their scripts, or use their credentials or databases.
- Support only two content flows: general search writing and faithful translation. Do not load company writing skills, brand templates, newsletters, Discord, or scheduled-article workflows.
- Articles may create WeChat drafts only. Do not integrate a publishing API.
- Slack must match the personal workspace, channel, and user. Top-level messages must mention the bot; thread context comes only from registered tasks.
- A draft creation for the same revision may make only one request with an ambiguous result. Persist the operation before the remote write; persist `media_id` immediately and read it back before retrying. Editing a completed article creates a new revision and draft.
- Supplied material takes priority. A request to use only supplied material prohibits expanded search. A faithful translation must not fill missing source text with search results.
- External URLs use the secure downloader. Send Slack tokens only to permitted Slack-file addresses and strip authentication on cross-origin redirects.
- Never include real credentials in logs, test samples, or commits. Store personal credentials only in this project's `.env` with mode `0600`.
- Each task has an independent directory. Maintenance commands and the persistent service share a single-instance lock. Failure recovery does not delete user content.
- Run `npm run check` after changes. Image, formula, or layout changes also require a rendered check. Report real connections and draft acceptance separately; never present simulated results as production success.
