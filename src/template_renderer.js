'use strict';

const fs = require('fs/promises');
const path = require('path');

const DATA_FIELD_MAP = {
  'ops.devices-v': 'ops.devices',
  'ops.sangfor-v': 'ops.sangfor',
  'ops.log_reduce-v': 'ops.logReduce',
  'ops.alert_reduce-v': 'ops.alertReduce',
  'ops.severe-v': 'ops.severe',
  'ops.high-v': 'ops.high'
};

const SECTION_RENDERERS = {
  'assetLedger.summary': renderAssetLedgerSummary,
  'riskOverview.summary': renderRiskOverviewSummary
};

const REPEAT_RENDERERS = {
  'riskOverview.keyRisks': renderKeyRiskRows
};

async function renderReportToFile({ templatePath, outputDir, reportData }) {
  const template = await fs.readFile(templatePath, 'utf8');
  const html = renderTemplate(template, reportData);
  await fs.mkdir(outputDir, { recursive: true });

  const filename = buildOutputFilename(reportData);
  const outputPath = path.join(outputDir, filename);
  await fs.writeFile(outputPath, html, 'utf8');

  return {
    ok: true,
    html_path: outputPath,
    customer: getProjectBackground(reportData).customerName,
    start: getProjectBackground(reportData).startDate,
    end: getProjectBackground(reportData).endDate
  };
}

function renderTemplate(template, reportData) {
  let html = template;

  html = replaceHandlebarsTokens(html, reportData);
  html = renderSections(html, reportData);
  html = renderRepeats(html, reportData);
  html = patchKnownText(html, reportData);
  html = patchDataFields(html, reportData);
  html = injectReportData(html, reportData);

  return html;
}

function replaceHandlebarsTokens(html, data) {
  return html.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, keyPath) => {
    const value = getPath(data, keyPath);
    return value === undefined || value === null ? '' : escapeHtml(String(value));
  });
}

