# 用 GitHub Actions 部署 Uptimer

[English](deploy-github-actions.md) | 中文

在 GitHub 上 Fork Uptimer，进入 Fork 的 **Actions** 并启用工作流。以后用 **Sync fork** 更新代码，部署仍由你在 **Actions → Deploy to Cloudflare** 手动发起。

## 1. 配置两个 Secrets

进入 Fork 的 **Settings → Secrets and variables → Actions → New repository secret**，添加：

| Secret                 | 填写内容                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN` | 在 [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) 使用 **Edit Cloudflare Workers** 模板，把范围限定在部署账户，添加 **D1 / Edit**。默认使用 Pages，还需 **Cloudflare Pages / Edit**。 |
| `UPTIMER_ADMIN_TOKEN`  | 首装填一个高强度随机密钥。升级填当前用于管理后台的密钥，部署会保留已配置的 Worker Secret。                                                                                                                     |

默认使用 Workers + Pages。若要把前端和 API 都部署在同一个 Worker，首装前添加仓库变量 `UPTIMER_DEPLOY_MODE=single_worker`。升级时沿用已有的托管方式和运行配置。自定义名称、域名或登录路径见[配置参考](configuration-reference.zh-CN.md)。

## 2. 生成计划

在 **Actions → Deploy to Cloudflare → Run workflow** 选择要部署的分支，设置 `release_action=plan`。首次部署选 `operation=install`，已有站点选 `upgrade`。首装由工作流创建资源。

等待计划完成，在 **Summary** 核对账户、Worker、数据库、Pages 项目（如果使用）和待执行迁移。计划只读取云端。看到 **BLOCKED** 时，按摘要中的原因处理。旧版实例有待执行的 D1 迁移时，先看[升级与恢复](upgrade-and-recovery.md)。

## 3. 部署并打开站点

在相同源码提交上再次运行工作流，选择 `release_action=apply`，保持 `operation` 和托管方式一致。将计划摘要中的 **Plan run ID** 和 **Plan SHA-256** 分别填入 `plan_run` 和 `plan_hash`。提交有变动时重新生成计划。执行会使用已审阅的构建产物。

部署与验收通过后，在 **Summary** 打开状态页，访问 `/admin`（或自定义路径），用 `UPTIMER_ADMIN_TOKEN` 登录。

## 遇到问题

- **无法确定 Cloudflare 账户**：如果 API 无法列出账户，或返回了多个账户，添加仓库变量 [`CLOUDFLARE_ACCOUNT_ID`](https://developers.cloudflare.com/fundamentals/setup/find-account-and-zone-ids/) 再运行计划。能查到唯一账户时会自动使用它。
- **找不到已有的 Worker**：先确认分支和 `UPTIMER_WORKER_NAME`。通常从线上 Worker 的 `DB` 绑定识别数据库。若是首装中断、数据库已经创建但 Worker 尚未部署，核对回执中的数据库 UUID，将其填为 `UPTIMER_D1_ID`，再用 `upgrade` 生成计划。
- **Worker 成功、Pages 失败，或验收未通过**：在失败运行中查看 **`uptimer-release-receipt`**，按[升级与恢复](upgrade-and-recovery.md)处理。计划产物保留 30 天。团队可以为 **`cloudflare-release`** 环境配置审批，审批仍在手动执行之后生效。
