# `yan`

单人用的软件工作编排系统：提出一件要做的事，`yan` 把它拆成可派发的活，
派给一次性的 sub-agent 在隔离的 git worktree 里完成，最后交付成 MR。

状态：**设计阶段**，尚未开始实现。

## 从哪儿开始读

设计的主干是 [docs/design/INDEX.md](docs/design/INDEX.md)，
它是通读一遍就能讲清楚 `yan` 怎么运作的那一份，各环节的细节由旁边的分册承接。

其余几份文档按问题分列如下：

| 问题 | 文档 |
| --- | --- |
| 为什么这么设计，以及每个环节负责什么 | [docs/design/INDEX.md](docs/design/INDEX.md) |
| 某一环的完整论证（记忆、agent、监督、分支、worktree、交付、边界、范围） | `docs/design/` 里对应的那一份，INDEX 每一节末尾都给了链接 |
| 代码放在哪、谁能调谁、怎么测 | [docs/design/architecture.md](docs/design/architecture.md) |
| 按什么顺序做，每块必须自带哪些用例 | [docs/implementation-plan.md](docs/implementation-plan.md) |
| 某个决定是什么时候定的，当时手上有什么 | [docs/decisions.md](docs/decisions.md) |

## 约定

- 设计按主题分册放在 `docs/design/`，节号写在各分册的标题里，一套编号横跨所有分册，
  所以同一个节号在整个设计里只对应一处；分册之间互相引用就只写节号，配上一个能点过去的链接，
  读者不必先知道那一节住在哪个文件。
- 跨文档引用要写清楚是哪份文档的哪一节，写法是文档名再加节号，并且同样带上链接，
  例如 [`architecture.md` §3](docs/design/architecture.md#3-仓库结构)
  和 [`implementation-plan.md` §4](docs/implementation-plan.md#4-三个会挡路的东西)；
  文档名和锚点写在一起，两者就不会各自漂走。
- 不带链接的裸节号指的是当前这份文档自己的那一节，同一份文档内部的引用一律这么写。
  `docs/design/architecture.md` 自带一套 1–7 的编号，它在开头就声明了这条。
- `docs/` 同时也是设计讨论的工作区，讨论产生的 artifact（MD / HTML）都放在这里。
