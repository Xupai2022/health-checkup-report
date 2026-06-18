# HTML 模板动态化标准

本文档基于当前 `security-report-preview.html` 制定。目标是让模板既能作为设计预览稿打开，又能被脚本稳定回填真实客户、时间段、统计值、表格和图表。

## 1. 总原则

1. HTML 里的所有业务数据必须能追溯到 `reportData` 的一个字段。
2. 静态说明、样式、导航、评级规则等不随客户变化的内容保留硬编码。
3. 客户名、日期、数量、IP、漏洞名、风险列表、图表数组等随客户变化的内容必须动态化。
4. 不允许为了方便在 renderer 里继续写“示例科技有限公司”“2026-01-01”“203.0.113.45”这类示例值的专门替换规则。当前已有的兼容替换只作为迁移过渡。
5. 新模板改动优先改 HTML 标记，renderer 只实现通用规则和少量命名 section renderer。

## 2. 数据命名标准

使用点路径命名，路径必须和 `reportData` 对齐。

```js
{
  projectBackground: {},
  assetLedger: {},
  riskOverview: {},
  threatOps: {},
  threatPrevention: {
    internet: {},
    intranet: {}
  },
  appendix: {}
}
```

字段命名使用英文 camelCase。HTML 属性里的路径也使用同样名字，例如 `data-field="assetLedger.approve_asset"`。

## 3. 四种模板标记

### 3.1 文本占位符：`{{ path }}`

用于单个文本值，适合标题、客户名、日期、评级、普通段落里的变量。

```html
<title>{{ projectBackground.title }} - {{ projectBackground.customerName }}</title>
<p class="sub">{{ projectBackground.customerName }} · {{ projectBackground.startDate }} ~ {{ projectBackground.endDate }}</p>
```

规则：

- 只放纯文本，不放 HTML。
- renderer 必须 HTML escape。
- 缺值时输出空字符串，并在校验阶段报 warning。

### 3.2 固定数值节点：`data-field`

用于页面结构固定、只替换节点文本的 KPI 或短文本。

```html
<div class="sr-kpi-v" data-field="assetLedger.approve_asset">{{ assetLedger.approve_asset }}</div>
<b data-field="threatOps.highEvents">{{ threatOps.highEvents }}</b>
```

规则：

- `data-field` 值必须是 `reportData` 路径。
- 节点内部可以保留同路径 `{{ }}` 作为设计预览默认值。
- 如果同一个值出现多次，全部使用同一个 `data-field` 路径。
- 不要继续使用 `ops.devices-v` 这类带展示后缀的字段名；迁移到 `threatOps.devices.total` 这种业务路径。

### 3.3 动态 HTML 块：`data-section`

用于一个段落、摘要、复杂卡片、案例详情等需要由代码生成 HTML 的区域。

```html
<div data-section="riskOverview.summary"></div>
```

规则：

- section 名必须是稳定业务块名，不用 CSS id。
- 每个 section 在 `src/template_renderer.js` 中有同名 renderer。
- section renderer 可以输出安全的、白名单内的 HTML，例如 `<strong>`、`<br>`、`<span class="sr-tag ...">`。
- 用户/接口原始文本必须 escape，只有 renderer 自己拼出的标签允许保留。

### 3.4 重复列表/表格：`data-repeat`

用于表格 `<tbody>` 或列表容器。

```html
<tbody data-repeat="riskOverview.keyRisks"></tbody>
```

规则：

- `data-repeat` 指向数组。
- `<thead>` 留在模板里，`<tbody>` 由 renderer 填充。
- 空数组时渲染一行“暂无数据”，列数由 renderer 显式传入。
- 行内标签，如风险等级、处置状态，由公共 tag helper 生成。

## 4. 图表数据标准

图表不再在脚本里写死数组。所有图表只从 `window.SECURITY_REPORT_DATA.charts` 或对应业务字段读取。

推荐：

```js
var reportData = window.SECURITY_REPORT_DATA || {};
var assetTypes = reportData.assetLedger.typeDistribution || [];
```

规则：

- `data-chart` 保留，用作图表区域标识。
- 图表函数只负责视觉配置，不负责计算业务统计。
- 统计计算放在 data client/normalizer。
- 每个图表必须有一个数据路径，记录在本文档第 6 节。

## 5. 当前模板分区标准

### 5.1 封面与项目背景

动态字段：

- `projectBackground.title`
- `projectBackground.customerName`
- `projectBackground.startDate`
- `projectBackground.endDate`
- `projectBackground.generatedAt`

改造方式：

- `<title>`、封面 `<h1>`、封面副标题使用 `{{ }}`。
- 背景正文里的客户名和日期使用 `{{ }}`。
- 项目背景章节使用 `projectBackground.*`，不要再新增 `report.*`。

