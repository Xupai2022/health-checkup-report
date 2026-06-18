'use strict';

const assert = require('assert');
const { renderTemplate } = require('../src/template_renderer');
const data = {
  projectBackground: {
    title: '首次安全体检报告',
    customerName: '测试客户',
    customerId: null,
    startDate: '2026-05-01',
    endDate: '2026-05-31',
    generatedAt: '2026-05-31T00:00:00.000Z'
  },
  assetLedger: {
    manage_asset: 520,
    typeDistribution: [],
    protectionDistribution: [],
    internetExposureDistribution: []
  },
  riskOverview: {
    keyRisks: [
      {
        risk: '【威胁运营】大量病毒文件、C2外联事件',
        description: 'desc',
        impact: 'impact',
        strategy: ['s1'],
        status: ['t1']
      }
    ]
  },
  riskDetails: {
    totalEvents: 86,
    severeEvents: 8,
    highEvents: 28,
    closedEvents: 68,
    processingEvents: 18,
    closeRate: 79,
    averageContainMin: 8
  }
};

const html = renderTemplate(`
<html><head><meta name="report-data-mode" content="mock"><title>首次安全体检报告 - 示例科技有限公司</title></head>
<body>
<h1>首次安全体检报告</h1>
<p>示例科技有限公司 · 2026-01-01 ~ 2026-03-31</p>
<p>{{ projectBackground.customerName }}</p>
<div data-field="assetLedger.manage_asset">0</div>
<p>严重事件 <span data-field="riskDetails.severeEvents">0</span> 起，高危事件 <span data-field="riskDetails.highEvents">0</span> 起，已闭环 <span data-field="riskDetails.closedEvents">0</span> 起，处置中 <span data-field="riskDetails.processingEvents">0</span> 起（闭环率：<span data-field="riskDetails.closeRate">0</span>%）。</p>
<p>事件遏制 72 起，平均遏制时间 <span data-field="riskDetails.averageContainMin">0</span> 分钟；</p>
<div data-section="assetLedger.summary"></div>
<table><tbody data-repeat="riskOverview.keyRisks"></tbody></table>
</body></html>
`, data);

assert(html.includes('<meta name="report-data-mode" content="generated">'));
assert(html.includes('<title>首次安全体检报告 - 测试客户</title>'));
assert(html.includes('测试客户 · 2026-05-01 ~ 2026-05-31'));
assert(html.includes('<p>测试客户</p>'));
assert(html.includes('<div data-field="assetLedger.manage_asset">520</div>'));
assert(html.includes('严重事件 <span data-field="riskDetails.severeEvents">8</span> 起，高危事件 <span data-field="riskDetails.highEvents">28</span> 起，已闭环 <span data-field="riskDetails.closedEvents">68</span> 起，处置中 <span data-field="riskDetails.processingEvents">18</span> 起（闭环率：<span data-field="riskDetails.closeRate">79</span>%）。'));
assert(html.includes('事件遏制 72 起，平均遏制时间 <span data-field="riskDetails.averageContainMin">8</span> 分钟；'));
assert(html.includes('【资产统计】台账资产520个'));
assert(html.includes('<tbody data-repeat="riskOverview.keyRisks"><tr><td>【威胁运营】大量病毒文件、C2外联事件</td>'));
assert(html.includes('window.SECURITY_REPORT_DATA='));

console.log('renderer.test.js passed');
