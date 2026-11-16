/**
 * v2.0 SSR 页面的最小夹具：只保留抽取函数依赖的结构与类名（从真实页面裁出来再精简）。
 * 这些字符串只用于 smoke，不联网。
 */

export const leaderboardHtml = `<!doctype html><html><head><title>模型榜 | AI 模型排行榜</title></head><body>
<h1>模型榜 | AI 模型排行榜</h1>
<h2>综合榜<span class="mono text-[12px] text-ink-3">50 个模型</span></h2>
<table class="w-full"><thead><tr><th>名次</th><th>模型</th><th>上线日期 ▲</th><th>评测覆盖 ▲</th><th>缓存价格</th><th>输入价格</th><th>输出价格</th><th>AIHOT 评分</th></tr></thead>
<tbody>
<tr>
  <td><span class="mono text-[13px]">01</span></td>
  <td class="py-3"><img src="/model-providers/anthropic.svg" alt="" width="20" /><a href="/leaderboard/claude-fable-5-2"><strong class="text-[15px]">Claude Fable 5.2</strong></a><small class="hidden text-[12px] text-ink-3 side:block">Anthropic</small><small class="block truncate text-[12px] text-ink-3 side:hidden">Anthropic · <span class="num">11月9日</span>上线</small></td>
  <td class="mono text-ink-3">2026-11-09</td>
  <td class="text-[12.5px]">40 项评测<span class="text-ink-3">覆盖 <!-- -->78<!-- --> %</span></td>
  <td class="mono">¥1.33</td>
  <td class="mono">¥53.35</td>
  <td class="mono">¥266.73</td>
  <td><strong class="mono text-[15px]" aria-label="Claude Fable 5.2 AIHOT 评分 80.4">80.4</strong><small class="text-[11px] text-ink-3">覆盖 <!-- -->78<!-- -->%</small></td>
</tr>
<tr>
  <td><span class="mono text-[13px]">02</span></td>
  <td class="py-3"><img src="/model-providers/google.svg" alt="" width="20" /><a href="/leaderboard/gemini-4-carbon"><strong class="text-[15px]">Gemini 4 Carbon</strong></a><small class="hidden text-[12px] text-ink-3 side:block">Google</small><small class="block truncate text-[12px] text-ink-3 side:hidden">Google · <span class="num">10月28日</span>上线</small></td>
  <td class="mono text-ink-3">2026-10-28</td>
  <td class="text-[12.5px]">30 项评测<span class="text-ink-3">覆盖 <!-- -->62<!-- --> %</span></td>
  <td class="mono">¥1.33</td>
  <td class="mono">¥26.67</td>
  <td class="mono">¥133.37</td>
  <td><strong class="mono text-[15px]" aria-label="Gemini 4 Carbon AIHOT 评分 77.2">77.2</strong><small class="text-[11px] text-ink-3">覆盖 <!-- -->62<!-- -->%</small></td>
</tr>
</tbody></table>
<section class="card" aria-labelledby="lb-pending-title">
<h2 id="lb-pending-title">暂不排名<span class="mono text-[12px] text-ink-3">9 个模型</span></h2>
<p>这些模型已有评分。评测达标且榜单收录官方 API 价格或公开权重后，会给出名次。</p>
<ul class="divide-y">
<li><a class="group flex" href="/leaderboard/gemini-4-hydrogen"><img src="/model-providers/google.svg" alt="" width="18" /><span class="block truncate"><span class="block truncate text-[13.5px] font-medium">Gemini 4 Hydrogen</span><small class="block text-[11.5px] text-ink-3">评测数量还不够<!-- --> · <!-- -->19<!-- --> 项评测</small></span><span class="mono text-[18px]">73.6</span></a></li>
<li><a class="group flex" href="/leaderboard/muse-wonder-full"><img src="/model-providers/meta.svg" alt="" width="18" /><span class="block truncate"><span class="block truncate text-[13.5px] font-medium">Muse Wonder Full</span><small class="block text-[11.5px] text-ink-3">本轮未收录官方 API 价格或公开权重 · 29 项评测</small></span><span class="mono text-[18px]">70.4</span></a></li>
</ul></section>
</body></html>`

