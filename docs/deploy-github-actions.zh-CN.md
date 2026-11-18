# GitHub Actions 部署指南

[English](deploy-github-actions.md) | 中文

新版流程先完成 CI、构建与计划审阅，再由独立的手动 apply 部署**同一份构建包**。普通 push 只跑 CI，不会自动更新线上。默认仍是 **Workers + Pages**；`single_worker` 是 **Workers + Workers Assets**。

## 支持范围与阻断边界

- 空实例首装：明确选择 `install`，使用尚未被占用的资源名（已存在的空 D1 也应选择 `upgrade` 并填写准确 UUID），创建指定名称的 D1、应用迁移、初始化缺失的管理 Secret，再部署 Worker 和前端。
- 已有实例：选择 `upgrade`，填写准确 D1 UUID。不会因为查不到数据库而新建替代库。同一包成功后重复 apply 跳过部署；Worker 成功、Pages 失败时可续跑。
- **已有 Worker 且 D1 尚有待执行迁移：只生成计划，阻断 apply。** 历史版本的升级包含探测样本物理存储布局变化，须先单独演练维护窗口和兼容新布局的前向恢复。没有跳过这一阻断的开关。
- 已有实例沿用当前 hosting 和 runtime profile。切换 Free/Paid 会生成阻断计划；切换 hosting 会停止规划。两者均需独立方案，见[升级与恢复说明](upgrade-and-recovery.md)。

Dev 的 `deploy.yml` 保留账户/资源硬校验和诊断入口。公开仓库应采用 [examples/deploy.yml](examples/deploy.yml) 的通用调用模板，不复制 Dev 凭据、固定资源和诊断工作流。共用实现为 `.github/workflows/release.yml` 与 `apps/worker/scripts/release*.mjs`。

## 配置

Node、pnpm 和依赖分别由 `.node-version`、`packageManager`、lockfile 固定；不在部署时升级。运行环境需要 Python 3.11+ 的标准库 `tomllib`，GitHub Ubuntu runner 已具备。

| Secret                  | 用途                                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | 限定目标账户；Workers Scripts Edit、D1 Edit，Pages 模式另需 Pages Edit。计划阶段只读取元数据及执行只读 D1 查询。                                            |
| `CLOUDFLARE_ACCOUNT_ID` | 必填准确账户 ID，也接受同名仓库 Variable；不再自动选择第一个账户。                                                                                          |
| `UPTIMER_ADMIN_TOKEN`   | 只在 `ADMIN_TOKEN` 缺失时初始化；用于部署后的 Worker 管理 API **只读**验收。保留所有已有 Secret，不在普通升级中轮换。必须与实际管理凭据一致，否则验收失败。 |
| `VITE_ADMIN_PATH`       | 可选管理路径；亦接受同名 Variable 或 `UPTIMER_ADMIN_PATH`。                                                                                                 |

| 仓库 Variable                                                     | 默认 / 说明                                                                                                                 |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `UPTIMER_D1_ID`                                                   | **升级必填**，准确的既有数据库 UUID；名称不能代替身份校验。                                                                 |
| `UPTIMER_PREFIX`                                                  | 默认仓库名的小写 slug。                                                                                                     |
| `UPTIMER_WORKER_NAME`、`UPTIMER_D1_NAME`、`UPTIMER_PAGES_PROJECT` | 单独覆盖资源名。                                                                                                            |
| `UPTIMER_DEPLOY_MODE`                                             | 默认 `pages`；可选 `single_worker`。                                                                                        |
| `UPTIMER_RUNTIME_PROFILE`                                         | 默认 `free`：Worker + SQLite DO 混合执行；`paid`：Worker + D1，无 coordinator binding。与前端托管方式独立，不自动识别套餐。 |
| `UPTIMER_WORKER_URL`                                              | 可选准确 HTTPS Worker origin（包括已配置的自定义域名）；否则读取 workers.dev 子域。需提前启用 workers.dev 或配置域名。      |
| `UPTIMER_API_BASE`、`UPTIMER_API_ORIGIN`                          | 沿用既有 Pages API 配置。默认浏览器调用同源 `/api/v1`，由 Pages 代理到 Worker；显式地址仍保留。                             |

数据库 binding 固定 `DB`，`SELF` 指向当前 Worker。高级运行参数修改规范配置 `apps/worker/wrangler.toml`，不要维护第二份生成配置。部署使用规范配置中的明文 vars，并保留已有 Secret；不要依赖仅存在 Dashboard、未纳入配置的明文变量。

Paid 账户选择 `free` 仍会使用 DO 包含量；需要纯 Worker/D1 路径时明确选择 `paid`。Paid 配置为 30,000ms CPU，但不能据此忽略墙钟时间、出站连接、存储和账户额度。Dev 在实际 Paid 账户上运行 Free profile，保留 30,000ms ceiling 供 DO 执行；其结果不等于真实 Free 套餐强制限额验收。参考 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)。

两种 hosting 均使用已冻结的业务实现，包括各自支持的首屏预载与新鲜度处理。Pages 的 API 代理会消耗相应 Pages Functions/Workers 调用量；`single_worker` 省去该代理跳转。hosting 不决定 runtime profile。