function patchKnownText(html, data) {
  const projectBackground = getProjectBackground(data);
  const customer = projectBackground.customerName || '';
  const start = projectBackground.startDate || '';
  const end = projectBackground.endDate || '';
  const title = projectBackground.title || '安全体检报告';
  const period = `${start} ~ ${end}`;

  return html
    .replace(/<meta name="report-data-mode" content="[^"]*">/, '<meta name="report-data-mode" content="generated">')
    .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(title)} - ${escapeHtml(customer)}</title>`)
    .replace(/<h1>首次安全体检报告<\/h1>/, `<h1>${escapeHtml(title)}</h1>`)
    .replace(/示例科技有限公司 · 2026-01-01 ~ 2026-03-31/g, `${escapeHtml(customer)} · ${escapeHtml(period)}`)
    .replace(/「示例科技有限公司」/g, `「${escapeHtml(customer)}」`)
    .replace(/示例科技有限公司/g, escapeHtml(customer))
    .replace(/2026-01-01 ~ 2026-03-31/g, escapeHtml(period));
}

function patchDataFields(html, data) {
  return html.replace(/(<[^>]+data-field="([^"]+)"[^>]*>)(.*?)(<\/[^>]+>)/g, (match, open, field, inner, close) => {
    const keyPath = DATA_FIELD_MAP[field] || field;
    const value = getPath(data, keyPath);
    return value === undefined || value === null ? match : `${open}${escapeHtml(String(value))}${close}`;
  });
}

function renderSections(html, data) {
  return html.replace(/<([a-zA-Z0-9]+)([^>]*)data-section="([^"]+)"([^>]*)><\/\1>/g, (match, tag, before, sectionName, after) => {
    const renderer = SECTION_RENDERERS[sectionName];
    if (!renderer) {
      return match;
    }

    return `<${tag}${before}data-section="${sectionName}"${after}>${renderer(data)}</${tag}>`;
  });
}

function renderRepeats(html, data) {
  return html.replace(/<tbody([^>]*)data-repeat="([^"]+)"([^>]*)><\/tbody>/g, (match, before, repeatName, after) => {
    const renderer = REPEAT_RENDERERS[repeatName];
    if (!renderer) {
      return match;
    }

    const rows = getPath(data, repeatName) || [];
    return `<tbody${before}data-repeat="${repeatName}"${after}>${renderer(rows)}</tbody>`;
  });
}

function renderAssetLedgerSummary(data) {
  const assetLedger = data.assetLedger || {};
  return [
    paragraph(`【资产统计】台账资产${displayValue(assetLedger.manage_asset)}个，核心资产${displayValue(assetLedger.core_asset)}个，退库资产${displayValue(assetLedger.eliminate_asset)}个，待审核资产${displayValue(assetLedger.approve_asset)}个`),
    paragraph(`【资产类型分布】${formatNameValueList(assetLedger.typeDistribution)}`),
    paragraph(`【资产防护统计】${formatNameValueList(assetLedger.protectionDistribution)}`),
    paragraph(`【互联网暴露资产】${formatNameValueList(assetLedger.internetExposureDistribution)}`)
  ].join('');
}

function renderRiskOverviewSummary(data) {
  const overview = data.riskOverview || {};
  const systems = Array.isArray(overview.keySystems) ? overview.keySystems.join('、') : '';
  return paragraph(`本次安全体检中，您的核心业务系统「${escapeHtml(systems)}等」存在 <strong>${num(overview.total)}</strong> 个安全风险，其中【${escapeHtml(overview.topSystem || '')}】风险较大，系统下的资产存在 <strong>${num(overview.topSystemHighRisks)}</strong> 个高危及以上的安全风险。`);
}

function renderKeyRiskRows(rows) {
  if (!rows.length) {
    return '<tr><td colspan="5">暂无关键风险数据</td></tr>';
  }

  return rows.map((row) => [
    '<tr>',
    `<td>${escapeHtml(row.risk || '')}</td>`,
    `<td>${escapeHtml(row.description || '')}</td>`,
    `<td>${escapeHtml(row.impact || '')}</td>`,
    `<td>${formatLines(row.strategy)}</td>`,
    `<td>${formatLines(row.status)}</td>`,
    '</tr>'
  ].join('')).join('');
}

function paragraph(text) {
  return `<p class="sr-p">${text}</p>`;
}

function num(value) {
  return escapeHtml(String(value === undefined || value === null ? 0 : value));
}

function displayValue(value) {
  return escapeHtml(String(value === undefined || value === null ? '暂无数据' : value));
}

function formatNameValueList(items) {
  if (!Array.isArray(items) || !items.length) {
    return '暂无数据';
  }

  return items.map((item) => `${escapeHtml(String(item.name || '未命名'))}${num(item.value)}个`).join('，');
}

function formatLines(value) {
  const lines = Array.isArray(value) ? value : [value || ''];
  return lines.map((line, index) => `${index + 1}.${escapeHtml(String(line))}`).join('<br>');
}

function injectReportData(html, data) {
  const payload = JSON.stringify(data).replace(/</g, '\\u003c');
  const script = `<script>window.SECURITY_REPORT_DATA=${payload};</script>`;

  if (html.includes('window.SECURITY_REPORT_DATA=')) {
    return html.replace(/<script>window\.SECURITY_REPORT_DATA=.*?<\/script>/, script);
  }

  return html.replace('</head>', `${script}\n</head>`);
}

function buildOutputFilename(data) {
  const projectBackground = getProjectBackground(data);
  const raw = `${projectBackground.customerName || '客户'}_${projectBackground.startDate || 'start'}_${projectBackground.endDate || 'end'}_安全体检报告.html`;
  return raw.replace(/[\\/:*?"<>|]/g, '_');
}

function getPath(obj, keyPath) {
  const normalizedPath = keyPath.startsWith('report.')
    ? `projectBackground.${keyPath.slice('report.'.length)}`
    : keyPath;
  return normalizedPath.split('.').reduce((current, key) => {
    if (current && Object.prototype.hasOwnProperty.call(current, key)) {
      return current[key];
    }
    return undefined;
  }, obj);
}

function getProjectBackground(data) {
  return data.projectBackground || data.report || {};
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  renderReportToFile,
  renderTemplate,
  getPath
};