export const freeTokensHtml = `<!doctype html><html><head><title>免费额度</title></head><body>
<section aria-label="我的卡册" class="mt-6"><h2>我的卡册</h2><span class="text-[13px] text-ink-3">57 张，还没收</span>
<p class="text-[13px] text-ink-3">今天还能领</p><p class="mono text-[20px]">¥<!-- -->598</p>
<ul><li class="ft-slot"><button type="button" title="豆包 200额度，还没领，查看领取说明" aria-label="豆包 200额度，还没领，查看领取说明"><span class="ft-cd-val">200额度</span></button></li>
<li class="ft-slot"><button type="button" title="混元 100额度，已领，查看领取说明" aria-label="混元 100额度，已领，查看领取说明"><span class="ft-cd-val">100额度</span></button></li></ul>
</section>
<section aria-label="每天都能领" class="mt-6"><h2>每天都能领</h2><ul class="card overflow-hidden">
<li class="flex scroll-mt-20">
  <span class="mt-1 shrink-0"><img src="/favicons/doubao.png" alt="" width="20" /></span>
  <button type="button" aria-expanded="false" class="group min-w-0 flex-1 text-left"><span class="flex flex-wrap items-baseline gap-x-2"><span class="text-[15px] font-semibold text-ink">豆包电脑版每天签到领 200 额度</span></span><span title="豆包电脑版和豆包工作电脑版里的非 Pro 模型可用，每天一次" class="mt-1 block truncate text-[12px] text-ink-3">豆包电脑版和豆包工作电脑版里的非 Pro 模型可用，每天一次</span></button>
  <div class="ml-auto flex shrink-0 items-start gap-2"><span title="每天 · 未有适用的额度单独售价，不折钱" class="mono min-w-16 text-right text-[20px] font-semibold text-accent">200 额度</span><div class="flex flex-col items-end"><a href="https://mp.weixin.qq.com/s?__biz=abc&amp;mid=123" target="_blank" rel="noopener noreferrer" class="text-[12px] text-accent">去领 <svg class="inline" width="10" height="10"></svg></a></div></div>
  <div hidden="" class="basis-full sm:pl-[56px]"><div class="rounded-tile bg-well"><p class="mb-1.5"><span class="text-[12px] text-ink-2"><b>适用模型：</b>豆包电脑版非 Pro 模型</span></p><p class="text-[12.5px] text-ink-2">每天登录客户端签到即可领取。</p><p class="mt-1.5 text-[12.5px] text-ink-2">有效期：<!-- -->发放后 30 天</p></div></div>
</li>
</ul></section>
<section aria-label="每月都能领" class="mt-6"><h2>每月都能领</h2><ul class="card overflow-hidden"><li class="flex"><button type="button" aria-expanded="false" class="group"><span class="flex flex-wrap"><span class="text-[15px] font-semibold text-ink">Kimi 每月领 15 元额度</span></span><span title="每月一次，Kimi 网页版可领" class="mt-1 block text-[12px] text-ink-3">每月一次，Kimi 网页版可领</span></button><div class="ml-auto"><span title="每月 · 折合 15 元" class="mono text-[20px] text-accent">15 元</span></div></li></ul></section>
<section aria-label="其他福利" class="mt-6"><h2>其他福利</h2><ul class="card overflow-hidden"><li class="flex"><button type="button" aria-expanded="false" class="group"><span class="flex flex-wrap"><span class="text-[15px] font-semibold text-ink">学生认证送 500 额度</span></span><span title="一次性，需学生认证" class="mt-1 block text-[12px] text-ink-3">一次性，需学生认证</span></button><div class="ml-auto"><span title="一次性 · 折合 50 元" class="mono text-[20px] text-accent">50 元</span></div></li></ul></section>
</body></html>`

