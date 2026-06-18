#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs/promises');
const { parseArgs, requireArgs } = require('./src/args');
const { collectReportData } = require('./src/data_client');
const { summarizeIncidentStatus } = require('./src/incident_excel_stats');
const { exportXdrAssetList, exportXdrIncidentList, fetchXdrAssetOverview, fetchAlertTableCount, readXdrCookieInfo, resolveWorkingXdrBaseUrl, collectDeviceCategoryCounts } = require('./src/xdr_asset_client');
const { renderReportToFile } = require('./src/template_renderer');

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const logger = createLogger(options);
  const emitJson = options.json === true || options.json === 'true';

  if (command === 'help' || options.help) {
    printHelp();
    return;
  }

  if (command && command !== 'generate') {
    if (command === 'xdr-asset-export') {
      const result = await exportXdrAssetList({
        xdrCookiePath: options['xdr-cookie-path'],
        downloadDir: options['download-dir'],
        timeoutMs: options['timeout-ms'] ? Number(options['timeout-ms']) : undefined,
        logger
      });
      outputResult(result, emitJson, logger, `XDR 资产表已导出: ${result.filePath}`);
      return;
    }

    if (command === 'xdr-incident-export') {
      const result = await exportXdrIncidentList({
        xdrCookiePath: options['xdr-cookie-path'],
        downloadDir: options['download-dir'],
        start: options.start,
        end: options.end,
        timeoutMs: options['timeout-ms'] ? Number(options['timeout-ms']) : undefined,
        pollIntervalMs: options['poll-interval-ms'] ? Number(options['poll-interval-ms']) : undefined,
        logger
      });
      outputResult(result, emitJson, logger, `XDR 事件表已导出: ${result.filePath}`);
      return;
    }

    if (command === 'xdr-asset-summary') {
      const root = __dirname;
      const end = options.end || formatLocalDate(new Date());
      const result = await fetchXdrAssetOverview(options['xdr-cookie-path'], {
        logger,
        projectBackground: {
          customerName: options.customer || '',
          customerId: options['customer-id'] || null,
          startDate: options.start || '',
          endDate: end
        }
      });
      const outputJson = options['output-json'] || path.join(root, 'output', 'xdr-asset-summary.json');
      const merged = await mergeJsonFile(outputJson, result);
      outputResult(merged, emitJson, logger, `XDR 资产台账统计已更新: ${outputJson}`);
      return;
    }

    throw new Error(`Unsupported command: ${command}`);
  }

  requireArgs(options, ['customer', 'start']);

  const root = __dirname;
  const templatePath = options.template || path.join(root, 'security-report-preview.html');
  const outputDir = options['output-dir'] || path.join(root, 'output');
  const end = options.end || formatLocalDate(new Date());

  logger(`开始生成: ${options.customer} ${options.start} ~ ${end}`);

  const xdrExports = await exportConfiguredXdrTables({
    xdrCookiePath: options['xdr-cookie-path'],
    downloadDir: options['download-dir'],
    start: options.start,
    end,
    xdrTables: options['xdr-tables'],
    timeoutMs: options['timeout-ms'] ? Number(options['timeout-ms']) : undefined,
    pollIntervalMs: options['poll-interval-ms'] ? Number(options['poll-interval-ms']) : undefined,
    logger
  });
  if (Object.keys(xdrExports).length) {
    logger(`XDR 导出完成: ${Object.keys(xdrExports).join(', ')}`);
  } else {
    logger('跳过 XDR 导出');
  }

  const incidentStatusStats = await summarizeExportedIncidentStatus(xdrExports, logger);

  const reportData = await collectReportData({
    customer: options.customer,
    customerId: options['customer-id'],
    start: options.start,
    end,
    xdrCookiePath: options['xdr-cookie-path'],
    incidentStatusStats,
    logger
  });

  if (options['xdr-cookie-path']) {
    let cookieInfo, resolved;
    try {
      cookieInfo = await readXdrCookieInfo(options['xdr-cookie-path']);
      resolved = await resolveWorkingXdrBaseUrl(cookieInfo, options['xdr-base-url'], logger);
    } catch (error) {
      logger(`初始化 XDR 连接失败: ${error.message}`);
      reportData.riskDetails.totalAlerts = 0;
    }

    if (cookieInfo && resolved) {
      try {
        logger('正在查询 XDR 告警总数...');
        const alertCountResult = await fetchAlertTableCount(cookieInfo, resolved.xdrBaseUrl, {
          start: options.start,
          end
        });
        reportData.riskDetails.totalAlerts = alertCountResult.total;
        logger(`告警总数: ${alertCountResult.total}`);
      } catch (error) {
        logger(`获取告警总数失败: ${error.message}，将跳过告警数`);
        reportData.riskDetails.totalAlerts = 0;
      }

      try {
        logger('正在查询设备分类数量...');
        const deviceCounts = await collectDeviceCategoryCounts(cookieInfo, resolved.xdrBaseUrl, logger);
        reportData.riskDetails = Object.assign(reportData.riskDetails || {}, deviceCounts);
        logger(`设备总数: ${deviceCounts.devices}, AF: ${deviceCounts.af}, AES: ${deviceCounts.aes}, SIP: ${deviceCounts.sip}, STA: ${deviceCounts.sta}`);
      } catch (error) {
        logger(`获取设备分类数量失败: ${error.message}，将跳过设备分类统计`);
      }
    }
  }
  const reportDataJsonPath = options['output-json'] || path.join(outputDir, 'report-data.json');
  await writeJsonFile(reportDataJsonPath, reportData);
  logger(`数据已写入: ${reportDataJsonPath}`);

  const result = await renderReportToFile({
    templatePath,
    outputDir,
    reportData
  });
  logger(`HTML 已生成: ${result.html_path || result.filePath || ''}`);

  outputResult({
    ...result,
    xdrExports
  }, emitJson, logger, `完成: ${result.html_path || result.filePath || ''}`);
}

