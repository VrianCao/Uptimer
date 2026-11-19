# Upgrade and recovery / 升级与恢复

This release changes sample storage and scheduling. **Cloudflare Worker, D1 and Pages changes are not one transaction.** Do not describe a retry as a rollback, and do not restore a database automatically after a frontend failure.

本次更新涉及样本存储与调度。Worker、D1、Pages 不构成跨产品事务；重试不是回退，前端失败也不应自动恢复数据库。

## Upgrading from `0014` / 从 `0014` 升级

**Run Plan and then Apply** using the same source commit and keep the current hosting mode and runtime profile. Plan shows the existing D1 and the pending migrations. For the supported `0014` schema, Apply switches the same Worker to maintenance mode, records a D1 Time Travel bookmark, and migrates the existing database. The public homepage shows the last saved data and its original timestamp. Probes and admin writes pause during the migration.

**按原流程生成 Plan，再手动执行 Apply。** 沿用现有托管方式和运行配置。对于支持的 `0014` 旧库，Action 会在原 Worker 上进入维护模式，记录 D1 恢复点并迁移原库。公开首页展示最后一次保存的数据和原更新时间。迁移期间暂停探测与后台写入。

If Apply stops, re-run **the same Apply run** with its original reviewed plan. Completed SQL files stay recorded in D1. Apply checks the migration prefix and Worker identity before resuming, then verifies that public data advances again. A different plan reports that maintenance is already in progress. Keep the original plan artifact available during recovery. Each retry uploads its own receipt, with the attempt number in its name.

Apply 中断时，在 GitHub 上重新运行**原 Apply**。Action 按 D1 已记录的迁移前缀继续，已经提交的文件会被跳过。完成后会验证探测恢复及公开数据重新更新。保留原 Plan 产物，维护中生成的新计划会提示续跑原流程。每次重跑会上传带有本次尝试编号的独立回执。

The upgraded database continues to reject writes from obsolete Worker invocations, even after the new Worker resumes. Its original database ID and existing Worker secrets are preserved. Restoring D1 separately requires deciding how to handle writes and notifications made after the recovery point. [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

新版恢复探测之后，D1 仍会拒绝迟到的旧版写入。数据库 UUID 和现有 Worker Secrets 会保留。如果确实需要恢复数据库，应先确认恢复点之后的数据与通知如何处理。

## Other recovery cases / 其他恢复场景

| Situation / 状态                                        | Action / 处理                                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Build or planning fails                                 | Resolve the error and create a new plan. / 排查错误后重新生成计划。                                                                                                                        |
| Plan blocks an unsupported schema or migration sequence | Keep the current site online and inspect the tracker and receipt. / 保持当前站点在线，核对迁移记录和回执。                                                                                 |
| First install creates D1 before the Worker deploys      | Verify the database UUID and use it in a new `upgrade` plan. / 核对原库 UUID 后生成 `upgrade` 计划。                                                                                       |
| Worker deployed, Pages failed                           | Keep Worker and D1, then retry the reviewed Apply. If a new Pages project appeared after Plan, verify its project ID first. / 保留后端与 D1 后重试，先核对 Plan 之后新建的 Pages 项目 ID。 |
| Public data fails freshness verification                | Check the receipt and retry once the active Worker and D1 match the reviewed plan. / 查看回执，核对线上 Worker 和 D1 后再续跑。                                                            |

## Runtime/hosting switches / 执行路径与托管切换

Free/Paid is explicit configuration, not an inferred subscription. For Free→Paid, added Cron expressions can take time to propagate; old Free code must be proven to ignore auxiliary events, then all six actual events must be observed before switching. Paid→Free must account for overlapping in-flight schedulers and monitor claims. These switches must not be combined with a schema upgrade. The existing Dev-only Cron preparation tools are evidence for that specific tested environment, not a generic production switch permit. [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

Free→Paid 先证明当前 Free 入口会忽略辅助 Cron，再准备并真实观察全部事件传播，最后切执行路径。Paid→Free 也须处理在途调度重叠；本轮通用 apply 不自动切 profile。Paid 保留 class 导出/migration 历史但不绑定 coordinator，运行路径不调用项目 DO。

Switching Pages↔Workers Assets also changes origin, asset routing, authentication trust and which old frontend stays live. Inventory redirects/domains/cached clients and rehearse this independently. Do not delete the old Pages project automatically.

## Recovery boundaries / 恢复边界

- Frontend: use only a previously verified **production** Pages deployment compatible with the current API; preview deployments are not rollback targets. Do not restore D1 for a frontend defect. [Pages rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/).
- Worker: prefer a verified compatible package or forward fix. Preserve DB identity, secret bindings and DO migration history. Retain the last known compatible package privately before rollout; a new candidate is not itself a tested emergency alternative.
- Data corruption: stop writes, preserve the scene and determine the accepted loss of data created after the restore point. D1 restore, branch/target switching and notification reconciliation require a separately approved incident plan. No automatic destructive recovery is implemented.
- Private artifacts: exports, admin/webhook secrets and recovery credentials must never be uploaded to public workflow artifacts, release attachments or issues. A release receipt is an audit record, not a backup.

前端回退、业务包前向恢复、数据恢复是三种不同操作。当前自动化只做可核对的部署续跑，不宣称跨产品原子回退或零数据损失。