export const resetCalendarHtml = `<!doctype html><html><head><title>重置监控</title></head><body>
<h1>重置监控</h1>
<h2>上一次重置卡发放：11月13日（按预计时间）</h2>
<dl><dt>重置间隔中位数</dt><dd>2 天</dd><dt>上次额度重置</dt><dd>10月28日</dd></dl>
<section aria-labelledby="calendar-title"><h2 id="calendar-title">重置日历</h2><p>点日期查看当天的重置、发卡和原帖。</p>
<noscript><nav aria-label="历史重置记录"><a href="/codex-reset/history/2026-11-13">11月13日</a><a href="/codex-reset/history/2026-10-28">10月28日</a></nav></noscript>
<div class="mt-4"><div class="mono">2026 年 11 月</div><div class="text-[12px] text-ink-3">本月 发重置卡 3 次</div></div>
<div role="grid" aria-label="2026 年 11 月重置记录，方向键可切换日期">
<a href="/codex-reset/history/2026-11-13" role="gridcell" data-day="2026-11-13" tabindex="-1" aria-selected="false" aria-label="2026-11-13，发重置卡（已生效），今天"><span class="num text-[13px]">13</span><span class="rounded-mark bg-ok-ink/[0.14] text-ok-ink">发重置卡</span></a>
<a href="/codex-reset/history/2026-11-12" role="gridcell" data-day="2026-11-12" tabindex="-1" aria-selected="false" aria-label="2026-11-12，额度重置（已生效）"><span class="num text-[13px]">12</span><span class="rounded-mark bg-ok-ink/[0.14] text-ok-ink">额度重置</span></a>
<a href="/codex-reset/history/2026-11-11" role="gridcell" data-day="2026-11-11" tabindex="-1" aria-selected="false" aria-label="2026-11-11"><span class="num text-[13px]">11</span></a>
</div></section>
</body></html>`

const agentTab = (id, title, desc, clients) =>
  `<a href="${id === 'skill' ? '/agent' : `/agent?tab=${id}`}" role="tab" id="agent-tab-${id}" aria-selected="${id === 'skill' ? 'true' : 'false'}"><span class="text-[13px] font-medium text-ink">${title}</span><span class="mt-3 text-[15.5px] font-semibold text-ink">${title}</span><span class="mt-1 text-[13px] text-ink-3">${desc}</span><span class="mt-2 hidden text-[12px] text-ink-3">${clients}</span></a>`

const agentPanel = (id, label, heading, copies) =>
  `<div id="agent-panel" role="tabpanel" aria-labelledby="agent-tab-${id}"><div class="mono text-[11.5px] uppercase">${label}</div><h2>${heading}</h2>${copies
    .map((text) => `<pre class="mono"><code>${text}</code></pre>`)
    .join('')}</div>`