function printHelp() {
  console.log(`Usage:
  node health_report.js --customer "客户名" --start YYYY-MM-DD [--end YYYY-MM-DD] [options]

Options:
  --customer-id <id>             Optional customer id
  --customer <name>              Customer name
  --start <YYYY-MM-DD>           Report start date
  --end <YYYY-MM-DD>             Optional end date, default is script execution date
  --xdr-cookie-path <path>       XDR cookie file path
  --xdr-tables <names>           Optional XDR export tables, default asset,incident
  --download-dir <path>          Optional XDR download directory override
  --output-json <path>           Optional report data JSON path, default output/report-data.json
  --json                         Print full JSON result to stdout
  --timeout-ms <ms>              Optional wait timeout for XDR download
  --poll-interval-ms <ms>        Optional XDR event export polling interval
  --template <path>              HTML template path
  --output-dir <path>            Output directory
`);
}

async function exportConfiguredXdrTables(options) {
  if (!options.xdrCookiePath) {
    return {};
  }

  const tables = parseXdrTables(options.xdrTables);
  logWith(options.logger, `准备导出 XDR 表格: ${tables.join(', ')}`);
  const results = {};
  for (const table of tables) {
    if (table === 'asset') {
      logWith(options.logger, '开始处理表格: asset');
      results.asset = await exportXdrAssetList({
        xdrCookiePath: options.xdrCookiePath,
        downloadDir: options.downloadDir,
        timeoutMs: options.timeoutMs,
        logger: options.logger
      });
      continue;
    }

    if (table === 'incident') {
      logWith(options.logger, '开始处理表格: incident');
      results.incident = await exportXdrIncidentList({
        xdrCookiePath: options.xdrCookiePath,
        downloadDir: options.downloadDir,
        start: options.start,
        end: options.end,
        timeoutMs: options.timeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        logger: options.logger
      });
      continue;
    }

    throw new Error(`Unsupported XDR export table: ${table}`);
  }

  return results;
}

function createLogger(options = {}) {
  if (options.quiet === true || options.quiet === 'true') {
    return () => {};
  }

  return (message) => {
    console.error(message);
  };
}

function outputResult(result, emitJson, logger, summary) {
  if (emitJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (summary) {
    logger(summary);
  }
}

function logWith(logger, message) {
  if (typeof logger === 'function') {
    logger(message);
  }
}

async function summarizeExportedIncidentStatus(xdrExports, logger) {
  const incidentFilePath = xdrExports && xdrExports.incident ? xdrExports.incident.filePath : '';
  if (!incidentFilePath) {
    return null;
  }

  logWith(logger, `开始统计事件表处置状态: ${incidentFilePath}`);
  const stats = await summarizeIncidentStatus(incidentFilePath);
  if (Number.isFinite(Number(xdrExports.incident.totalEvents))) {
    stats.totalEvents = Number(xdrExports.incident.totalEvents);
    stats.closeRate = stats.totalEvents ? Math.round((stats.closedEvents / stats.totalEvents) * 100) : 0;
  }
  logWith(logger, `事件表统计完成: 事件数 ${stats.totalEvents} 起，严重 ${stats.severeEvents} 起，高危 ${stats.highEvents} 起，涉及资产 ${stats.uniqueAssetCount} 个，已闭环 ${stats.closedEvents} 起，处置中 ${stats.processingEvents} 起，闭环率 ${stats.closeRate}%`);
  return stats;
}

function parseXdrTables(value) {
  const raw = value || 'asset,incident';
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function writeJsonFile(filePath, data) {
  const resolvedPath = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, JSON.stringify(data, null, 2), 'utf8');
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function mergeJsonFile(filePath, patch) {
  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const merged = deepMerge(existing, patch);
  delete merged.report;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
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

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
