'use strict';

const assert = require('assert');
const path = require('path');

async function main() {
  const xdrClientPath = path.resolve(__dirname, '..', 'src', 'xdr_asset_client.js');
  require.cache[xdrClientPath] = {
    id: xdrClientPath,
    filename: xdrClientPath,
    loaded: true,
    exports: {
      fetchXdrAssetOverview: async () => ({
        assetLedger: {
          manage_asset: 555,
          typeDistribution: [{ name: '服务器', value: 115 }]
        },
        projectBackground: {
          customerName: '测试客户',
          startDate: '2026-06-01',
          endDate: '2026-06-16'
        },
        riskOverview: {},
        riskDetails: {},
        appendix: {}
      })
    }
  };

  const { collectReportData } = require('../src/data_client');
  const data = await collectReportData({
    customer: '测试客户',
    start: '2026-06-01',
    end: '2026-06-16',
    xdrCookiePath: 'fake-cookie.txt',
    incidentStatusStats: {
      totalEvents: 177,
      closedEvents: 12,
      processingEvents: 3,
      closeRate: 7
    },
    logger: () => {}
  });

  assert.strictEqual(data.projectBackground.customerName, '测试客户');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(data, 'report'), false);
  assert.strictEqual(data.assetLedger.manage_asset, 555);
  assert.strictEqual(data.riskDetails.totalEvents, 177);
  assert.strictEqual(data.riskDetails.severeEvents, 0);
  assert.strictEqual(data.riskDetails.highEvents, 0);
  assert.strictEqual(data.riskDetails.closedEvents, 12);
  assert.strictEqual(data.riskDetails.processingEvents, 3);
  assert.strictEqual(data.riskDetails.closeRate, 7);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(data, 'ops'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(data, 'risks'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(data.riskOverview, 'keyRisks'), false);

  console.log('data_client.test.js passed');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
