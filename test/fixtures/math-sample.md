---
title: AutoScientist-Quant：面向量化投资自动化研究的自我进化编码智能体
---

## 2.1 问题定义

设 $\mathbf{X}_{\leq t}\in\mathbb{R}^{N\times t\times W}$ 收集截至第 $t$ 天的 $N$ 只股票的历史数据，每只股票每天包含 $W$ 个价格和成交量字段。$\mathit{Alpha}$ 是一个函数 $f$，将该历史数据映射为截面分数 $f(\mathbf{X}_{\leq t})\in\mathbb{R}^{N}$；库 $\mathcal{F}=\{f_{1},\dots,f_{K}\}$ 将分数组合为输入，预测器 $g\in\mathcal{G}$ 将输入映射为未来收益的预测值 $\hat{\mathbf{y}}_{t}=g\!\left(\mathcal{F}(\mathbf{X}_{\leq t})\right)\in\mathbb{R}^{N}$。固定的组合规则将预测转化为每日持仓，

$$
\max_{\mathcal{F}_{B},\ \mathcal{F}\subseteq\mathcal{F}_{B},\ g\in\mathcal{G}} U(\mathcal{F}, g, \mathcal{D}_{\mathrm{fb}}) \quad \text{s.t.} \quad |\mathcal{F}_{B}|\leq B,
$$

其中 $\mathcal{F}_{B}$ 遍历在全局预算 $B$ 下可发现的库，$\mathcal{A}$ 是可选的标准库，\(\mathcal{D}_{\mathrm{fb}}\) 是反馈窗口。

价格动量信号定义为 $\mathrm{mom}_{i,t}=\frac{P_{i,t-1}}{P_{i,t-W-1}}-1$，其中 $P_{i,t}$ 是股票 $i$ 在第 $t$ 天的收盘价。

```python
# 代码块中的 $x_{t}$ 与 $$y$$ 不是公式
momentum = prices.shift(1) / prices.shift(W + 1) - 1
```

代码外的行内代码 `$\mathbf{v}$` 也不应被转换。

财报表：本季度收入 $5.2 与 $6.8 之间的区间估计保持原样。

含中文标注的公式 $夏普率_{t}=\frac{\mu_t}{\sigma_t}$ 需要人工复核。
