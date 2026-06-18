'use strict';

const { fetchXdrAssetOverview } = require('./xdr_asset_client');

async function collectReportData(input) {
  if (input.xdrCookiePath) {
    logInfo(input.logger, '使用 XDR 数据生成报告资产台账');
    const baseData = buildBaseReportData(input);
    const xdrData = await fetchXdrAssetOverview(input.xdrCookiePath, {
      logger: input.logger,
      projectBackground: {
        customerName: input.customer || '',
        customerId: input.customerId || null,
        startDate: input.start || '',
        endDate: input.end || ''
      }
    });

    return applyIncidentStatusStats(deepMerge(baseData, xdrData), input.incidentStatusStats);
  }

  throw new Error('Real data source requires --xdr-cookie-path.');
}

function logInfo(logger, message) {
  if (typeof logger === 'function') {
    logger(message);
  }
}

function applyIncidentStatusStats(reportData, stats) {
  if (!stats) {
    return reportData;
  }

  return deepMerge(reportData, {
    riskDetails: {
      totalEvents: Number(stats.totalEvents || 0),
      severeEvents: Number(stats.severeEvents || 0),
      highEvents: Number(stats.highEvents || 0),
      closedEvents: Number(stats.closedEvents || 0),
      processingEvents: Number(stats.processingEvents || 0),
      closeRate: Number(stats.closeRate || 0)
    }
  });
}

function buildBaseReportData(input) {
  return {
    projectBackground: {
      title: '首次安全体检报告',
      customerName: input.customer,
      customerId: input.customerId || null,
      startDate: input.start,
      endDate: input.end,
      generatedAt: new Date().toISOString()
    },
    assetLedger: {},
    riskOverview: {},
    riskDetails: {},
    appendix: {}
  };
}

function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch;
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = isPlainObject(value) && isPlainObject(merged[key])
      ? deepMerge(merged[key], value)
      : value;
  }
  return merged;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  collectReportData
};
