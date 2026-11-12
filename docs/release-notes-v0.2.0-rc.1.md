# v0.2.0-rc.1 — draft / 发布说明草稿

**Draft only. No tag or public Release has been created.** Version naming remains subject to the final release decision.

候选更新聚焦 Free 套餐的资源预算与可感知性能，同时保留完整监控功能：

- 首屏使用预生成数据并校验新鲜度；数据陈旧、断网或刷新失败有明确状态，避免把快速显示误当作最新数据。
- 延迟曲线按需加载，恢复曲线动效并尊重系统“减少动态效果”设置；保留历史查询、状态与可访问交互。
- 样本持久化采用桶和当前小时缓冲，降低 D1 写量；Free 使用 Worker + SQLite DO 混合路径，Paid 可明确选择 Worker + D1 路径。
- 修复隐藏监控历史、事件/维护范围、同源认证路由和部署身份记录等问题。
- 部署先执行 CI 和四种配置构建，再审阅不可变包；重复 apply 跳过已完成部署，保留既有 Secret。

## Upgrade notice / 升级提示

Default hosting is still **Workers + Pages**. **Workers + Workers Assets** is optional through `UPTIMER_DEPLOY_MODE=single_worker`. Runtime profile is separate: `free` by default, `paid` explicitly selected. No automatic Cloudflare subscription detection.

旧版 `0014` 到候选 `0025` 存在存储布局迁移；**已有实例若尚有 migration 待执行，通用 Workflow 会停止 apply**，须先完成独立维护/恢复演练。禁止直接回退引入 DO 和新存储以前的 Worker。见[部署指南](deploy-github-actions.zh-CN.md)与[升级/恢复说明](upgrade-and-recovery.md)。

## Verified scope / 已验证范围

Dev 冻结业务版本 `40dc44e` 在实际 Paid 账户使用 Free profile + Pages。2026-11-10 16:43 至 11-11 16:43 UTC 固定窗口中：24 个运行监控每分钟完整 34,560 条探测，普通 Worker 1,684 次 CPU 最大 7ms，D1 后台实测 55,310 writes / 3,388,147 reads。详细证据见 `Develop/Dev-Day-Review-2026-11-12.md`；不要将该数据外推到任意规模、访问量或所有账户。

真实 Free 套餐的强制限额与完整云端旧版升级/恢复尚未验收；Pages CPU 目前是短窗样本，不能写成已有 24 小时历史证据。CI 冒烟也不能代替实机、外部通知完整旅程或下一次完整日级周期。公开稳定版放行前仍需补齐相应证据。

本说明不承诺无限访问、任意监控规模、绝对零费用或跨产品无损自动回滚。当前没有发布到 Public/Production。
