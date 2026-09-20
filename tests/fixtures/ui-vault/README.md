# The `yan ui` fixture vault

Ten tasks whose report is known in advance, for `tests/integration/ui.test.ts` and
for anything that renders the report and checks its numbers. Read-only: a test
copies it before pointing yan at it. Every time in `task.json` is noon UTC, so the
local day is the same from UTC-11 to UTC+11.

A task's deliverables are its `deliverable.json`, written by `yan deliverable` and
by nothing else. `brief.md` is the title line and prose: it is never parsed for
deliverables, and a task with no record shows nothing at all where its squares would
be, whatever its brief says: the cell stays so the dates keep their column, and the
page puts no word where the work would be.

Every deliverable here is written as the requirement it is: present tense, the
product as the subject, what has to be true when the work is done. Never a test, a
fix, a document or a step of the process — those belong in `log.md`, and a fixture
that reads like a log teaches the page's readers to write one.

| id | state | project | started | completed | record (done · to do · abandoned) | what it is for |
| --- | --- | --- | --- | --- | --- | --- |
| t001 | open | site | 09-01 | | 2 · 2 · 1, done 09-10 (`PR #12`), 09-15 (`PR #13` `PR #14`) | the ring at 2/4; all three statuses in one opened row; several refs on one item; an abandoned deliverable with its reason; a brief with two paragraphs and two bullets |
| t002 | done | ledger | 08-03 | 08-20 | 3 · 0 · 1, done 08-05, 08-12 (`MR !87`), 08-20 (`PR #31` `PR #32 <!-- squashed -->`) | `</script><!--` and `$&` in the brief, in a deliverable, in a reason and in a ref |
| t003 | done | ledger | 07-01 | 07-15 | no record; an old two-section `brief.md` with `- [x]` lines | an empty squares column: the checkbox lines are not parsed and the row does not open |
| t004 | done | none | 06-10 | 06-30 | no record, no brief, no units | `project: null`; an empty squares column; a done task delivers once on its completion day |
| t005 | abandoned | site | 07-20 | 08-01 | 0 · 1 · 0 | abandoned, listed but never Finished |
| t006 | done | yan | 2025-12-20 | 01-08 | 2 · 0 · 0, done 2025-12-30, 2026-01-05 (`MR !9`) | deliveries either side of a year boundary |
| t007 | open | yan | 09-05 | | `deliverable.json` does not validate (`status: "shipped"`) | one broken record is a task with none, and does not fail the command |
| t008 | open | none | | | `task.json` is not JSON: title `""` | one unreadable task does not fail the command |
| t009 | done | site | 09-08 | 09-12 | 2 · 0 · 0, done 09-09 (no refs), 09-12 (`PR #53`) | a delivered item with nothing proving it |
| t010 | open | site | 09-14 | | an empty record | a record that exists and holds nothing is a task with none |

All dates are 2026 unless written otherwise.

## Deliveries

Eleven: a done deliverable on its `doneAt`, or a done task with no record on its
completion day (t003, t004). An abandoned task, an abandoned deliverable and a
task whose record does not validate deliver nothing.

| day | project | from |
| --- | --- | --- |
| 2025-12-30 | yan | t006 |
| 2026-01-05 | yan | t006 |
| 2026-06-30 | (none) | t004 |
| 2026-07-15 | ledger | t003 |
| 2026-08-05 | ledger | t002 |
| 2026-08-12 | ledger | t002 |
| 2026-08-20 | ledger | t002 |
| 2026-09-09 | site | t009 |
| 2026-09-10 | site | t001 |
| 2026-09-12 | site | t009 |
| 2026-09-15 | site | t001 |

## The numbers for a range

Ranges that end before the day the report is made, so none of them depends on it
beyond In progress being `—`:

| range | Finished | Delivered | by project |
| --- | --- | --- | --- |
| 2026-08-01 – 2026-08-31 | 1 (t002) | 3 | ledger 3 |
| 2026-09-01 – 2026-09-15 | 1 (t009) | 4 | site 4 |
| 2025-12-01 – 2026-09-15 | 5 (t002 t003 t004 t006 t009) | 11 | site 4, ledger 4, yan 2, none 1 |

In progress, on a range that runs to today, is 4: t001, t007, t008, t010.

Rows that open: t001, t002, t005, t006, t009 — the five with a record that holds
something. The other five show nothing in the squares column and are not buttons.
