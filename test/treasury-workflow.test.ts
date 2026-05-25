import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

type TreasuryApi = {
  buildModel: (input: any) => any;
  render: (model: any) => string;
};

function escapeValue(value: string): string {
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

function html(value: unknown): { __html: string } {
  return { __html: String(value == null ? '' : value) };
}

function h(parts: TemplateStringsArray, ...vals: unknown[]): string {
  return parts.reduce((acc, part, i) => {
    const value = vals[i] as { __html?: string } | null | undefined;
    if (value == null) return acc + part;
    if (typeof value === 'object' && value.__html != null) return acc + part + value.__html;
    return acc + part + escapeValue(String(value));
  }, '');
}

function loadTreasuryWorkflow(): TreasuryApi {
  const source = fs.readFileSync('public/js/components/treasury-workflow.js', 'utf8');
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    html,
    h,
    window: { html, h },
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return (sandbox.window as any).HAICOTreasuryWorkflow || (sandbox as any).HAICOTreasuryWorkflow;
}

const api = loadTreasuryWorkflow();

const model = api.buildModel({
  project: {
    name: 'Meridian Treasury Copilot',
    task_description: 'Build a trusted treasury workflow layer that helps finance teams move faster without sacrificing control or auditability.',
  },
  workflow: {
    agents: [
      { id: 'controller', status: 'running' },
      { id: 'ops', status: 'running' },
      { id: 'qa', status: 'error' },
    ],
    recent_messages: [
      { from_agent_id: 'controller', to_agent_id: 'ops' },
      { from_agent_id: 'ops', to_agent_id: 'qa' },
    ],
    total_active_issues: 5,
  },
  approvals: [
    { id: 'approval-1' },
    { id: 'approval-2' },
  ],
  activeIssues: [
    { id: 'issue-1' },
    { id: 'issue-2' },
    { id: 'issue-3' },
    { id: 'issue-4' },
  ],
});

assert.equal(model.regions.length, 4, '应生成四个区域阈值包');
assert.equal(model.regions[1].status, 'Awaiting approval', 'EMEA 阈值包应进入审批等待态');
assert.ok(
  model.guardrails[0].items.some((item: string) => item.includes('Auto-apply')),
  '决策护栏应包含自动应用规则',
);

const rendered = api.render(model);
assert.ok(rendered.includes('Treasury Control Layer'), '页面应渲染资金控制层标题');
assert.ok(rendered.includes('Meridian Treasury Copilot'), '页面应渲染项目名称徽标');
assert.ok(rendered.includes('Dual approval'), '页面应展示双人审批路径');
assert.ok(rendered.includes('Awaiting approval'), '页面应展示待审批状态');
assert.ok(!rendered.includes('[object Object]'), '渲染结果不应泄漏对象字符串');

console.log('treasury workflow layer checks passed');
