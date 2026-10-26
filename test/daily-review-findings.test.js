import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAILY_EXPERIMENT_RULES } from '../src/research/evidence.js';
import {
  dailyDraftText, deferredReviewNote, isDailyContextOmission, isPositiveDailyFactError, partitionDailyReviewErrors,
} from '../src/research/review-findings.js';

const windowOmission = 'C1：稿件没有交代这102个交易日的实际评估日期；原文L40明确为2026年4月8日至9月10日。另，本次核查的原文定位未说明佣金口径';
const currencyOmission = 'C3：稿件未交代买入费率的计费口径，也没有在该定位说明最低费用的币种及成本是否包含适用税费';
const constituentOmission = 'C3：没有说明指数成分股如何构造。本次核查未确认该构造方式，locators未见各时点取样';
const budgetOmission = 'C3：本次核查完整locators未见各基线对应预算，比较是否等预算未核实';
const titleMetric = 'C12：标题称“回撤改善”，但本次核查的完整原文定位没有报告回撤指标';
const headerScope = 'HEADER：标题将整组内容框定为“大模型量化”，但其中一条并非大语言模型方法，范围不准确';
const titleWording = 'HEADER：标题用词与最大回撤不完全同名';
const counterparty = 'C12：稿件报告仿真结果时遗漏一个重要对手方条件';
const inventedClaims = [
  'C1：稿件称夏普比率提升0.3，但原文没有报告夏普比率',
  'C1：稿件写"年化收益18%"，原文未给出该数字',
  'C1：稿件称该方法已在实盘部署，原文未说明有实盘',
  'C1：稿件称结果显著，但原文没有报告显著性检验',
  'C1：正文称样本为2020-2024，原文未写在该定位，原文为2018-2022',
  'C12：标题称"回撤改善"，但原文没有报告回撤指标',
  'C1：稿件称结果显著，但原文没有报告显著性检验；另本次核查未确认种子数',
  'HEADER：导语表述为已实盘部署，原文未提及实盘',
  titleMetric,
  headerScope,
];
const drawdownAsLoss = 'C1：稿件将最大回撤写成了策略收益亏损';
const significance = 'C1：容易将单模型与原设计之间的直接差异说成经过显著性检验';
const swappedComparison = 'C1：修正后把甲比较的数字写到了乙比较下';
const paperCalledLive = 'C1：稿件把纸面账户写成了实盘';

test('positive fact errors block on every pass, including when the wording also mentions an omission', () => {
  const blocking = [
    'C1：关键结论与原文不符',
    'HEADER：标题错误：原文仅报告预测评估，并非真实交易。',
    'C1：L1减L0误标为L2减L0',
    'HEADER：标题声称实盘；C1原文仅为合成实验',
    'C1：原文已经明确说明判分器，不得声称未披露',
    drawdownAsLoss,
    significance,
    swappedComparison,
    'C1：修正后混淆了比较组',
    paperCalledLive,
    'C1：补充修正后把回撤写成了收益亏损',
    'C1：改稿时遗漏了原句，并把甲的数字写到了乙',
    ...inventedClaims,
  ];
  for (const error of blocking) {
    assert.equal(isPositiveDailyFactError(error), true, error);
    assert.equal(isDailyContextOmission(error), false, error);
    for (const passNumber of [0, 1, 2]) {
      const result = partitionDailyReviewErrors([error], { passNumber });
      assert.deepEqual(result.blocking, [error], `${error} pass ${passNumber}`);
      assert.deepEqual(result.deferred, []);
    }
  }
});

test('source omissions and unverified caveats are corrected once, then noted instead of blocking', () => {
  const omissions = [windowOmission, currencyOmission, constituentOmission, budgetOmission, counterparty, titleWording,
    'C1：样本区间未写在结果旁边', 'C2：年化收益未交代样本区间，强基线未点名', 'C1：事件研究窗口与意外指数没有写在结果旁边',
    'C4：稿件没有交代评估窗口的起止日期', 'C5：本次核查未确认基线预算是否相同，稿件没有断言该细节',
    'C6：稿件遗漏了仿真中历史参与者是否响应报价'];
  for (const error of omissions) {
    assert.equal(isDailyContextOmission(error), true, error);
    assert.equal(isPositiveDailyFactError(error), false, error);
    assert.deepEqual(partitionDailyReviewErrors([error], { passNumber: 0 }).blocking, [error]);
    assert.deepEqual(partitionDailyReviewErrors([error], { passNumber: 1 }).deferred, [error]);
    assert.deepEqual(partitionDailyReviewErrors([error], { passNumber: 1, requested: new Set([error]) }).blocking, [error],
      'an omission already sent to a repair still blocks');
  }
  const note = deferredReviewNote([currencyOmission, titleWording]);
  assert.match(note, /^审稿补充（不阻断）：C3：/);
  assert.match(note, /HEADER：/);
});

test('a repair that deletes a source date or source sentence already in the draft stays blocking', () => {
  const prior = dailyDraftText({ title: '研究', intro: '以下为作者报告。', items: [{ heading: '部署', body: '纸面账户窗口为2026年4月8日至9月10日。仿真不计交易费，历史参与者不响应策略报价。' }] });
  const current = dailyDraftText({ title: '研究', intro: '以下为作者报告。', items: [{ heading: '部署', body: '纸面账户运行了102个交易日。' }] });
  assert.deepEqual(partitionDailyReviewErrors([windowOmission], { passNumber: 1, priorText: prior, currentText: current }).blocking, [windowOmission]);
  const quoted = 'C12：遗漏对手方。原文写明“仿真不计交易费，历史参与者不响应策略报价”';
  assert.deepEqual(partitionDailyReviewErrors([quoted], { passNumber: 1, priorText: prior, currentText: current }).blocking, [quoted]);
  assert.deepEqual(partitionDailyReviewErrors([windowOmission], { passNumber: 1, priorText: current, currentText: current }).deferred, [windowOmission],
    'rediscovering a date that was never in either draft does not block');
  assert.deepEqual(partitionDailyReviewErrors([windowOmission], { passNumber: 1, priorText: prior, currentText: prior }).deferred, [windowOmission],
    'a date that is still in the draft is not a deletion');
});

test('an unrecognized or source-lack high issue stays blocking so omission wording cannot hide it', () => {
  const blocking = [
    'C1：需要限定比较范围',
    'C1：原文没有报告夏普比率',
    'C1：原文未给出该数字',
    'C1：原文未说明有实盘',
    'C1：原文未写在该定位',
    'C1：稿件称结果显著，本次核查未确认',
    'C1：原文没有明确说明评估窗口',
  ];
  for (const error of blocking) {
    assert.equal(isPositiveDailyFactError(error), false, error);
    assert.equal(isDailyContextOmission(error), false, error);
    const result = partitionDailyReviewErrors([error], { passNumber: 1 });
    assert.deepEqual(result.blocking, [error], error);
    assert.deepEqual(result.deferred, []);
  }
});

test('writing and extraction rules require source-stated scope without making unverified caveats mandatory', () => {
  assert.match(DAILY_EXPERIMENT_RULES, /评估窗口起止日期/);
  assert.match(DAILY_EXPERIMENT_RULES, /原文写明的成本费率/);
  assert.match(DAILY_EXPERIMENT_RULES, /不要编造/);
  assert.doesNotMatch(DAILY_EXPERIMENT_RULES, /未核实则写本次未核实/);
  assert.doesNotMatch(DAILY_EXPERIMENT_RULES, /列high/);
});
