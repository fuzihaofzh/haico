const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const db = new Database('data/agentopia.db');

const now = new Date().toISOString();

// === Update Round 2 issues ===

const round2Results = {
  '931c128d-62a9-4dd8-8bc0-088939c73f1d': {
    title: '[量价] 第58轮',
    comment: `## 第58轮结果 - Agent 1（量价）

**结论：0个新因子入库，全部因相似度超标被拒绝**

### 测试结果摘要
| 因子 | Sharpe | Fitness | 结果 | 相似因子 |
|------|--------|---------|------|---------|
| lower_shadow × volume × reversal | 1.78 | 1.008 | ❌ REJECTED | custom031 (0.92) |
| overnight_delta (跳空) × vol × reversal | 1.88 | 1.06 | ❌ REJECTED | custom043 (0.90) |
| vol_asymmetry_additive | 1.94 | 1.08 | ❌ REJECTED | custom050 (0.96) |
| volacc_body (volatility加速度+body) | 1.94 | 0.989 | ❌ LOW_QUALITY | - |
| body_var_triple | 1.94 | 0.989 | ❌ LOW_QUALITY | - |
| vol_rel_var (相对变异系数) | 1.76 | 0.91 | ❌ LOW_QUALITY | - |
| asset_turnover_body_var (FMP) | 1.18 | 0.55 | ❌ LOW_QUALITY | - |

### 核心发现
1. **模板饱和**: \`rank(vol/adv20) × rank(decay_linear(-ts_rank(returns,N),M))\` 组合在DB中已被反复使用，任何含此结构的新因子都与custom031-custom050等高度相关
2. **decay=11 body variability**: 最接近成功的配置（Fitness=1.036）被custom070拒绝(0.876)
3. 换SIGNAL_A信号无法绕过相似性检测——检测器比较IC时序，而非公式字符串

### 第59轮方向
**禁止使用**: \`rank(volume/adv20)\` + \`rank(decay_linear(-ts_rank(returns,N),M))\` 的配对结构
**新方向**: ts_corr, ts_skewness, 不含成交量的价格模式, SIC grouping + body_ratio替代reversal`
  },
  '02b52bb4-5252-476e-b0af-830ada855418': {
    title: '[量价+基本面] 第58轮',
    comment: `## 第58轮结果 - Agent 2（量价+基本面）

**结论：0个新因子入库，全部因相似度超标被拒绝或质量不足**

### 测试结果摘要
| 因子 | Sharpe | Fitness | 结果 | 备注 |
|------|--------|---------|------|------|
| gross_profit_assets v8 | 1.68 | 1.07 | ❌ REJECTED (custom003, 0.933) | - |
| B7: net_debt_delta × gp_delta × reversal | 1.98 | 1.265 | ❌ REJECTED (custom079, 0.932) | 最好的质量指标 |
| B8: net_debt × gp × body_ratio | 1.28 | 0.70 | ❌ LOW_QUALITY | 去掉reversal后alpha弱 |
| B9: net_debt × gp × 2d_reversal | 1.26 | 0.74 | ❌ LOW_QUALITY | 2d反转比4d更弱 |
| B10: low_leverage × gp_delta | 0.67 | 0.28 | ❌ LOW_QUALITY | - |
| B11: net_debt × vol × body_tsrank | 1.90 | 0.987 | ❌ LOW_QUALITY (差0.013) | - |
| B11v2: 同上 ts_mean(5) | 1.76 | 0.938 | ❌ LOW_QUALITY | - |

### 核心发现
1. **B7 (net_debt × gp × reversal)** Sharpe=1.978, Fitness=1.265 — 质量最佳但被custom079(0.932)拒绝。custom079 = income_delta × cashflow_delta × reversal，结构完全相同
2. **无reversal时**: 基本面信号×body_ratio = Fitness仅0.70，远低于reversal版本
3. **4d反转是alpha主要来源**: 去掉它后基本面信号大幅弱化，但保留它会导致高相似度

### 第59轮方向
- 仿照custom058 (roe × vol × body_ratio, SIC grouping) — 已成功入库
- 尝试: fundamental × body_ratio(SIC grouping) — 完全不用returns reversal
- 尝试: 季报数据的非标准滞后（21天/126天而非63天）`
  },
  'e93793df-c23d-4950-a0b3-bdc6b78a6227': {
    title: '[学习型] 第58轮',
    comment: `## 第58轮结果 - Agent 3（学习型）

**结论：0个新因子入库，income_growth因子质量达标但相似度超标**

### 测试结果摘要
| 因子 | Sharpe | Fitness | 结果 | 备注 |
|------|--------|---------|------|------|
| vol_acceleration系列 (ts_rank=5) | 1.82-1.94 | 0.96-1.04 | ❌ REJECTED/LOW | custom031/custom043/custom050高相关 |
| asset_growth_v1 (Cooper 2008) | ~1.0 | <0.5 | ❌ LOW_QUALITY | - |
| **income_growth_vol_reversal_v1** | **2.007** | **1.135** | **❌ REJECTED (0.912)** | **质量达标！** |

### income_growth_vol_reversal_v1 详情（质量最好）
```
ts_mean(group_zscore(rank((income - delay(income, 63)) / (assets + 0.0001)) * rank(volume / adv20) * rank(decay_linear(-1 * ts_rank(returns, 4), 11)), industry), 4)
```
- Sharpe=2.007, Fitness=1.135, Turnover=30.64%, MaxDD=-6.91%, Return=9.81%
- 被已有因子拒绝（相似度0.912）— 很可能相似于custom079

### 核心发现
1. 基本面信号（income增速）质量确实更高（Sharpe>2），但standard template下与custom079等高度相关
2. mywq.db中的波动率加速度信号方向已被前几轮覆盖
3. **关键**: 相似度检测基于IC时序相关，只要用了\`vol × reversal\`配对就会高度相关

### 第59轮方向
- custom058模板: fundamental × vol/adv20 × body_ratio(SIC) — 无reversal
- 尝试: income增速 × 纯价格信号（无成交量）
- 尝试: 完全不同结构 — ts_corr(returns, volume, N) 或 ts_skewness`
  }
};

