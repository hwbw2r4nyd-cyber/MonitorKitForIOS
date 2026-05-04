# App Store 监控面板（MonitorKitForIOS）

按 **bundleId** 调用公开 **iTunes Lookup API**，在可配置时段内由 **GitHub Actions** 定时执行 **Python**；版本变化或长期无版本变动时通过 **Resend** 邮件提醒；**GitHub Pages** 展示中英文界面与配置；**Cloudflare Worker** 负责安全地把前端修改写回仓库中的 `config.json` / `state.json`（监听开关、增删应用等）。

约束：**不自备 VPS**；敏感信息只出现在 **GitHub Secrets** 与 **Worker 环境变量**（及浏览器本地存储中的 Worker 密钥，由用户自行保管）。

---

## 仓库结构

| 路径 | 说明 |
|------|------|
| `config.json` | 时区、监听窗口、间隔、默认语言等 |
| `state.json` | 应用列表、商店缓存、版本流水、`meta` |
| `scripts/check.py` | 检查脚本（仅标准库） |
| `.github/workflows/app-store-monitor.yml` | 定时检查 Workflow |
| `.github/workflows/deploy-pages.yml` | 将 `web/` 部署到 GitHub Pages |
| `web/` | Pages 静态前端 |
| `worker/` | Cloudflare Worker + `wrangler.toml` |

---

## 行为说明（与规格对齐）

### 监听开关

- **不会**因版本变动次数自动停监。
- `versionChangeCount` **仅展示**：仅在「相对上一次记录的 `lastKnownVersion` 字符串发生变化」时 `+1`，不参与关停逻辑。
- `monitoring` 仅由网页 Toggle 修改（经 Worker 写回仓库）。
- 新增应用默认 `monitoring: true`。

### 检查逻辑（Python）

- 数据源：`https://itunes.apple.com/lookup?bundleId=...`
- 仅处理 `monitoring === true` 的条目。
- 有结果 → `listingStatus: "listed"`；无结果 → `"not_listed"`（保留上一次缓存字段便于展示）。
- **首次**成功读到商店版本（建立基线）：写入商店版本、`trackName`、图标、`currentVersionReleaseDate` 等；**不**增加 `versionChangeCount`，**不**发版本更新邮件；并将 `lastVersionChangeAt` 记为**本次观测时间**（UTC ISO），用于后续「长期无变动」自然日计算起点。
- **非首次**且 `storeVersion !== lastKnownVersion`：`versionChangeCount += 1`，更新 `lastKnownVersion` 与展示字段，`history` 追加 `{ version, recordedAt }`，更新 `lastVersionChangeAt`，发送 **版本更新** 邮件；并将 `lastStaleNotifyAt` **清空**（`null`），下一次 stale 提醒重新按新的变动时间起算。
- **版本更新时间（前端展示口径）**：优先显示 **`currentVersionReleaseDate`**（商店字段）；若缺失则回退为 **`lastVersionChangeAt`**（最近一次记录的版本变动时间）。卡片上 tooltip 会标明当前采用的是哪一种。

### 监听时段与间隔

- 默认：**北京时间** `09:00–19:00`，间隔 **60** 分钟（见仓库根目录 `config.json`）。
- Workflow 建议 **每 15 分钟** 触发一次；脚本内：
  - 若当前时刻 **不在** `window`（按 `timezone`）→ **跳过**，不写 `state.json`，正常退出。
  - 若距 `meta.lastScheduledRunAt` **不足** `intervalMinutes` → **跳过**，同上。
  - 否则执行完整检查；结束后更新 `meta.lastScheduledRunAt` 与 `meta.dataUpdatedAt`。

### 「半个月无变动」邮件（Stale）

- 实现选用 **自然日**：以 `config.timezone`（默认 `Asia/Shanghai`）将 UTC 时间换算成日历日后，计算 `lastVersionChangeAt` 至当前的 **日期差**。
- 条件：`monitoring === true`、当前仍在架且有可比版本字符串、`listingStatus === "listed"`，且自 `lastVersionChangeAt` 起已满 **15 个自然日**，且版本字符串相对基线 **未再变化**。
- **防刷屏**：记录 `lastStaleNotifyAt`。发出一封 stale 邮件后，需再隔 **15 个自然日** 才可能发下一封。
- **版本一旦发生变动**：除清空 `lastStaleNotifyAt` 外，`lastVersionChangeAt` 已更新为变动时刻，自然重新满足「15 天无变动」的计时起点。

### 邮件（Resend）

GitHub Secrets：

| Secret | 说明 |
|--------|------|
| `RESEND_API_KEY` | Resend API Key |
| `RESEND_FROM` | 已验证发件地址（如 `notify@你的域名`） |
| `NOTIFY_EMAIL` | 收件人 |

未配置密钥时脚本 **跳过发信**，仍会更新 `state.json`。

---

## GitHub Actions 配置

1. 在仓库 **Settings → Secrets and variables → Actions** 中配置上述 Resend 相关 Secrets。
2. 默认使用 **`GITHUB_TOKEN`**（`permissions: contents: write`）推送 `state.json`。若组织策略禁止推送，可改用具备 `contents: write` 的 PAT，并在 Workflow 中自行替换鉴权方式（本仓库采用最常见默认可用配置）。
3. Workflow：**cron `*/15 * * * *`** + **`workflow_dispatch`**。

手动在前端点「刷新」**不会**触发 Actions，仅从 Worker（或你可自行改为 raw JSON URL）重新拉取数据。

---

## GitHub Pages（两点说明）

