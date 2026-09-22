# Source2Draft

**Source-grounded research, faithful translation, and WeChat drafts.**

在个人 Slack 的 `#general` 中 @Source2Draft，让它按提示词搜索、分析和写作，或忠实直译网页/PDF，然后创建个人公众号草稿。**不正式发表文章。**

从来源材料到可审阅草稿。本项目在本机独立运行，使用独立凭据、SQLite 任务队列和可恢复的处理流程，保留来源、图表、公式和修订历史。

## 开始使用

需要 Node.js 22+、Chrome、Poppler（`pdfinfo`、`pdftotext`），以及个人 DeepSeek、Exa、Datalab、Slack、公众号凭据。

```bash
git clone https://github.com/clarachen07/source2draft.git
cd source2draft
npm ci
npm run setup
npm run check:config
```

按 [账号接入指南](docs/SETUP.md) 完成个人账号配置、模拟验收和微信测试草稿。默认 `HUB_DRY_RUN=true`，不会写入微信。填好配置前不能启动服务。

## 行为

- 搜索写作：理解提示词 → 读取提供材料 → 中英双语检索 → 写作 → 事实与引用核查 → 朴素排版 → 微信草稿。
- 直译：指定链接或 PDF → 确定页码/章节 → 验证原文结构 → 按块翻译和保存进度 → 完整性核查 → 微信草稿。原图、公式、代码和引用保留；表格保留原文图片。
- 公共 GitHub 仓库首页读取 README；具体文件读取 `blob` 链接，不宣称自动审阅整个仓库。
- 任务线程可补充、修改、取消和重试。上传前的修改替换旧修订；已完成后的修改创建新草稿，旧草稿保留。
- 重复投递的取消和重试不会重新作用于新修订。最新明确的翻译来源、附件文件名和封面选择覆盖旧选择。
- 每项任务保存在 `runtime/runs/<任务 ID>/`：`article.md`、`preview.html`、来源记录、模型用量和必要断点。
- 材料读取和搜索最多三路并行，逐项保存进度；不变的已通过复核与已成功上传图片在同任务恢复时复用。`metrics.jsonl` 记录阶段耗时、重试和缓存命中，不包含提示词、正文或密钥。
- 公众号响应丢失时先核对远端；无法唯一确认则暂停，避免重复上传。已创建的草稿不会因 Slack 通知失败改记失败。
- 只响应配置的本人、个人工作区和公开 `#general`，不读取历史任务进行补发。重启恢复已入队任务。

## 命令

| 命令 | 用途 |
| --- | --- |
| `npm start` | 手动运行 Slack 服务 |
| `npm run check` | 语法、隔离检查、离线测试、依赖审计 |
| `npm run check:connections` | 检查 Slack、模型列表和微信草稿读取，不写入草稿 |
| `npm run status` | 最近任务与错误 |
| `npm run test:wechat -- --create-test-draft` | 创建并回读【接入测试】草稿 |
| `npm run run:local -- --prompt-file /path/prompt.txt` | 在本机执行模拟任务；`--publish` 创建真实草稿 |
| `npm run preview -- /path/article.md` | 生成本机 HTML 预览 |
| `npm run retry -- <任务 ID>` | 停止服务后将失败任务重新入队 |
| `npm run service:install` | 安装/加载个人登录自启服务 |
| `npm run service:stop` | 停止并卸载当前运行实例，保留配置 |
| `npm run service:restart` | 重启已加载的服务 |
| `npm run service:uninstall` | 移除自启项，保留全部文章和数据 |

## 本机运行

服务名为 `com.source2draft.content-hub`。登录后常驻；接电、开盖、联网时，锁屏或熄屏不影响运行。关闭终端和 Codex 不影响已安装服务。不更改系统电源设置，合盖/睡眠/退出登录会中断服务。

数据和密钥不提交到 Git；默认不自动删除历史。备份与恢复说明见接入指南。

## 实现与验证

`src/core/` 管理任务、证据与 DeepSeek；`src/triggers/` 处理 Slack；`src/workflows/` 处理搜索写作和严格直译；`src/channels/` 仅对接微信草稿。

DeepSeek 的四个阶段可分别配置模型，默认均为 `deepseek-flash`，开启高强度思考。输出截断、无效结构化结果、原文不完整及高置信度核心事实问题会阻止上传。轻微不确定项记录并通知复核。外部材料不具备指令权限。

真实验收必须使用个人账号完成一篇分析和一篇带图表/公式的指定范围 PDF 直译，再验证草稿回读、Slack 通知及常驻运行。离线测试不能代替此验收。

2026-09-22 的稳定性、安全边界与性能迭代结果见 [验证记录](docs/VALIDATION.md)。

已有安装升级时，本地 manifest 改名不会自动更新 Slack 后台的机器人显示名。继续 @ 已安装的机器人即可，身份限制仍按 Bot ID、工作区、频道和用户校验。
