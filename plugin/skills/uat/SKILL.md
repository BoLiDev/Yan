---
name: uat
description: Use once an implementation is done and its result can be verified interactively, in a task kept by yan. Shoots the before and the after of each deliverable, records them with `yan uat`, gives a link to try it when it is checked on the web, builds the report the user checks the task on, and hands the task to the user. Use it again after each round of the user's feedback, and when the user wants to see or share what a task delivered.
---

# uat

The user accepts a task by checking each deliverable against what you show them: a screenshot, a recording or a note for each, gathered **deliverable by deliverable** rather than as a sweep of the product, and a report that puts each under the deliverables it shows. This skill does it all in one pass, after the implementation, so what is shot is what the report needs.

Run it again after each round of feedback: shoot again what changed, record it, render the report again. The task stays 验收中 through those rounds until the user closes it.

## 1. Decide what shows each deliverable

`yan context` lists the deliverables, `yan uat` what is already recorded. For each one not given up, choose:

- **A change to something on screen**: a before and an after of the same view, at the same size, with the same data, so they read side by side.
- **Something that did not exist before**: one file, recorded as new.
- **Something that happens over time**, a flow, an animation, steps that depend on each other: a recording.
- **Nothing on screen can show it**, an exit code, a file format, what a server answers: a note saying how it was checked and what was seen. A terminal's output can often be shot all the same; prefer that.

One file may show several deliverables. **Never record a file for a deliverable it does not show**, to fill a gap.

## 2. Shoot the before

The before is the product as it was before the task. Don't undo your work for it: run the code from where the task's branch left the default branch, in a directory of its own, for each repository the change is in.

```sh
base=$(git merge-base origin/<default branch> HEAD)
git worktree add --detach <scratch>/before "$base"
```

Install and build it there as the project's own instructions say, start it on a port of its own, shoot each view, then stop it and `git worktree remove <scratch>/before`. When the old version cannot be run, tell the user why there is no before rather than passing something else off as one.

## 3. Shoot the after

The worktree as it is now, the same views as the before, in the same order.

For a web page, Playwright is the tool: the project's own when it has it, otherwise `playwright-core` installed in a scratch directory, driving the browser already on the machine (`chromium.launch({ channel: 'chrome' })`). Shoot at a device scale factor of 2. Wait for the page to be ready by what is on it, a selector or a text, not by the network falling quiet: a page with a live connection never does.

## 4. Record

Record with Playwright's `recordVideo`, which writes webm at 25 frames a second. Pause about a second between steps so a viewer can follow, and keep it to what the deliverable needs.

**Every recording says what is happening as it happens**: a black pill with white text, centred at the top or the bottom of the page, changed at each step, in the user's language. Put it where it covers nothing the step shows: at the bottom, unless what the step shows is down there (a toast, a footer, a bar of buttons), and then at the top, below the page's own top bar. It can move from one step to the next. Put it in the page itself, so it is in the recording without editing the video afterwards. It goes when the page navigates, so set it again after each load.

```js
// at: 'bottom' or 'top'; move `top` down when the page's own bar is taller than 72px.
async function caption(page, text, at = 'bottom') {
  await page.evaluate(([text, at]) => {
    let pill = document.getElementById('uat-caption');
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'uat-caption';
      Object.assign(pill.style, {
        position: 'fixed', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483647',
        padding: '8px 18px', borderRadius: '999px', background: 'rgba(0,0,0,.82)', color: '#fff',
        font: '600 15px/1.4 system-ui, sans-serif', pointerEvents: 'none', whiteSpace: 'nowrap',
      });
      document.body.append(pill);
    }
    pill.style.top = at === 'top' ? '72px' : '';
    pill.style.bottom = at === 'top' ? '' : '32px';
    pill.textContent = text;
  }, [text, at]);
}
```

### A white screen at the start

A large project on Vite's dev server serves thousands of modules one after another, and a recording opens on a long white screen while they load. Cut it off by finding the second the page appears:

