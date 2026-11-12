# Upgrade and recovery / 升级与恢复

This release changes sample storage and scheduling. **Cloudflare Worker, D1 and Pages changes are not one transaction.** Do not describe a retry as a rollback, and do not restore a database automatically after a frontend failure.

本次更新涉及样本存储与调度。Worker、D1、Pages 不构成跨产品事务；重试不是回退，前端失败也不应自动恢复数据库。

## Supported automated upgrades / 可自动执行的升级

An existing instance can use the reviewed package workflow when its migration tracker already matches all packaged migrations, and hosting/profile remain unchanged. Ordinary upgrades preserve D1 identity and secret bindings. The workflow serializes runs, verifies the package/source/config, skips matching completed stages, and records the actual final version after secret initialization. See [deployment guide](deploy-github-actions.md) / [中文部署指南](deploy-github-actions.zh-CN.md).

已有实例在迁移全部完成、hosting/profile 不变时，可使用计划/执行流程。重复相同已完成包不再执行迁移、部署或 Secret 写入；Worker 成功而 Pages 失败时，续跑只补未完成步骤。仍执行只读身份及新鲜度检查。

| Situation / 状态                                        | Required action / 处理                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Build/CI failure                                        | No deployment began. Fix source, create a new plan. / 未开始云端写入；修复后重新计划。                                                                                   |
| Plan lists pending migrations on an existing Worker     | **Blocked** before apply. Prepare and rehearse maintenance/recovery below. / 阻断，不自动迁移。                                                                          |
| First empty install interrupted during migrations       | Retain the new database and same plan; verify identity/prefix, resume remaining migrations. Never delete/recreate it to hide failure. / 保留原库和计划，核对前缀后续跑。 |
| Worker deployed, Pages failed                           | Keep Worker and D1; resume the same reviewed package. / 保留后端与数据库，续跑原包。                                                                                     |
| Secret initialization created another Worker version    | Receipt must record that final version. Normal upgrades do not reset the key. / 记录最终版本，普通升级不覆盖密钥。                                                       |
| All stages deployed, freshness smoke fails              | Preserve receipt and investigate; repeat smoke through the same apply if identities still match. Do not expand rollout. / 保留现场、排查数据前进，暂停扩大发布。         |
| Unrelated Worker/Pages version or target config changed | Stop; inventory and generate a new plan. / 停止，重新核对与计划。                                                                                                        |

## Legacy storage transition: stop gate / 旧存储升级：必须停下

The public baseline `a89f29e` has migrations through `0014`. The candidate includes `0015`–`0025`, introduces SQLite `SiteCoordinator` and changes `check_results` into a compatibility view over bucket/pending storage. A view accepting old SQL is not proof of equivalent behavior: old retention may perform many underlying sample writes while `changes()` reports zero. Re-deploying the unchanged legacy Worker is therefore not a safe emergency strategy.

公开旧基线 `a89f29e` 到本次候选有 `0015`–`0025` 迁移，并引入 `SiteCoordinator`。兼容视图只能说明部分旧 SQL 可执行，不能保证旧清理算法的行写成本和循环语义。**不得把直接 rollback 到旧版当作恢复方案。**

The generic workflow intentionally has **no `force` flag**, does not install an unverified maintenance bridge, and does not run these migrations against an existing Worker. A blocked plan remains useful: it contains the exact target, ordered migration hashes, package hashes and current versions. No production write has been authorized by preparing it.

本轮准备没有在云端执行旧库迁移、数据库恢复或临时桥接代码。已有 Dev 已完成 `0025`；它的日级验收不能替代旧版生产实例的首次升级演练。

Before enabling this path in a future reviewed change, complete all of the following **on authorized isolated resources** (do not create them implicitly):

1. Inventory the actual installed Worker/Pages versions, D1 UUID/migration tracker, bindings, custom domains, API trust pins and known current traffic. Preserve the historical extra `0014_check_results_without_autoincrement.sql` tracker entry if present.
2. Privately retain a D1 recovery point/export, reviewed source/package and a **tested emergency Worker compatible with the final schema and DO class history**. A Time Travel bookmark expires with the account's retention window; merely recording it does not extend recovery. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
3. Design a bounded maintenance interval: public reads remain usable with an explicit freshness/maintenance signal; admin writes are prevented; old Cron/batch/retention writers are drained, fenced and cannot restart while DDL is in progress. Prove this against the actual old scheduler lock contract. An in-memory flag or local computer staying awake is insufficient.
4. Inventory incidents/maintenance without linked monitors before `0025`. Existing unlinked history preserves its old global audience; newly orphaned monitor-scoped history must remain private. Resolve ambiguous historical intent explicitly rather than guessing.
5. Rehearse the ordered migration prefix on realistic legacy data, interrupt after each file and verify counts, timestamps, status/latency, pending samples, retention cost and history visibility. Do not edit published SQL or delete tracker records. Each completed migration may persist after a later file fails.
6. Verify DO registration and emergency package compatibility without routing new code to old schema prematurely. Never remove a DO class or its migration history merely to suppress a deploy warning. [Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
7. Rehearse Worker failure, Pages failure and recovery; measure the maintenance interval, data loss boundary and post-recovery notification deduplication. Retrying notification delivery against restored old state can send duplicates.
8. Obtain explicit authorization for the concrete production plan and maintenance interval, then execute it with a cloud-side guard independent of a sleeping developer laptop. Capture new receipts, immediate acceptance and the next full daily cycle before stable rollout.

旧版迁移与恢复属于可能改变数据语义、无法无损自动撤销的操作。完成上述演练和明确授权前，保持阻断；不能为“让 Workflow 变绿”绕过它。

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