const addComment = db.prepare(`
  INSERT INTO issue_comments (id, issue_id, body, author_id, created_at, updated_at)
  VALUES (?, ?, ?, 'controller', ?, ?)
`);

const updateStatus = db.prepare(`
  UPDATE issues SET status = 'done', updated_at = ? WHERE id = ?
`);

for (const [issueId, data] of Object.entries(round2Results)) {
  addComment.run(uuidv4(), issueId, data.comment, now, now);
  updateStatus.run(now, issueId);
  console.log(`Updated issue ${data.title}: done + comment added`);
}

// === Create Round 3 Issues ===

const maxNumber = db.prepare('SELECT MAX(number) as n FROM issues').get().n;
console.log(`\nCurrent max issue number: ${maxNumber}`);

const insertIssue = db.prepare(`
  INSERT INTO issues (id, number, project_id, title, body, status, priority, author_id, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 'pending', 'high', 'controller', ?, ?)
`);

const projectId = db.prepare('SELECT id FROM projects LIMIT 1').get().id;
const nextNum = maxNumber + 1;

const round3Issues = [
  {
    id: uuidv4(),
    number: nextNum,
    title: '[量价] 第59轮 - 绕过相似度：ts_corr/ts_skewness/无成交量价格结构',
    body: `## 第59轮 Agent 1：量价信号 - 绕过相似度饱和

**背景**: 第58轮所有量价因子均因相似度>0.8被拒绝。根本原因: \`rank(vol/adv20) × rank(decay(-ts_rank(returns,N),M))\`配对已被DB中~40+个因子使用，造成IC时序高度相关。

## 禁止结构（会被拒绝）
- 任何包含 \`rank(volume/adv20) * rank(decay_linear(-1 * ts_rank(returns, N), M))\` 的公式
- 即使换掉SIGNAL_A也无济于事

## 第59轮方向（必须完全不同）

### 方向A: ts_corr 量价相关（完全不同结构）
**理论**: Llorente et al. 2002 - 流动性驱动(informed) vs 非流动性驱动(uninformed)交易
```python
# 5天量价相关系数作为信号
ts_corr(returns, volume, 5)  # 负相关=知情买入，正相关=流动性需求
```
**参考公式**:
\`\`\`
ts_mean(group_zscore(rank(ts_corr(returns, volume, 5)), industry), 4)
\`\`\`

### 方向B: ts_skewness 收益率偏度（彩票偏好）
**理论**: Bali et al. 2011 - 高期望偏度=彩票因子=被高估=负向alpha
```python
ts_skewness(returns, 20)  # 20天偏度，负相关于未来收益
```
**参考公式**:
\`\`\`
ts_mean(group_zscore(-1 * rank(ts_skewness(returns, 20)), industry), 4)
\`\`\`

### 方向C: 纯价格结构（无成交量、无returns reversal）
**理论**: 开盘-收盘价格模式，不使用成交量
```python
# 5天内最大开收差/最大日内范围比率
ts_max(abs(open/delay(close,1) - 1), 5) / (ts_mean(high/low - 1, 5) + 0.0001)
```

### 方向D: 成交量集中度（不同于已有）
检查 mywq.db 中 Sharpe>2、未被custom库覆盖的因子，特别是：
- 查询: \`SELECT code, sharpe FROM alphas WHERE sharpe > 2 ORDER BY sharpe DESC LIMIT 20\`（在mywq.db中）
- 找出 IC时序与现有66个因子相关度低的

## 执行要求
1. 每个方向先测试无--save版本
2. 如果 Fitness >= 1.0，再用 --save 入库
3. 如果被拒绝，记录相似因子，分析为何相关，换方向
4. **不得使用** ts_rank(returns, N) 作为反转信号
5. 工作目录: /gds/zhfu/lin/alphamining
`
  },
  {
    id: uuidv4(),
    number: nextNum + 1,
    title: '[基本面] 第59轮 - custom058结构推广：fundamental × vol × body_ratio (SIC)',
    body: `## 第59轮 Agent 2：基本面 - custom058模板推广

**背景**: 第58轮发现: 任何 fundamental × vol × reversal(returns) 结构都与custom079等高度相关。
**突破口**: custom058 = \`roe × vol/adv20 × body_ratio(5d)\` + **SIC** grouping 成功入库。此结构与其他因子差异足够大。

## custom058 结构（已成功入库的模板）
\`\`\`
ts_mean(group_zscore(rank(FUNDAMENTAL) * rank(volume / adv20) * rank(decay_linear(ts_rank((open - close) / (high - low + 0.0001), 5), 11)), sic), 4)
\`\`\`
关键特点:
- **无 returns reversal**（用body_ratio替代）
- **SIC** 分组（非industry）
- FUNDAMENTAL = 截面水平信号（非delta变化量）

## 本轮要测试的FUNDAMENTAL信号

### 信号1: 净资产收益率增速（ROE改善）
\`\`\`python
# 与custom058(ROE水平)不同，这里用ROE的变化量
FUNDAMENTAL = ts_delta(return_equity, 63)  # 季度ROE变化
\`\`\`

### 信号2: 资产效率（资产周转率）
\`\`\`python
FUNDAMENTAL = revenue / (assets + 0.0001)  # 资产周转率（高=效率高）
\`\`\`

### 信号3: 现金流质量（Cash Flow Quality）
\`\`\`python
FUNDAMENTAL = cashflow_op / (abs(income) + 0.0001)  # 现金利润比（高=盈利质量好）
\`\`\`

### 信号4: 净债务改善（杠杆降低）
\`\`\`python
FUNDAMENTAL = -1 * ts_delta(net_debt / (assets + 0.0001), 63)  # 负债率降低=正向信号
\`\`\`

## 测试流程
1. 对每个FUNDAMENTAL信号，代入custom058模板（SIC grouping，body_ratio，无reversal）
2. 先测试无--save版本确认质量
3. Fitness >= 1.0 时，检查相似度，如果 < 0.8 则加 --save 入库
4. 如果与custom058本身相似度>0.8，换不同的FUNDAMENTAL或调整body_ratio窗口（5→8→3）
5. 工作目录: /gds/zhfu/lin/alphamining, --source fmp

## 回退策略
如果custom058变体全被拒绝，尝试:
- 完全不用成交量，只用: \`ts_mean(group_zscore(rank(FUNDAMENTAL_A) * rank(FUNDAMENTAL_B), sic), 4)\`
- 双基本面相乘（无价量成分）
`
  },
  {
    id: uuidv4(),
    number: nextNum + 2,
    title: '[学习+创新] 第59轮 - income_growth改进版（去reversal）+ 纯基本面结构',
    body: `## 第59轮 Agent 3：改进income_growth + 探索纯基本面结构

**背景**: income_growth_vol_reversal_v1 (Sharpe=2.007, Fitness=1.135) 质量出色但被拒绝(相似度0.912)。
**原因**: \`rank(volume/adv20) × rank(decay(-ts_rank(returns,4),11))\` 造成与现有因子高度相关。

## 方向A: income_growth × body_ratio × SIC（去除reversal）
**原公式（已被拒绝）**:
\`\`\`
ts_mean(group_zscore(rank((income - delay(income, 63)) / (assets + 0.0001)) * rank(volume / adv20) * rank(decay_linear(-1 * ts_rank(returns, 4), 11)), industry), 4)
\`\`\`

**新公式（仿custom058结构）**:
\`\`\`
ts_mean(group_zscore(rank((income - delay(income, 63)) / (assets + 0.0001)) * rank(volume / adv20) * rank(decay_linear(ts_rank((open - close) / (high - low + 0.0001), 5), 11)), sic), 4)
\`\`\`
改变: reversal→body_ratio, industry→sic

## 方向B: 双基本面结构（参考custom079但用不同字段）
custom079 = income_delta × cashflow_delta × reversal（已入库）
尝试: **income_delta × gross_profit_delta × body_ratio（SIC）**
\`\`\`
ts_mean(group_zscore(rank((income - delay(income, 63)) / (assets + 0.0001)) * rank((gross_profit - delay(gross_profit, 63)) / (assets + 0.0001)) * rank(decay_linear(ts_rank((open - close) / (high - low + 0.0001), 5), 11)), sic), 4)
\`\`\`

## 方向C: 更激进的结构变化
完全不同，试验:
\`\`\`
# 纯基本面双信号，无量价
ts_mean(group_zscore(rank((income - delay(income, 63)) / (assets + 0.0001)) * rank(gross_profit / (revenue + 0.0001)), sic), 4)
\`\`\`

## 测试顺序
1. 方向A: income_growth × body_ratio × SIC（最可能通过相似度）
2. 方向B: income_delta × gp_delta × body_ratio × SIC
3. 如果1和2都被拒绝，尝试方向C或完全不同的基本面字段
4. 记录每次拒绝的相似因子，理解为何相关，快速迭代
5. 工作目录: /gds/zhfu/lin/alphamining, --source fmp
`
  }
];

for (const issue of round3Issues) {
  insertIssue.run(issue.id, issue.number, projectId, issue.title, issue.body, now, now);
  console.log(`Created issue #${issue.number}: ${issue.title.substring(0, 50)}...`);
}

console.log('\nDone!');
db.close();
