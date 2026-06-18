---
name: health-checkup-report
description: 生成指定客户、指定时间段的安全体检 HTML 报告。用户在企微要求“生成 xxx 客户 x月x日到 x月x日安全体检报告”且最终需要 HTML 附件时使用。
---

# 安全体检 HTML 报告

本技能负责查询/汇总 MSS 与 XDR 数据，并生成可直接发送给用户的 HTML 报告。

## 前置条件

- MSS Cookie: `M:\Users\$env:USERNAME\Downloads\cookies.txt`
- XDR Cookie: `M:\Users\$env:USERNAME\Downloads\xdr_cookies.txt`
- 当前项目使用 Node.js 18+

## 命令

```powershell
node "$HOME\.openclaw\workspace\skills\health-checkup-report\health_report.js" `
  --customer "<客户名>" `
  --start "<开始日期>" `
  --cookie-path "M:\Users\$env:USERNAME\Downloads\cookies.txt" `
  --xdr-cookie-path "M:\Users\$env:USERNAME\Downloads\xdr_cookies.txt"
```

骨架开发阶段可使用 mock：

```powershell
node "$HOME\.openclaw\workspace\skills\health-checkup-report\health_report.js" `
  --customer "<客户名>" `
  --start "<开始日期>"
```

`--end` 可选；未传时脚本使用执行当天作为结束日期，格式为 `YYYY-MM-DD`。

## 输出

脚本会把用于 HTML 的结构化数据落盘到 `output\report-data.json`；如需指定路径，可传 `--output-json "<JSON路径>"`。脚本返回 JSON，其中 `html_path` 是生成的 HTML 附件路径，`xdrExports` 是本次自动导出的 XDR 表格文件路径。第一章数据使用 `projectBackground.*`，事件闭环统计写入 `riskDetails.*`。

## 缺参数处理

生成必须有：

- `customer`
- `start`

缺少客户或开始日期时先追问，不要猜。
