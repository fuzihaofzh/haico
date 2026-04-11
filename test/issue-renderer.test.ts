import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { marked } from 'marked';

type RendererApi = {
  renderMd: (text: string, authorId: string) => string;
  _ctx: {
    issue: { project_id: string } | null;
    agents: Array<{ id: string; name: string }>;
  };
};

function esc(value: string): string {
  return String(value).replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[char] || char;
  });
}

function loadIssueRenderer(): RendererApi {
  const source = fs.readFileSync('public/js/issue-renderer.js', 'utf8');
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    console,
    marked,
    esc,
    roleAvatarHtml: () => '',
    avatarSvg: () => '',
    hashCode: () => 0,
    timeAgo: () => '',
    showConfirm: async () => true,
    showToast: () => {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    history: { back() {} },
    document: { addEventListener() {} },
    window: {},
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.IssueRenderer as RendererApi;
}

const renderer = loadIssueRenderer();
renderer._ctx.issue = { project_id: 'project-1' };
renderer._ctx.agents = [{ id: 'agent-1', name: 'haico-developer' }];

const emailHtml = renderer.renderMd('zihaofu@cuhk.edu.hk', 'user').trim();
assert.equal(
  emailHtml,
  '<p><a href="mailto:zihaofu@cuhk.edu.hk">zihaofu@cuhk.edu.hk</a></p>',
  '邮箱地址应保持为完整 mailto 链接',
);
assert.ok(!emailHtml.includes('&quot;'), '邮箱渲染不应泄漏 HTML 转义字符');
assert.ok(!emailHtml.includes('<span'), '邮箱渲染不应被 mention 高亮拆开');

const urlHtml = renderer.renderMd('https://example.com/@alice', 'user').trim();
assert.equal(
  urlHtml,
  '<p><a href="https://example.com/@alice">https://example.com/@alice</a></p>',
  'URL 中的 @ 字符不应触发 mention 高亮',
);

const mentionHtml = renderer.renderMd('@haico-developer hello', 'user').trim();
assert.ok(
  mentionHtml.includes('<span style="color:#61afef;font-weight:500;background:#61afef18;padding:0 4px;border-radius:3px">@haico-developer</span>'),
  '真实 agent mention 仍应高亮',
);

const mixedHtml = renderer.renderMd('联系 zihaofu@cuhk.edu.hk 和 @haico-developer', 'user').trim();
assert.ok(
  mixedHtml.includes('<a href="mailto:zihaofu@cuhk.edu.hk">zihaofu@cuhk.edu.hk</a>'),
  '混合文本中的邮箱应保持完整 mailto 链接',
);
assert.ok(
  mixedHtml.includes('<span style="color:#61afef;font-weight:500;background:#61afef18;padding:0 4px;border-radius:3px">@haico-developer</span>'),
  '混合文本中的真实 mention 仍应高亮',
);
assert.ok(!mixedHtml.includes('&quot;'), '混合文本渲染不应泄漏 HTML 转义字符');

// ─── Issue #241 QA: 邮箱渲染验证扩展测试 ───

// 1. 多种邮箱格式
for (const email of ['zihaofu@cuhk.edu.hk', 'test@example.com', 'user+tag@sub.domain.org']) {
  const html = renderer.renderMd(email, 'user').trim();
  assert.ok(!html.includes('&quot;'), `${email}: 不应泄漏 HTML 转义字符`);
  assert.ok(!html.includes('<span'), `${email}: 不应被 mention 高亮拆开`);
  assert.ok(html.includes('mailto:'), `${email}: 应生成 mailto 链接`);
}

// 2. URL 中含 @ 字符不应触发 mention
const urlWithAt = renderer.renderMd('https://example.com/@alice', 'user').trim();
assert.ok(
  urlWithAt.includes('href="https://example.com/@alice"'),
  'URL 中的 @alice 不应触发 mention 高亮，应保留为链接',
);
assert.ok(!urlWithAt.includes('<span'), 'URL 中的 @ 不应产生 mention span');

// 3. 真实 agent mention 应高亮
const mentionOnly = renderer.renderMd('@haico-developer', 'user').trim();
assert.ok(
  mentionOnly.includes('@haico-developer</span>'),
  '真实 agent mention 应被高亮',
);

// 4. 邮箱 + mention 混合在同一行
const mixedLine = renderer.renderMd('联系 zihaofu@cuhk.edu.hk 和 @haico-developer', 'user').trim();
assert.ok(mixedLine.includes('mailto:zihaofu@cuhk.edu.hk'), '混合行中邮箱应保持完整 mailto');
assert.ok(mixedLine.includes('@haico-developer</span>'), '混合行中 mention 应高亮');
assert.ok(!mixedLine.includes('&quot;'), '混合行不应泄漏转义字符');

// 5. 完整 issue body 场景（#241 原始内容）
const issueBody = `测试邮箱地址：zihaofu@cuhk.edu.hk

另一个邮箱：test@example.com

带URL：https://example.com/@alice

真实mention：@haico-developer`;
const bodyHtml = renderer.renderMd(issueBody, 'user');
assert.ok(!bodyHtml.includes('&quot;'), '#241 body: 不应泄漏 HTML 转义字符');
assert.ok(bodyHtml.includes('mailto:zihaofu@cuhk.edu.hk'), '#241 body: 第一个邮箱应完整');
assert.ok(bodyHtml.includes('mailto:test@example.com'), '#241 body: 第二个邮箱应完整');
assert.ok(bodyHtml.includes('href="https://example.com/@alice"'), '#241 body: URL 中 @ 不应破坏链接');
assert.ok(bodyHtml.includes('@haico-developer</span>'), '#241 body: 真实 mention 应高亮');

// 6. highlightMentionsInHtml 独立测试
const { highlightMentionsInHtml } = (renderer as any)._test;

// 6a. 邮箱在 <a> 标签内，@ 不应触发 mention
const emailAnchorHtml = highlightMentionsInHtml(
  '<p><a href="mailto:zihaofu@cuhk.edu.hk">zihaofu@cuhk.edu.hk</a></p>',
  ['haico-developer'],
);
assert.ok(!emailAnchorHtml.includes('<span'), '邮箱 <a> 内 @ 不应触发 mention');

// 6b. URL 在 <a> 标签内，@ 不应触发 mention
const urlAnchorHtml = highlightMentionsInHtml(
  '<p><a href="https://example.com/@alice">https://example.com/@alice</a></p>',
  ['alice'],
);
assert.ok(!urlAnchorHtml.includes('<span'), 'URL <a> 内 @ 不应触发 mention');

// 6c. <code> 标签内 @ 不应触发 mention
const codeHtml = highlightMentionsInHtml(
  '<p><code>@haico-developer</code></p>',
  ['haico-developer'],
);
assert.ok(!codeHtml.includes('<span'), '<code> 内 @ 不应触发 mention');

// 6d. <pre> 标签内 @ 不应触发 mention
const preHtml = highlightMentionsInHtml(
  '<pre>@haico-developer</pre>',
  ['haico-developer'],
);
assert.ok(!preHtml.includes('<span'), '<pre> 内 @ 不应触发 mention');

// 6e. 普通文本中真实 mention 应高亮
const plainMention = highlightMentionsInHtml(
  '<p>hello @haico-developer</p>',
  ['haico-developer'],
);
assert.ok(plainMention.includes('<span'), '普通文本 mention 应高亮');

// 6f. 非代理名的 @ 不应高亮
const nonAgentMention = highlightMentionsInHtml(
  '<p>hello @some-random-user</p>',
  ['haico-developer'],
);
assert.ok(!nonAgentMention.includes('<span'), '非代理名 @ 不应高亮');

console.log('issue-renderer regression checks passed (including #241 QA)');
