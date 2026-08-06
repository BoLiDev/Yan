# 4. 记忆系统

## 4.1 记忆的授权差别

`user.md` 和 `learnings` 的授权不同，理由：learnings 写错代价小（下次发现就改），每次都问会导致根本不写；`user.md` 是关于人的判断，写错会持续误导。所以 learnings 允许 `yan` 自主写（重写式、带日期、带证据），`user.md` 只在 `user` 明确要求时写。

每条记忆的「谁写 / 何时写 / 谁读 / 何时读」完整清单见 [附录 A](appendix.md#附录-a--记忆读写契约)。

## 4.2 `log.md` — 叙事层

JSON 装不下「做到哪了」；单独维护一份 `progress.md` 又会跟各个 `outcome.md` 迟早对不上。所以用 append-only 的一行式日志：

```markdown
# t042 统一鉴权 header

- 08-04  s1 auth       实现 header 解析          → !31 合入集成分支
- 08-05  s2 auth       接入 auth header          → !33 合入集成分支
- 08-06  s3 auth       修 CI 报的类型错          → !35 合入集成分支
- 08-07  auth       对外 MR !88 → release/bigproject
- 09-01  决策       改为往 master 合（大项目稳定期结束）
```

append-only 所以永不冲突；一行一条所以成本几乎为零；`user` 和 agent 读同一份—想知道情况 `cat log.md` 就够，不用拼二十个 `outcome.md`。它也是新 `shift` 的上下文来源：生成 brief 时整个塞进去（足够短）。

## 4.3 artifact

理由是硬的：公司仓库是多人协作的，不能随便塞东西。 prototype html、设计文档、截图、性能图表、调研数据—项目相关，但不该进仓库。

由此得出一条硬约束：artifact 必须写在 worktree 之外。

因为 worktree 要被 `yan tree return` 清空。`shift` 如果把 prototype 写在树里，两种结局都糟：被清掉，或者被 commit 进公司仓库。所以 spawn 时注入 `YAN_TASK_DIR=$YAN_HOME/tasks/<id>`，brief 明确要求产物写 `$YAN_TASK_DIR/artifacts/`。这条同时挡掉「agent 顺手把设计文档提交进公司仓库」这类事故—对多人仓库来说这个防护比省上下文更重要。

它的寿命跟 `task` 目录一样长，不随 `shift` 下工删除—价值恰恰在任务结束之后。主要读者是 `user`，所以需要 `yan open <id>` 直接打开目录或在浏览器里看 html。索引 0→1 不做，靠目录和文件名，多到找不着再说。

和 `report.md` 的界线：report 是结论（给 agent 读、给未来 intake 复用）；artifacts 是产物本身（给人看的东西）。一个 prototype html 属于 artifacts，「这个 prototype 验证了什么」属于 report。

## 4.4 不存什么

临时路径、会变的版本号、复制过来的状态快照；repo 自己就能说明的东西（代码结构、git history—那属于 repo 的 `AGENTS.md`）；任何 git 或 GitLab 已经作为 source of truth 持有的东西。