### 5.2 资产台账

动态字段：

- `assetLedger.approve_asset`
- `assetLedger.core_asset`
- `assetLedger.eliminate_asset`
- `assetLedger.manage_asset`
- `assetLedger.typeDistribution`
- `assetLedger.protectionDistribution`
- `assetLedger.internetExposureDistribution`
- `assetLedger.summaryLines`

改造方式：

- 顶部 4 个 KPI 用 `data-field`。
- 三个环形图读取数组。
- 下方 “【资产统计】...” 这类段落统一改为：

```html
<div data-section="assetLedger.summary"></div>
```

### 5.3 风险总览

动态字段：

- `riskOverview.grade`
- `riskOverview.assetTotal`
- `riskOverview.exposedServices`
- `riskOverview.highVulns`
- `riskOverview.weakPasswords`
- `riskOverview.protectionEffectiveness`
- `riskOverview.summary`
- `riskOverview.keyRisks`
- `riskOverview.topRiskAssets`

改造方式：

- 5 个总览 KPI 加 `data-field`。
- 总体评级用 `data-section="riskOverview.grade"` 或固定 span + `data-field`。
- “关键风险如下”表格 `<tbody data-repeat="riskOverview.keyRisks">`。
- “风险资产 TOP5”表格 `<tbody data-repeat="riskOverview.topRiskAssets">`。
- TOP5 图表读取 `riskOverview.topRiskAssets`。

### 5.4 风险详情 - 总述

动态字段：

- `riskDetail.threatOpsSummary`
- `riskDetail.internetSummary`
- `riskDetail.intranetSummary`

改造方式：

- 三段总述使用 `data-section`，因为句子里有多个统计值且以后可能根据数据缺失改变措辞。

### 5.5 威胁运营

动态字段：

- `threatOps.devices.total`
- `threatOps.devices.sangfor`
- `threatOps.devices.thirdParty`
- `threatOps.logs.total`
- `threatOps.logs.reduceRate`
- `threatOps.alerts.reduceRate`
- `threatOps.events.total`
- `threatOps.events.critical`
- `threatOps.events.high`
- `threatOps.events.closed`
- `threatOps.events.processing`
- `threatOps.events.closeRate`
- `threatOps.events.distribution`
- `threatOps.events.byBusinessSystem`
- `threatOps.highRisk.vulnExploits`
- `threatOps.highRisk.webAttacks`
- `threatOps.highRisk.viruses`
- `threatOps.highRisk.c2Connections`
- `threatOps.caseStudy`

改造方式：

- 漏斗 KPI 用 `data-field`。
- 运营文字段落用 `data-section="threatOps.summary"`。
- 安全事件分布图读取 `events.distribution` 和 `events.byBusinessSystem`。
- 4 张高危事件表分别用 `data-repeat`。
- 典型案例整块先保留一个 `data-section="threatOps.caseStudy"`，因为结构复杂。

### 5.6 威胁预防 - 互联网业务

动态字段：

- `threatPrevention.internet.exposure.total`
- `threatPrevention.internet.exposure.risky`
- `threatPrevention.internet.exposure.assets`
- `threatPrevention.internet.exposure.riskyAssets`
- `threatPrevention.internet.exposure.webServiceDistribution`
- `threatPrevention.internet.exposure.nonWebServiceDistribution`
- `threatPrevention.internet.exposure.highRiskAssetServices`
- `threatPrevention.internet.exposure.topRisks`
- `threatPrevention.internet.vulns.summary`
- `threatPrevention.internet.vulns.bySeverity`
- `threatPrevention.internet.vulns.byPriority`
- `threatPrevention.internet.vulns.topTypes`
- `threatPrevention.internet.vulns.topAssets`
- `threatPrevention.internet.weakPasswords.summary`
- `threatPrevention.internet.weakPasswords.bySystem`
- `threatPrevention.internet.weakPasswords.byAsset`

改造方式：

- KPI 数字用 `data-field`。
- 各 TOP5/明细表用 `data-repeat`。
- 图表读取对应数组。
- 解读段落使用 `data-section`，不要把 IP/端口写死在模板中。

### 5.7 威胁预防 - 内网业务

动态字段：

- `threatPrevention.intranet.vulns.summary`
- `threatPrevention.intranet.vulns.bySeverity`
- `threatPrevention.intranet.vulns.byPriority`
- `threatPrevention.intranet.vulns.topTypes`
- `threatPrevention.intranet.vulns.byBusinessSystem`
- `threatPrevention.intranet.vulns.topAssets`
- `threatPrevention.intranet.weakPasswords.summary`
- `threatPrevention.intranet.weakPasswords.bySystem`
- `threatPrevention.intranet.weakPasswords.byAsset`

