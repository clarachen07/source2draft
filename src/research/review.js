import { hash } from '../lib/io.js';
import { DAILY_SYSTEM, DAILY_EXPERIMENT_RULES, DAILY_STYLE_RULES, renderDailyArticle, reviewFingerprint } from './evidence.js';

export const DAILY_REVIEW_POLICY = 7;
const auditShape = audit => Array.isArray(audit?.issues) && audit.issues.every(issue => typeof issue?.reason === 'string'
  && ['high', 'medium', 'low'].includes(issue.severity))
  && (!audit.warnings || Array.isArray(audit.warnings) && audit.warnings.every(warning => typeof warning === 'string'));

// Each pass has the current full draft identity. Persist every reviewed item
// before moving on; retries reuse only verified responses for identical input.
export async function reviewDailyDraft({ draft, cards, run, context, config, checkpoint, persist, model, signal, onTelemetry, progress = () => {} }) {
  const fingerprint = reviewFingerprint({ draft, cards, input: run.input, context, modelConfig: config.model });
  const passNumber = checkpoint.correctionCount || 0;
  const passIdentity = hash({ policy: DAILY_REVIEW_POLICY, passNumber, fingerprint });
  checkpoint.reviewPasses ||= {};
  let pass = checkpoint.reviewPasses[passIdentity];
  if (!pass) { pass = checkpoint.reviewPasses[passIdentity] = { policy: DAILY_REVIEW_POLICY, passNumber, fingerprint, items: {} }; persist(); }
  if (pass.policy !== DAILY_REVIEW_POLICY || pass.passNumber !== passNumber || pass.fingerprint !== fingerprint || !pass.items || typeof pass.items !== 'object' || Array.isArray(pass.items)) {
    throw new Error('日报逐条审稿断点结构损坏');
  }
  const audits = [];
  for (const [index, item] of draft.items.entries()) {
    signal?.throwIfAborted();
    const ids = new Set([item.cardId, ...item.claims.flatMap(claim => claim.refs.map(ref => ref.cardId))]);
    const relevant = cards.filter(card => ids.has(card.id));
    // The issue title summarizes several events. Showing it as this item's
    // title makes an isolated reviewer attribute other events to this source.
    const article = renderDailyArticle({ title: item.heading, intro: '', items: [item] }, relevant, context);
    const identity = hash({ passIdentity, item, cards: relevant, article });
    const saved = pass.items[item.cardId];
    let audit;
    if (saved) {
      if (saved.identity !== identity || saved.valueHash !== hash(saved.value) || !auditShape(saved.value)) throw new Error('日报逐条审稿断点校验失败');
      audit = saved.value;
    } else {
      progress(`正在${checkpoint.correctionCount ? '终审' : '审稿'}事件 ${index + 1}/${draft.items.length}`);
      audit = await model.json({ role: 'review', signal, onTelemetry, systemPrompt: DAILY_SYSTEM,
        prompt: `只审核本条事件${item.cardId}。用户要求：${run.input}\n冻结窗口：${JSON.stringify(context)}\n本条相关原文证据卡与完整定位：${JSON.stringify(relevant)}\n本条实际呈现（程序已添加来源标题、链接及经过核验的发表/更新日期，末尾单独显示文章对应日期）：\n${article}\n本条claims映射：${JSON.stringify(item.claims)}
对照完整原文核对主语、比较组、指标定义、样本、时间划分、成本单位/对象、实验条件与局限。数字能在原文找到并不证明断言正确：不同主语/比较组的相同数字不能互换；区分受限动作集与放宽动作集相对谁的增益、单次运行与多种子平均、实际成本与估算价目、执行token与反思token。rank若按任务到达顺序定义，就只能写时间先后，不能暗示成绩排名。金额对比必须明确金额对应哪种模型/方案。equal-mass分箱指等样本量，不指物理质量；headroom是可达到且被评估表达的提升空间，不能误译为上下文容量。
${DAILY_EXPERIMENT_RULES}
若本条报告金融市场预测或策略回测结果，正文必须交代市场、样本期、测试划分或评估窗口、基准，以及预测评估/回测/实盘性质。报告策略收益、组合表现或交易回测时，还必须交代交易成本假设；只评估估值或预测误差（如MAPE）、没有报告交易收益且正文已明确其预测评估性质时，交易成本不适用于该误差比较，不能因未重复说明未计成本而列high，也不能从本次未核实推定作者未做交易实验。原文提供而正文遗漏这些适用的关键条件，列high并给出原文定位与必要摘录；原文未披露的适用条件须明确限定为本次已核查原文未披露，未核实则写本次未核实。代码生成或通用模型基准不强套市场回测条件。不要要求将所有超参数搬入文章。
locators是完整取得的正文，claims只是精选提要。核对“未披露/未报告/缺少”必须查完整locators，未查到完整附录/仓库只能写“本次未核实”，不得从卡片缺项推定论文缺项。明确区分作者报告、作者观点与推断；不把本次模型审稿当复现实验。核验是否真的包含LLM，合成市场不能说真实市场已验证。
程序来源页脚已提供来源标题、链接及真实发表/更新日期，不要求补读标签；不因body没重复这些元数据而报缺来源或把元数据强写入正文。${DAILY_STYLE_RULES}
核对判断与建议是否省略表达主体，仍须保留研究事实的必要归属。不得要求恢复定期汇编措辞、补读标签或结尾固定说明。
只审核本条，warnings必须有本条原文依据，不能把其它事件的LLM裁判、实验设置或局限混到本条。样式偏好、篇幅偏好和不影响事实的补充背景列low，不要求另一次重写。
返回 JSON {"issues":[{"severity":"high或medium或low","reason":"具体问题，指出稿件原句、原文定位和正确比较/定义"}],"warnings":["仅本条原文支持的限制"]}。明确事实错误、比较组/语义错误、重要无证据断言、错误实验口径、错称实测/今日发布均为high；非关键细节为medium；样式为low。`,
        validate: auditShape });
      if (!auditShape(audit)) throw new Error('日报逐条审稿结构化结果不合格');
      pass.items[item.cardId] = { identity, valueHash: hash(audit), value: audit }; persist();
    }
    audits.push({ cardId: item.cardId, audit });
  }
  const aggregate = { fingerprint, policy: DAILY_REVIEW_POLICY, passNumber,
    issues: audits.flatMap(({ cardId, audit }) => audit.issues.filter(issue => issue.severity === 'high').map(issue => ({ cardId, ...issue }))),
    warnings: [...new Set(audits.flatMap(({ cardId, audit }) => (audit.warnings || []).map(warning => `${cardId}：${warning}`)))] };
  if (!(checkpoint.audits || []).some(audit => audit.fingerprint === fingerprint && audit.policy === DAILY_REVIEW_POLICY && audit.passNumber === passNumber)) {
    (checkpoint.audits ||= []).push(aggregate); persist();
  }
  return aggregate;
}