export const agentPages = [
  `<!doctype html><html><body><h1>把 AIHOT 接进你的 Agent</h1>
<main><div role="tablist" aria-label="接入方式">
${agentTab('skill', 'Agent Skill', '装一次，以后不用再更新', 'Claude Code、Codex、Gemini CLI、OpenCode')}
${agentTab('mcp', 'MCP', '填一个地址，多出 11 个工具', 'Claude 桌面版、Cursor 等远程 MCP 客户端')}
${agentTab('rss', 'RSS', '复制地址，用阅读器订阅', 'Reeder、Folo、Inoreader、n8n')}
${agentTab('api', 'REST API', '匿名 GET，自己写程序取数', '脚本、机器人、小程序、看板')}
</div>
${agentPanel('skill', 'Agent Skill · 2.0.0', '装一次，以后不用再更新', ['请安装 AIHOT Skill：https://aihot.news/aihot-skill/README.md', 'npx skills add aihot'])}
</body></html>`,
  `<!doctype html><html><body><main><div id="agent-panel" role="tabpanel" aria-labelledby="agent-tab-mcp"><div class="mono text-[11.5px] uppercase">MCP · 2.0.0</div><h2>填一个地址，Agent 多出 11 个工具</h2><pre class="mono"><code>claude mcp add --transport http aihot 'https://aihot.news/api/mcp?aihot_actor=actor-1'</code></pre></div></main></body></html>`,
  `<!doctype html><html><body><main><div id="agent-panel" role="tabpanel" aria-labelledby="agent-tab-rss"><div class="mono text-[11.5px] uppercase">RSS</div><h2>复制地址，用阅读器订阅</h2>
<div class="card flex flex-col p-4"><div class="flex items-center gap-2"><span class="text-[15px] font-semibold text-ink">精选摘要</span></div><p class="mt-1 flex-1 text-[13px] leading-[1.7] text-ink-3">50 条，带标题与摘要</p><div class="mt-3 flex items-center gap-2 border-t border-line-soft pt-3"><code class="mono min-w-0 flex-1 truncate text-[12px] text-ink-4">https://aihot.news/feed.xml</code></div></div>
<div class="card flex flex-col p-4"><div class="flex items-center gap-2"><span class="text-[15px] font-semibold text-ink">精选全文</span></div><p class="mt-1 flex-1 text-[13px] leading-[1.7] text-ink-3">50 条，含全文</p><div class="mt-3 flex items-center gap-2 border-t border-line-soft pt-3"><code class="mono min-w-0 flex-1 truncate text-[12px] text-ink-4">https://aihot.news/feed/full.xml</code></div></div>
<div class="card flex flex-col p-4"><div class="flex items-center gap-2"><span class="text-[15px] font-semibold text-ink">全部动态</span></div><p class="mt-1 flex-1 text-[13px] leading-[1.7] text-ink-3">近 7 天</p><div class="mt-3 flex items-center gap-2 border-t border-line-soft pt-3"><code class="mono min-w-0 flex-1 truncate text-[12px] text-ink-4">https://aihot.news/feed/all.xml</code></div></div>
<div class="card flex flex-col p-4"><div class="flex items-center gap-2"><span class="text-[15px] font-semibold text-ink">AI 日报</span></div><p class="mt-1 flex-1 text-[13px] leading-[1.7] text-ink-3">每天</p><div class="mt-3 flex items-center gap-2 border-t border-line-soft pt-3"><code class="mono min-w-0 flex-1 truncate text-[12px] text-ink-4">https://aihot.news/feed/daily.xml</code></div></div>
<div class="card flex flex-col p-4"><div class="flex items-center gap-2"><span class="text-[15px] font-semibold text-ink">AI 周报</span></div><p class="mt-1 flex-1 text-[13px] leading-[1.7] text-ink-3">每周</p><div class="mt-3 flex items-center gap-2 border-t border-line-soft pt-3"><code class="mono min-w-0 flex-1 truncate text-[12px] text-ink-4">https://aihot.news/feed/weekly.xml</code></div></div>
<div class="card flex flex-col p-4"><div class="flex items-center gap-2"><span class="text-[15px] font-semibold text-ink">AI 月报</span></div><p class="mt-1 flex-1 text-[13px] leading-[1.7] text-ink-3">每月</p><div class="mt-3 flex items-center gap-2 border-t border-line-soft pt-3"><code class="mono min-w-0 flex-1 truncate text-[12px] text-ink-4">https://aihot.news/feed/monthly.xml</code></div></div>
</div></main></body></html>`,
  `<!doctype html><html><body><main><div id="agent-panel" role="tabpanel" aria-labelledby="agent-tab-api"><div class="mono text-[11.5px] uppercase">REST API · 2.0.0</div><h2>匿名 GET，拿来就能用</h2><pre class="mono"><code>curl --compressed -A 'aihot-api/2.0.0 aihot-actor/actor-1' 'https://aihot.news/api/v1/items?mode=selected&amp;window=24h'</code></pre></div></main></body></html>`,
]
