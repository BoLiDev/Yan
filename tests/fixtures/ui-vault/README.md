# The `yan ui` fixture vault

Ten tasks whose report is known in advance, for `tests/integration/ui.test.ts` and
for anything that renders the report and checks its numbers. Read-only: a test
copies it before pointing yan at it. Every time in `task.json` is noon UTC, so the
local day is the same from UTC-11 to UTC+11.

| id | state | project | started | completed | deliverables (done · to do · dropped) | what it is for |
| --- | --- | --- | --- | --- | --- | --- |
| t001 | open | site | 09-01 | | 2 · 2 · 1, dated 09-10 (`PR #12`), 09-15 | the ring at 2/4; a second Description paragraph that is left out |
| t002 | done | ledger | 08-03 | 08-20 | 3 · 0 · 1, dated 08-05, 08-12 (`MR !87`), 08-20 (`PR #31`) | `</script><!--` and `$&` inside a deliverable |
| t003 | done | ledger | 07-01 | 07-15 | free-form brief | one square; a delivery on its completion day |
| t004 | done | none | 06-10 | 06-30 | no brief, no units | `project: null` |
| t005 | abandoned | site | 07-20 | 08-01 | 0 · 1 · 0 | abandoned, listed but never Finished |
| t006 | done | yan | 2025-12-20 | 01-08 | 2 · 0 · 0, dated `12-30` → 2025-12-30, `01-05` → 2026-01-05 | the year from the completion day |
| t007 | open | yan | 09-05 | | one unmarked bullet: `[]`, description null | a brief that is not guessed at |
| t008 | open | none | | | task.json is not JSON: title `""` | one unreadable task does not fail the command |
| t009 | done | site | 09-08 | 09-12 | 2 · 0 · 0; one undated, one 09-12 | a done item with no date; `PR #53 for …` not lifted |
| t010 | open | site | 09-14 | | an empty Deliverables list | in progress with nothing to count |

All dates are 2026 unless written otherwise.

## Deliveries

Ten: a delivered item on its date, or a done task with no deliverables on its
completion day (t003, t004). An abandoned task and an undated item deliver nothing.

| day | project | from |
| --- | --- | --- |
| 2025-12-30 | yan | t006 |
| 2026-01-05 | yan | t006 |
| 2026-06-30 | (none) | t004 |
| 2026-07-15 | ledger | t003 |
| 2026-08-05 | ledger | t002 |
| 2026-08-12 | ledger | t002 |
| 2026-08-20 | ledger | t002 |
| 2026-09-10 | site | t001 |
| 2026-09-12 | site | t009 |
| 2026-09-15 | site | t001 |

## The numbers for a range

Ranges that end before the day the report is made, so none of them depends on it
beyond In progress being `—`:

| range | Finished | Delivered | by project |
| --- | --- | --- | --- |
| 2026-08-01 – 2026-08-31 | 1 (t002) | 3 | ledger 3 |
| 2026-09-01 – 2026-09-15 | 1 (t009) | 3 | site 3 |
| 2025-12-01 – 2026-09-15 | 5 (t002 t003 t004 t006 t009) | 10 | site 3, ledger 4, yan 2, none 1 |

In progress, on a range that runs to today, is 4: t001, t007, t008, t010.
