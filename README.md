# yan

单人用的软件工作编排系统：提出一件要做的事，yan 把它拆成可派发的活，
派给一次性的 sub-agent 在隔离的 git worktree 里完成，最后交付成 MR。

状态：**设计阶段**，尚未开始实现。

## 从哪儿开始读

设计的主干是 [docs/design/INDEX.md](docs/design/INDEX.md)，
它是通读一遍就能讲清楚 yan 怎么运作的那一份，各环节的细节由旁边的分册承接。

其余几份文档按问题分列如下：

| 问题 | 文档 |
| --- | --- |
| 为什么这么设计，以及每个环节负责什么 | [docs/design/INDEX.md](docs/design/INDEX.md) |
| 某一环的完整论证（记忆、agent、监督、分支、worktree、交付、边界、范围） | `docs/design/` 里对应的那一份，INDEX 每一节末尾都给了链接 |
| 代码放在哪、谁能调谁、怎么测 | [docs/design/architecture.md](docs/design/architecture.md) |
| 按什么顺序做，每块必须自带哪些用例 | [docs/implementation-plan.md](docs/implementation-plan.md) |
| 某个决定是什么时候定的，当时手上有什么 | [docs/decisions.md](docs/decisions.md) |

## 约定

- 章节编号在拆分前后完全一样，变的只是它们分散在 `docs/design/` 的哪个文件里；
  正文里引用某一节的时候，都会带上一个可以点的链接。
- 跨文档引用要写清楚是哪份文档的哪一节（写成 design 或 architecture 再加节号），
  而裸写的节号指的是当前这份文档。
- `docs/` 同时也是设计讨论的工作区，讨论产生的 artifact（MD / HTML）都放在这里。
