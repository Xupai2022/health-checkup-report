# Health Checkup Report

生成指定客户、指定时间段的安全体检 HTML 报告。

当前版本可以生成 HTML 报告；提供 XDR Cookie 时，会在同一次运行中导出配置的 XDR 表格并拉取资产台账统计。

## Run

```powershell
node health_report.js `
  --customer "示例客户" `
  --start "2026-06-01" `
  --end "2026-06-16" `
  --xdr-cookie-path "M:\Users\$env:USERNAME\Downloads\xdr_cookies.txt"
```

`--end` 可省略，默认取脚本执行当天，格式为 `YYYY-MM-DD`。

输出文件默认写入 `output/`。接口拿到并用于填充 HTML 的结构化数据会落盘到 `output/report-data.json`，可用 `--output-json` 指定路径。

默认只输出简洁摘要；如需完整 JSON 结果，加 `--json`。

默认会导出 `asset,incident`。如需指定表格：

```powershell
node health_report.js `
  --customer "示例客户" `
  --start "2026-06-01" `
  --end "2026-06-16" `
  --xdr-cookie-path "M:\Users\$env:USERNAME\Downloads\xdr_cookies.txt" `
  --xdr-tables "asset,incident"
```

## Data Contract

当前 `output/report-data.json` 的字段约定如下。后续新增取值逻辑必须继续补这张表。

| 字段 | 语义 | 来源 | 取值逻辑 |
| --- | --- | --- | --- |
| `projectBackground.title` | 报告标题 | CLI / 默认值 | 固定为 `首次安全体检报告` |
| `projectBackground.customerName` | 客户名称 | `--customer` | 直接取命令行参数 |
| `projectBackground.customerId` | 客户 ID | `--customer-id` | 直接取命令行参数，未传则 `null` |
| `projectBackground.startDate` | 报告开始日期 | `--start` | 直接取命令行参数 |
| `projectBackground.endDate` | 报告结束日期 | `--end` | 未传则取脚本执行当天 |
| `projectBackground.generatedAt` | 数据生成时间 | 运行时 | 取脚本执行时的 ISO 时间字符串 |
| `assetLedger.approve_asset` | 待审核资产数 | XDR 资产统计接口 | 取资产统计接口返回 `approve_asset` |
| `assetLedger.core_asset` | 核心资产数 | XDR 资产统计接口 | 取资产统计接口返回 `core_asset` |
| `assetLedger.eliminate_asset` | 退库资产数 | XDR 资产统计接口 | 取资产统计接口返回 `eliminate_asset` |
| `assetLedger.manage_asset` | 台账资产数 | XDR 资产统计接口 | 取资产统计接口返回 `manage_asset` |
| `assetLedger.typeDistribution` | 资产类型分布 | XDR 资产类型接口 | 按接口返回的 `server / terminal / other` 组装为数组 |
| `assetLedger.protectionDistribution` | 资产防护统计 | XDR 资产防护接口 | 按接口返回的 `online / offline / disabled / demoted / unprotected` 组装为数组 |
| `assetLedger.internetExposureDistribution` | 互联网暴露资产分布 | XDR 互联网暴露接口 | 按接口返回的 `server / terminal / other` 组装为数组 |
| `riskDetails.totalAlerts` | 告警总数 | XDR 告警查询接口 | 取告警查询接口 `data.total` |
| `riskDetails.totalEvents` | 事件总数 | XDR 事件数量接口 + 导出的事件表 Excel | 优先取数量接口 `data.total`，并用导出表统计结果校正闭环率 |
| `riskDetails.severeEvents` | 严重事件数 | 导出的事件表 Excel | 统计 C 列值等于 `严重` 的事件行数 |
| `riskDetails.highEvents` | 高危事件数 | 导出的事件表 Excel | 统计 C 列值等于 `高危` 的事件行数 |
| `riskDetails.closedEvents` | 已闭环事件数 | 导出的事件表 Excel | 统计 S 列值等于 `已闭环` 的事件行数 |
| `riskDetails.processingEvents` | 处置中事件数 | 导出的事件表 Excel | 统计 S 列值等于 `处置中` 的事件行数 |
| `riskDetails.closeRate` | 闭环率 | 导出的事件表 Excel | `已闭环 / 总事件数 * 100`，四舍五入为整数 |
| `riskDetails.uniqueAssetCount` | 涉及资产数 | 导出的事件表 Excel | 取 G 列 IP 部分去重计数，格式 `ip(资产组名)` 截取 `(` 前部分 |
| `riskDetails.averageContainMin` | 威胁平均遏制时间 | 导出的事件表 Excel | 统计 AB 列所有非空单元格的平均值，空格跳过，四舍五入为整数 |

说明：

- 真实模式下，结构化 JSON 以 `projectBackground`、`assetLedger`、`riskDetails`、`riskOverview`、`appendix` 为主。
- `riskOverview` 当前主要给模板里的风险总览章节预留，后续新增真实取值时必须继续补上来源和逻辑。

## Template Strategy

模板改造标准见 [TEMPLATE_STANDARD.md](./TEMPLATE_STANDARD.md)。

推荐模板里显式放占位符：

```html
{{ projectBackground.customerName }}
{{ projectBackground.startDate }}
{{ assetLedger.manage_asset }}
```

对于已有模板中的 KPI，可继续使用：

```html
<div data-field="assetLedger.manage_asset">520</div>
```

渲染器会按数据路径回填 `data-field` 的文本内容，并把完整 `window.SECURITY_REPORT_DATA` 注入页面，方便后续图表脚本读取结构化数据。

复杂表格、列表、图表建议不要靠纯文本替换，后续应扩展成命名 section renderer，例如 `renderKeyRisksTable(reportData.risks.keyRisks)`。