改造方式：

- 和互联网业务一致：KPI 用 `data-field`，表格用 `data-repeat`，说明/解读用 `data-section`。

### 5.8 附录

附录里的评估原则、评级定义、CVSS 说明属于静态知识，默认不动态化。

动态字段：

- `appendix.priorityMatrix`

改造方式：

- “漏洞修复优先级”图表如果只是规则说明，可静态保留。
- 如果要按本次报告数据染色或突出数量，读取 `appendix.priorityMatrix`。

## 6. 当前 `data-chart` 映射

| data-chart | 数据路径 | 处理方式 |
| --- | --- | --- |
| `slot-asset-stats` | `assetLedger.*` | KPI + 三个资产分布图 |
| `slot-risk-overview` | `riskOverview.*` | 总览 KPI + 评分/链路图 |
| `slot-top5-risk` | `riskOverview.topRiskAssets` | 图表 + 表格同源 |
| `slot-threat-ops` | `threatOps.*` | 运营总览图 |
| `m2-xdr-pipeline-v` | `threatOps.pipeline` | 漏斗图 |
| `slot-event-charts` | `threatOps.events.*` | 事件类型/业务系统分布 |
| `slot-attack-chain` | `threatOps.caseStudy.timeline` | 典型案例攻击链 |
| `slot-internet-exposure` | `threatPrevention.internet.exposure.*` | 暴露面 KPI/分布/TOP5 |
| `slot-internet-vuln` | `threatPrevention.internet.vulns.*` | 外网漏洞统计 |
| `slot-internet-weak` | `threatPrevention.internet.weakPasswords.*` | 外网弱密码统计 |
| `slot-intranet-vuln` | `threatPrevention.intranet.vulns.*` | 内网漏洞统计 |
| `slot-intranet-weak` | `threatPrevention.intranet.weakPasswords.*` | 内网弱密码统计 |
| `slot-appendix-priority` | `appendix.priorityMatrix` | 修复优先级矩阵 |

## 7. 表格命名标准

当前模板里的动态业务表格应迁移为：

| 当前位置 | 标准标记 |
| --- | --- |
| 关键风险表 | `<tbody data-repeat="riskOverview.keyRisks"></tbody>` |
| 风险资产 TOP5 表 | `<tbody data-repeat="riskOverview.topRiskAssets"></tbody>` |
| 漏洞利用事件表 | `<tbody data-repeat="threatOps.highRisk.vulnExploits"></tbody>` |
| 高危 Web 攻击表 | `<tbody data-repeat="threatOps.highRisk.webAttacks"></tbody>` |
| 高危病毒表 | `<tbody data-repeat="threatOps.highRisk.viruses"></tbody>` |
| 主机失陷外联表 | `<tbody data-repeat="threatOps.highRisk.c2Connections"></tbody>` |
| 互联网暴露服务 TOP5 | `<tbody data-repeat="threatPrevention.internet.exposure.topRisks"></tbody>` |
| 互联网漏洞类型表 | `<tbody data-repeat="threatPrevention.internet.vulns.topTypes"></tbody>` |
| 互联网漏洞资产表 | `<tbody data-repeat="threatPrevention.internet.vulns.topAssets"></tbody>` |
| 内网漏洞类型表 | `<tbody data-repeat="threatPrevention.intranet.vulns.topTypes"></tbody>` |
| 内网业务系统漏洞表 | `<tbody data-repeat="threatPrevention.intranet.vulns.byBusinessSystem"></tbody>` |

附录里的评级定义表默认保留静态 HTML。

## 8. 迁移检查清单

每改一块模板，必须满足：

1. 没有客户相关示例词：`示例科技有限公司`。
2. 没有示例报告日期：`2026-01-01`、`2026-03-31`。
3. 动态业务数字不裸写在正文、KPI、表格或 JS 数组里。
4. 表格 `<tbody>` 不保留示例行，改为 `data-repeat` 或明确标记为静态。
5. 图表数组不直接写死业务值，改为读取 `window.SECURITY_REPORT_DATA`。
6. mock 数据和真实数据都走同一个 `reportData` 契约。
7. `npm test` 和一次 mock 生成通过。

## 9. 推荐落地顺序

1. 封面、标题、背景段落。
2. 资产台账 KPI 和资产摘要。
3. 风险总览 KPI、评级、关键风险表、TOP5 表。
4. 威胁运营 KPI 和高危事件表。
5. 互联网暴露面与外网漏洞。
6. 内网漏洞与弱密码。
7. 图表 JS 逐个改为读 `window.SECURITY_REPORT_DATA`。
8. 删除 renderer 里的过渡兼容替换。
