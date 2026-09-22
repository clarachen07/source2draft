# 个人账号接入

所有操作仅针对个人账号和本项目。不要复制其他项目的 `.env`。

## 1. 填写模型、搜索、PDF key

运行 `npm run setup`，在本项目 `.env` 填写个人 `DEEPSEEK_API_KEY`、`EXA_API_KEY`、`DATALAB_API_KEY`。默认使用 `deepseek-flash`。密钥只放在本机，不发到 Slack 或聊天中。

## 2. 创建个人 Slack App

1. 打开 https://api.slack.com/apps ，选择 **Create New App → From a manifest**。
2. 选择你的**个人工作区**，导入项目根目录的 `slack-app-manifest.json`。
3. 在 **Basic Information → App-Level Tokens** 新建 token，勾选 `connections:write`，将 `xapp-…` 填入 `SLACK_APP_TOKEN`。
4. 在 **OAuth & Permissions** 安装到个人工作区，将 Bot User OAuth Token `xoxb-…` 填入 `SLACK_BOT_TOKEN`。
5. 确认 **Socket Mode** 开启；**Event Subscriptions** 包含 `app_mention`、`message.channels`。修改权限后重新安装。
6. 在个人 `#general` 输入 `/invite @Source2Draft`。
7. 将个人工作区 `T…`、本人用户 `U…`、频道 `C…` ID 分别填入 `SLACK_TEAM_ID`、`SLACK_USER_ID`、`SLACK_CHANNEL_ID`。用户资料菜单可复制用户 ID，频道详情可复制频道 ID，Slack 网页地址 `app.slack.com/client/T…/C…` 含工作区和频道 ID。

权限用于接收 @指令、线程补充/编辑、下载附件和发送任务状态。程序不主动读取历史消息，不开放私信入口，不处理其他用户。

## 3. 个人公众号

登录 https://mp.weixin.qq.com ，在账号开发/基本配置相关页面查看 AppID 和 AppSecret，分别填入 `WECHAT_APP_ID` 与 `WECHAT_APP_SECRET`。后台名称可能随账号变化。不要修改其他账号的 Secret。

运行 `npm run check:config`，再运行 `npm run check:connections`。后者检查个人 Slack、模型列表及公众号认证与草稿读取，不创建草稿，也不发 Slack 消息。

若微信返回接口权限或 IP 配置错误，按该个人账号后台的实际提示处理。每个账号都需要独立检查权限；程序不会替你修改平台账号或网络配置。

## 4. 验证与启用

1. `npm run check`：离线测试和依赖检查。
2. 保持 `HUB_DRY_RUN=true`，运行 `npm start`，在 `#general` @机器人发送一条写作要求，再发送一条含页码范围的 PDF 直译任务。
3. 检查 Slack 结果提示和任务目录的 `preview.html`、`article.md`、`research-trace.json`。模拟模式仍有模型、搜索和 Datalab 调用费用。
4. 停止手动实例，运行 `npm run test:wechat -- --create-test-draft`，创建一篇带【接入测试】标题的真实草稿并回读。测试草稿保留在后台，不自动删除。
5. 将 `HUB_DRY_RUN=false`，运行 `npm run service:install`。在 Slack 发起真实写作和 PDF 直译任务，确认草稿箱结果。所有文章仅创建草稿，从不调用正式发布接口。

如果账号凭据或权限尚未就绪，代码和离线测试可以完成，但真实端到端验收及常驻服务安装仍待完成。

## 日常使用

```text
@Source2Draft 搜索最近的研究，解释 AI 工具如何改变个人学习。面向非技术读者，约 1800 字。
@Source2Draft 只根据这个链接写一篇个人学习笔记，不额外搜索：https://example.com/article
@Source2Draft 直译这个 PDF 的第 2–5 页：https://example.com/paper.pdf
@Source2Draft 根据附件分析…… 封面：https://example.com/cover.png
```

原任务线程可直接补充要求；已完成任务修改后会创建新草稿。上传中或上传结果未确认时，先等待或发送“重试”核对，再发送修改要求。

“取消任务”停止尚未上传的任务；“重试”恢复失败任务或核对结果不明确的上传。离线期间的新指令不主动补处理，请上线后重新发起。

## 运行与恢复

- `npm run status`：查看最近任务，包含错误和 media_id。
- `npm run service:status` / `service:stop` / `service:install` / `service:restart`：查看、停止、重新加载或重启个人服务。改 `.env` 后需重启。
- `npm run retry -- <任务 ID>`：先停止服务，再将失败任务重新入队，然后重新加载服务。
- `npm run run:local -- --prompt-file /绝对路径/prompt.txt`：本机模拟运行；加 `--publish` 明确创建真实草稿。
- `npm run preview -- /绝对路径/article.md`：生成本地预览，不调用模型或微信；图片路径仅允许当前任务目录，独立输入可使用公开图片 URL。

默认数据在 `runtime/`，日志在 `~/Library/Logs/source2draft/`。备份时先停服务，复制整个 `runtime/`（包括数据库伴随文件），恢复后重新启动。卸载服务不删除内容。文章和历史没有自动清理。

服务与维护命令使用 `.local/instance-lock.sqlite` 的独立排他锁；进程退出或被强制结束后由系统释放，**不要通过删除锁文件来解锁**。锁文件不包含业务数据，不能用 `runtime/runs.db` 替代。升级旧版 socket 锁时，必须先停止旧服务并确认进程退出，再启动新版。

每个任务的 `metrics.jsonl` 为追加式性能记录，`upload-receipts.json` 保存已成功上传的图片回执；二者随任务目录保留。图片回执按公众号账号、文件内容和用途隔离；草稿创建仍以数据库中的操作记录和 `media_id` 为准，结果不明确时仅核对。

接电、开盖、联网、登录后服务可在锁屏熄屏时运行。休眠、合盖、退出登录或关机均可能中断；重启后登录自动恢复已入队任务。程序不修改系统电源设置。

已有安装升级时，本地 manifest 改名不会自动更新 Slack 后台的机器人显示名。继续 @ 已安装的机器人即可，身份限制仍按 Bot ID、工作区、频道和用户校验。