1. **Decode.** With Playwright's own ffmpeg (under its browser cache: `ms-playwright/ffmpeg-*/`, installed by `npx playwright install ffmpeg`), decode the first 40 seconds into PNGs scaled to 480 px wide: `ffmpeg -i rec.webm -t 40 -vf scale=480:-1 frames/%05d.png`.
2. **Measure.** With `pngjs`, take for each frame the share of dark pixels, grey below 160, under the page's top bar. A loading frame is about 0%, the real page about 0.9%; the threshold is **0.3%**.
3. **Find the second.** The first frame over the threshold, counted from 0, divided by **25**, is the second the page starts: Playwright decodes at a fixed 25 frames a second.
4. **Cut and check.** Encode again from that second (`ffmpeg -ss <second> -i rec.webm -c:v libvpx -b:v 2M out.webm`) and delete the original. Take the first frame of the result and measure it the same way: if it is still white, or a spinner, the cut was wrong, so do it again.

## 5. Record each file as it is made

Save into the task's artifacts/uat/ (`yan context` names the folder), named for what it shows: `d3-before.png`, `d3-after.png`, `d3.webm`, and `d2-d3-after.png` for one showing two. Record it at once:

```sh
yan uat add d3-before.png --for d3 --before "<what it shows>"
yan uat add d3-after.png --for d3 --after "<what it shows>"
yan uat add d5.webm --for d5 --new "<what it shows>"
yan uat note --for d6 "<how it was checked and what was seen>"
```

Say what it shows in the user's language, in a line: what is on screen and what to look at. `yan uat` lists every deliverable with what it has; one with nothing is what the user will notice first.

## 6. A link to try it

When the result is checked by opening it on the web, try to give the user a link that opens it: the version with this work, at the place the change is seen, with whatever the URL needs to reach that version. How to get one depends on where it is deployed; this skill leaves that to whatever knows the platform.

Keep as few as will do: **one for the task**, not one per deliverable or per place on the same page. Another only for a wholly different app or page. Open each once before keeping it: a link that does not show this version is worse than none.

Keep each with `yan resource add preview "<what it opens>" <url>`, named for what it opens, the app or the page. A newer link for the same thing goes under the same name and replaces the old one, so each stays the latest that works; `yan resource ls` shows the names kept, and `yan resource rm` takes off one nothing needs any more. The report lists them as the last row of its header. When there is none, say why when you hand over.

## 7. Build the report

The report is one page per task: what the task was about, then every deliverable with what shows it is true. The user checks the deliverables against it in `yan serve`, and drags it into a document for others. A script builds the page; you write only its words.

Files in uat/ that nothing records are left out; record one that shows a deliverable first. A deliverable checked by a note gets its heading and text and no pictures: the page reports what was delivered, and the note stays in yan for the user.

Read `yan context` and `yan log` until you understand the task, then write a `content.json` in a scratch directory, never in the vault:

```json
{
  "title": "df blade app",
  "problem": "One paragraph.",
  "approach": ["…", "…", "…"],
  "summaries": { "d1": "用邀请码注册，换设备看到同一份数据" },
  "texts": { "d1": "…" },
  "reasons": { "d5": "…" }
}
```

Write it all in **the user's language**.

- **title**: what the work is about, as the people reading it call it: a product, a page, a feature. Not the task id.
- **problem**: one short paragraph that lets a reader who knows nothing of the task follow the rest of the page: how things were, and what was wrong with that. It is not the analysis from the start of the task, and it leaves how it was solved to the approach. No headings, no lists.
- **approach**: how the problem was solved, as a few points, each a sentence or two. The page puts them as a numbered list under the problem, after the fixed sentence 解决以下问题，我们采用如下方案：, so do not write that sentence yourself. A point is a part of the solution as a reader would put it, not a deliverable restated.
- **summaries**: for every deliverable not given up, a few words saying what it is, short enough to read as a heading. The deliverable's own text is shown under it, so do not repeat it. The page numbers them by place and adds the id after each, so leave both out.
- **texts**, **reasons**: only when the deliverables or the reasons for giving one up are written in another language. A faithful translation each, nothing added.

Write nothing a reader can see for themselves: no captions under images, no "these share one recording". Then render:

```sh
node <this skill's folder>/scripts/render.mjs content.json
```

It writes `artifacts/report.html` and `artifacts/report.json` in the task's folder, replacing any earlier ones. The deliverables, their state, the resources and which file goes under which deliverable all come from yan; the images go inside the page, and recordings become links to the vault's repository. A refusal names what content.json is missing.

## 8. Hand it over

Once every deliverable is built and has its evidence, run `yan uat ready`: the task is 验收中, with the user to check. Give the user the report's path and the links to try it, and say which deliverables have nothing to check them by, and why.

Leave the deliverables' state alone: whether each is done is the user's call, made on the report.
