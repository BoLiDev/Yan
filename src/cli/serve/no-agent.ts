/**
 * What the agent tab shows while the task being read keeps no agent. yan
 * serve sends the tab beside it to each task's agent as the task is gone
 * to; for one with none it sends the tab here, so the tab never shows
 * another task's agent as if it were this one's. A cloud and one line
 * naming the task, nothing else: the tab moves on by itself, so there is
 * nothing to say of what to do. A long name gives way, never what it says.
 */

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

const CLOUD = '<path d="M17.5 19H8a6 6 0 1 1 5.66-8h1.84a4.5 4.5 0 0 1 2 8.5"/>';

export function noAgentPage(id: string, title: string | undefined): string {
  const name = title?.trim() || id;
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} 没有 Agent</title>
<style>
@font-face{font-family:"Yan Round";src:local("ChillRoundFRegular"),local("ChillRoundF Regular"),url("/fonts/yan-round-regular.woff2") format("woff2");font-weight:400}
@font-face{font-family:"Yan Round";src:local("ChillRoundFBold"),local("ChillRoundF Bold"),url("/fonts/yan-round-bold.woff2") format("woff2");font-weight:700}
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;background:#fff;font:15px/1.5 "Yan Round",system-ui,sans-serif}
main{display:flex;flex-direction:column;align-items:center;gap:14px;padding:40px;max-width:min(560px,100%);box-sizing:border-box}
svg{flex:none;color:#a3a29b}
h1{display:flex;max-width:100%;margin:0;font-size:18px;color:#1b1b19;white-space:nowrap}
h1 span{min-width:0;overflow:hidden;text-overflow:ellipsis}
h1 b{flex:none;font-weight:inherit;white-space:pre}
</style>
</head>
<body>
<main>
<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CLOUD}</svg>
<h1><span>${esc(name)}</span><b> 没有 Agent</b></h1>
</main>
</body>
</html>
`;
}