### 为什么界面里找不到「文件夹 /web」？

从 **分支** 部署 Pages 时，GitHub **只允许** 网站根目录为仓库的 **`/`（根）** 或 **`/docs`**，**没有**「`/web`」这个选项。要让源码继续放在 `web/` 又不挪文件夹，请用本仓库自带的 **GitHub Actions 部署**：

#### A. 推荐：用 Actions 发布 `web/`（与本仓库一致）

1. 打开 GitHub 仓库 → **Settings（设置）** → 左侧 **Pages**。
2. **Build and deployment（构建与部署）** 里，**Source（来源）** 选 **GitHub Actions**（不要选 “Deploy from a branch”）。
3. 把包含 `.github/workflows/deploy-pages.yml` 的提交推到 **`main`**；或在 **Actions** 里手动运行一次 **Deploy Pages (web/)**。
4. 等该 Workflow 绿勾完成后，回到 **Settings → Pages**，页面顶部会显示站点地址，一般为：
   - 用户站：`https://<你的用户名>.github.io/<仓库名>/`
   - 具体以 Pages 里显示的 **Visit site** 为准。

之后只要你改 `web/` 下的文件并 push 到 `main`，会自动重新部署（也可在 Actions 里手动 **Run workflow**）。

#### B. 备选：不用 Actions，只用分支部署

把 `web/` 里的文件**复制或移动**到仓库的 **`docs/`** 目录（GitHub 只认这个名字），然后在 **Settings → Pages** 里选：**Branch `main` + Folder `/docs`**。

---

### 浏览器里「Worker URL + API 密钥」怎么填？（第三点）

前提：你已经用 `wrangler deploy` 部署过 Worker，并已执行：

```bash
npx wrangler secret put WORKER_API_SECRET
```

这里录入的 **WORKER_API_SECRET** 建议自行生成一串足够长的随机字符（和密码一样保管）。

操作步骤：

1. 用浏览器打开 **GitHub Pages 给你的站点地址**（见上一节）。
2. 点击顶部 **Settings（设置）**。
3. **Worker 根 URL**：填 Worker 的公网地址，**不要**末尾斜杠。  
   - 部署成功后终端里会看到类似：`https://app-store-monitor-api.<子域>.workers.dev`  
   - 若你有自定义域名，则填自定义域名，例如 `https://monitor-api.example.com`
4. **Worker API 密钥**：填 **与 Cloudflare 里 `WORKER_API_SECRET` 完全相同的字符串**（不是 GitHub Token）。
5. 点 **Save settings（保存设置）**：会把这两项存进浏览器 **本地（localStorage）**，并尝试从 Worker 拉取/写回 `config.json`。  
   - 若 CORS 报错：把 Worker 环境变量 **`ALLOWED_ORIGIN`** 改成你的 Pages 完整 origin（例如 `https://wendeqiang.github.io`），或与仓库子路径一致时使用 **`https://<用户>.github.io/<仓库名>`**（需与实际打开地址一致），重新部署 Worker。
6. 回到 **Apps** 视图，点 **Refresh（刷新）** 加载列表。

可选：在 `web/index.html` 里取消注释 `window.APP_CONFIG`，预先写好 `apiBase` / `defaultLocale`，减少第一次在设置里粘贴 URL 的步骤。

---

## Cloudflare Worker

目录：`worker/`。

### 环境变量（`wrangler.toml` 与 Secret）

| 变量 | 说明 |
|------|------|
| `GITHUB_TOKEN` | Fine-grained PAT：目标仓库 **Contents 读写** |
| `GITHUB_OWNER` | 仓库所有者 |
| `GITHUB_REPO` | 仓库名 |
| `GITHUB_BRANCH` | 分支（如 `main`） |
| `WORKER_API_SECRET` | 静态密钥；请求头 `Authorization: Bearer <值>` |
| `ALLOWED_ORIGIN` | CORS；生产建议填 Pages 完整 origin，`*` 仅调试 |

### 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/state` | 读取仓库 `state.json` |
| GET | `/config` | 读取仓库 `config.json` |
| POST | `/api/v1` | 写操作（需 Bearer），JSON body 见下 |

`POST /api/v1` 示例：

```json
{ "action": "saveConfig", "config": { ...完整 config.json } }
{ "action": "setMonitoring", "bundleId": "com.example.app", "monitoring": true }
{ "action": "addApp", "bundleId": "com.example.app" }
{ "action": "deleteApp", "bundleId": "com.example.app" }
```

部署：

```bash
cd worker
npx wrangler deploy
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put WORKER_API_SECRET
```

---

## 本地试运行脚本

```bash
python3 scripts/check.py
```

需在仓库根目录执行；若不在监听窗口或未到间隔，脚本会打印跳过原因并 **不写文件**。

---

## 验收对照摘要

- 北京窗口外不跑实质检查；间隔受 `intervalMinutes` 约束。
- 版本变化邮件与 15 天 stale（自然日 + `lastStaleNotifyAt` 冷却）行为见上文。
- 无自动停监；`versionChangeCount` 只增展示用。
- 列表展示 **完整 bundleId**；Tab（全部 / 已上架 / 未上架）、中英文与设置写回 Worker。
- 手动刷新与后台定时检查互不干扰。

---

## 依赖

- **Python**：标准库（`urllib`、`json`、`datetime`、`zoneinfo`、`pathlib`）。
- **Worker**：无 npm 依赖，仅需 Wrangler CLI 部署。
- **前端**：原生 HTML/CSS/JS，无构建步骤。