## 配置 GitHub

1. 添加以上 Secrets/Variables，人工核对账户、名称、D1 ID 和 API origin。
2. 为 **`cloudflare-release` Environment** 配置 required reviewers、允许部署的分支/tag 和凭据范围（取决于仓库类型及 GitHub 套餐）。限制谁能调度工作流、修改变量和凭据。**YAML 写了 Environment 名称不等于已经启用审批保护。** `cloudflare-plan` 是只读计划环境；若使用 Environment 级 Secret，也需为它提供读取所需凭据。
3. 分支保护要求 CI 通过。release 本身也会调用同一份 CI，涵盖 lint、typecheck、生成 binding 校验、历史迁移不可改写、功能/Cron 测试，以及四种配置构建。
4. 仅在可信源码 ref 运行：工作流会执行仓库中的代码并使用所配置的 Secret。此改动不会自动设置仓库保护策略或收窄 Token 权限。

## 计划 → 审阅 → 执行

1. 冻结一个提交，在 **Actions → Deploy to Cloudflare** 选择该 ref。
2. 运行 `release_action=plan`。公开模板另选 `operation=install|upgrade`；hosting 默认 `auto`，沿用仓库变量。Dev 固定升级现有资源。
3. 等待 CI 和 plan 完成，查看 Summary 并下载 **`uptimer-release-package`**。检查 `plan.json` 的仓库/源码、准确账户和资源 UUID、hosting/profile、迁移前缀与待执行清单、步骤及 blockers；检查 `manifest.json` 的文件哈希。**plan 成功可能包含 blocked，不能理解为已获准部署。**
4. 保持 ref 指向**同一提交**，再次手动运行 `release_action=apply`，填写 `plan_run=<刚才成功的手动计划 run ID>`、`plan_hash=<Summary 中完整 SHA-256>`。保持 operation、hosting、构建输入、Secrets/Variables 不变；即便后来只改了文档，提交 SHA 变了也应重新 plan。
5. apply 先校验 run 来源、源码、目标/配置/lockfile 和每个文件，再写入云端。下载已审阅 artifact，使用 Wrangler `--no-bundle`，审批后不重构建。线上身份漂移会停止。不同 ref/profile 对同一实例串行执行，不因新运行而取消进行中的 apply。不要在排队期间改变命名变量。
6. 如首次初始化 Secret，记录其产生的**最终 Worker version**；然后部署 Pages。部分失败也上传 receipt。验收覆盖首页 HTML/入口资源、公共 API、未认证 401、内部路由 404、Worker 直连管理读取，以及连续两次公共数据 publication 前进；200 但数据陈旧也失败。首次安装允许等待最多 15 分钟完成初始 Cron 传播/发布（只重试初始 502/503），随后须在 210 秒内观察到两次前进；已有站点异常立即失败。它不能代替浏览器 QA、实机、24 小时资源验收及 Pages 认证代理专项验收。

artifact 保留 **30 天**，也可能被提前删除；发布前私下保存已审阅包和 receipt。重跑 plan 会重新构建/观察并可能改变 hash，不能当作 apply 重试。只接受本仓库、同源码、成功手动计划的 artifact；不接受 fork PR 包。

首装时从 receipt 保存所分配的 D1 UUID，供后续 `upgrade` 使用。若 apply 在 Worker 部署前中断，核对 UUID 与已完成的迁移前缀，再针对同一个 D1 生成 `upgrade` 计划。已部署且匹配的 Worker 可凭包指纹与 D1 绑定识别续跑目标。如果新建 Pages 项目后首个部署未完成，请用 receipt 核对项目 ID，再审阅新计划。收据缺失或执行结果不明时，保留已分配的资源并先核查状态。

同一已成功包再次 apply 时，迁移、Worker、Pages 和 Secret 写入均跳过，仍会做只读身份与冒烟检查。跨产品没有原子事务；GitHub 队列取消、runner 故障或 API 超时仍可能中断，先核对 receipt 与线上身份再续跑。

## 故障处理

- 缺少 D1 ID/账户、迁移记录未知/重复/非前缀、渐进部署、尚未启用的 Worker candidate、hosting 改变或外部部署漂移：停止并核对，重新 plan。不要删除 tracker 记录强行通过；已知历史 `0014_check_results_without_autoincrement.sql` 记录会保留并明确识别。
- 已有迁移/profile 被阻断：按[升级与恢复说明](upgrade-and-recovery.md)处理，不运行旧自动部署入口绕过。
- Worker 成功、Pages 失败：保留 Worker 和 D1，续跑原包；不自动回退后端。
- Token 不一致：单独执行明确的凭据核对/轮换，普通重试不覆盖既有管理密钥。
- 冒烟失败：保存 receipt，排查实际版本与新鲜度；不扩大发布，不自动 Time Travel。部署步骤已完成时，续跑仍重新做冒烟。

数据库导出、管理密钥、Webhook Secret、恢复凭据不能进入公开 artifact/Release。包包含公开业务代码、配置和迁移；receipt 只记录标识和哈希，不包含 Secret 值。部署不会发布 GitHub Release，也不会修改 DNS/自定义域名。
