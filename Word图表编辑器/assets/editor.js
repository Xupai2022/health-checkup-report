(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  // 增量重绘开关。默认打开：模板侧的重绘入口（window.SRChartRerender）已经上线，
  // 编辑器这边也验证过"增量输出 == 整份重载输出"。旧报告、嵌入式看板、
  // 分页模式、以及任何一张图没注册的情况都会自动回落到整份重载，那条路一行没动。
  // 用 ?incremental=0 可以强制关掉，方便出问题时对照。
  const INCREMENTAL_REDRAW = window.SR_EDITOR_INCREMENTAL !== false
    && new URLSearchParams(location.search).get('incremental') !== '0';
  const state = { docx: null, docxFile: null, selectedPath: '', selectedMediaItem: null, replacements: new Map(), charts: [], activeChart: null, reportData: null, sourceHtml: '', gradeAssets: {}, media: [], mediaMetadata: new Map(), renderVersion: 0, frameLoadVersion: 0, edits: new Map(), previewBlob: null, previewPath: '', previewPending: false };
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function setStatus(message, kind = '') {
    const el = $('status'); el.textContent = message; el.className = `status ${kind}`;
  }
  function u16(bytes, offset) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true); }
  function u32(bytes, offset) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true); }
  function put16(view, offset, value) { view.setUint16(offset, value, true); }
  function put32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }
  function concat(parts) { const size = parts.reduce((n, p) => n + p.length, 0); const out = new Uint8Array(size); let pos = 0; parts.forEach((p) => { out.set(p, pos); pos += p.length; }); return out; }
  async function streamBytes(bytes, Stream) { const stream = new Blob([bytes]).stream().pipeThrough(new Stream('deflate-raw')); return new Uint8Array(await new Response(stream).arrayBuffer()); }
  async function inflate(bytes) { return streamBytes(bytes, DecompressionStream); }
  async function deflate(bytes) { return streamBytes(bytes, CompressionStream); }

  // A DOCX is a ZIP. Unchanged compressed entries are copied byte-for-byte; only selected media is rebuilt.
  function readZip(buffer) {
    const bytes = new Uint8Array(buffer); let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('未找到 DOCX 的 ZIP 目录。文件可能不是有效 DOCX。');
    const count = u16(bytes, eocd + 10); let pos = u32(bytes, eocd + 16); const entries = [];
    for (let i = 0; i < count; i++) {
      if (u32(bytes, pos) !== 0x02014b50) throw new Error('DOCX 的 ZIP 目录损坏。');
      const nameLen = u16(bytes, pos + 28), extraLen = u16(bytes, pos + 30), commentLen = u16(bytes, pos + 32);
      const name = dec.decode(bytes.slice(pos + 46, pos + 46 + nameLen)); const localOffset = u32(bytes, pos + 42);
      const localNameLen = u16(bytes, localOffset + 26), localExtraLen = u16(bytes, localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
      entries.push({ name, flags: u16(bytes, pos + 8), method: u16(bytes, pos + 10), time: u16(bytes, pos + 12), date: u16(bytes, pos + 14), crc: u32(bytes, pos + 16), compressedSize: u32(bytes, pos + 20), uncompressedSize: u32(bytes, pos + 24), external: u32(bytes, pos + 38), compressed: bytes.slice(dataOffset, dataOffset + u32(bytes, pos + 20)) });
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return { entries };
  }
  async function unpack(entry) { if (entry.method === 0) return entry.compressed; if (entry.method === 8) return inflate(entry.compressed); throw new Error(`不支持 ZIP 压缩方式 ${entry.method}: ${entry.name}`); }
  async function readMediaMetadata(zip) {
    const documentEntry = zip.entries.find((entry) => entry.name === 'word/document.xml');
    const relsEntry = zip.entries.find((entry) => entry.name === 'word/_rels/document.xml.rels');
    if (!documentEntry || !relsEntry) return new Map();
    const documentXml = dec.decode(await unpack(documentEntry));
    const relsXml = dec.decode(await unpack(relsEntry));
    const relationships = new Map();
    for (const match of relsXml.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)) relationships.set(match[1], `word/${match[2].replace(/^\//, '')}`);
    const metadata = new Map();
    const drawingRe = /<wp:(?:inline|anchor)\b[\s\S]*?<wp:docPr\b([^>]*)>[\s\S]*?<a:blip\b[^>]*\br:embed="([^"]+)"[\s\S]*?<\/wp:(?:inline|anchor)>/g;
    for (const match of documentXml.matchAll(drawingRe)) {
      const id = /\bdescr="sr-component:([^"]+)"/.exec(match[1])?.[1];
      const target = relationships.get(match[2]);
      if (id && target) metadata.set(target, id);
    }
    return metadata;
  }
  function crc32(bytes) { let crc = 0xffffffff; for (let i = 0; i < bytes.length; i++) { crc ^= bytes[i]; for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
  async function buildZip(zip, replacements) {
    const locals = [], central = []; let offset = 0;
    for (const source of zip.entries) {
      const replacement = replacements.get(source.name); let data = source.compressed, method = source.method, crc = source.crc, uncompressedSize = source.uncompressedSize;
      if (replacement) { const raw = new Uint8Array(await replacement.arrayBuffer()); data = await deflate(raw); method = 8; crc = crc32(raw); uncompressedSize = raw.length; }
      const name = enc.encode(source.name); const local = new Uint8Array(30 + name.length + data.length); const lv = new DataView(local.buffer);
      put32(lv, 0, 0x04034b50); put16(lv, 4, 20); put16(lv, 6, 0); put16(lv, 8, method); put16(lv, 10, source.time); put16(lv, 12, source.date); put32(lv, 14, crc); put32(lv, 18, data.length); put32(lv, 22, uncompressedSize); put16(lv, 26, name.length); put16(lv, 28, 0); local.set(name, 30); local.set(data, 30 + name.length); locals.push(local);
      const cd = new Uint8Array(46 + name.length); const cv = new DataView(cd.buffer); put32(cv, 0, 0x02014b50); put16(cv, 4, 20); put16(cv, 6, 20); put16(cv, 8, 0); put16(cv, 10, method); put16(cv, 12, source.time); put16(cv, 14, source.date); put32(cv, 16, crc); put32(cv, 20, data.length); put32(cv, 24, uncompressedSize); put16(cv, 28, name.length); put16(cv, 30, 0); put16(cv, 32, 0); put16(cv, 34, 0); put16(cv, 36, 0); put32(cv, 38, source.external); put32(cv, 42, offset); cd.set(name, 46); central.push(cd); offset += local.length;
    }
    const centralBytes = concat(central), end = new Uint8Array(22), ev = new DataView(end.buffer); put32(ev, 0, 0x06054b50); put16(ev, 8, zip.entries.length); put16(ev, 10, zip.entries.length); put32(ev, 12, centralBytes.length); put32(ev, 16, offset); return new Blob([concat([...locals, centralBytes, end])], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }
  function escapeXml(value) { return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }
  function pathValue(obj, path) { return path.split('.').reduce((v, key) => v && v[key], obj); }
  // 每张 Word 截图对应正文里的哪一块组件。识别完全靠 drawing 元数据
  // （docPr 上的 descr="sr-component:XXX"）反查这里的 charts 列表，不再按文件名匹配：
  // 截图是"正文里有这个章节才截"，可选的典型案例会把之后每张 imageN.png 都往后推一位，
  // 按文件名找必然错位。元数据缺失的旧 Word 文件已不再支持编辑。
  const MEDIA_COMPONENTS = [
    // 总体评级（优/良/中/差）是看板左上角的一张固定档位 PNG，和那 25 个数字同属这一张截图，
    // 所以挂在同一个组件下。放在最前面是因为它是整份报告的结论，不该埋在一堆数字框下面。
    { root: '#slot-risk-overview', charts: ['riskOverviewGrade', 'riskOverviewFrame'], iframe: 'ov4-iframe' },
    { root: '#slot-top5-risk', charts: ['top5Risk'] },
    { root: '#slot-asset-stats', charts: ['assetSummaryCards', 'assetType', 'assetProtection', 'assetComponent'] },
    { root: '#slot-attack-trend', charts: ['attackTrend'] },
    { root: '#slot-threat-ops', charts: ['operationsFrame'], iframe: 'mdr-ops-v2-iframe' },
    { root: '#slot-event-charts', charts: ['eventTypeDistribution', 'businessSystemEventDistribution'] },
    { root: '#slot-attack-chain', charts: ['attackChain'] },
    { root: '#slot-internet-exposure > .sr-chart-card:first-child', charts: ['exposureOverview'] },
    { root: '#slot-internet-exposure .sr-chart-grid-2', charts: ['webTop5', 'nonwebTop5'] },
    { root: '#slot-internet-exposure > .sr-chart-card:has(#m3-bar)', charts: ['exposureAssets'] },
    { root: '#slot-internet-weak', charts: ['internetWeakCards', 'internetWeakAsset'] },
    { root: '#slot-intranet-weak', charts: ['intranetWeakCards', 'intranetWeakBusiness', 'intranetWeakAsset'] },
    { root: '#slot-component-check-rings', charts: ['policyCheckCards'] }
  ];
  // 报告 HTML 里的攻击链是服务端生成时烘焙好的静态标记（没有 data-field，也没有浏览器端渲染器），
  // 所以这里把 src/template_renderer.js 的 renderCaseStudySection 移植成浏览器版：
  // 编辑后的数据在 iframe 内重建 DOM，再整块截图盖到 Word 原图上。
  const STAGE_NUMERALS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  function formatChineseStageIndex(index) {
    if (index <= 10) return STAGE_NUMERALS[index] || String(index);
    if (index < 20) return `十${STAGE_NUMERALS[index - 10] || ''}`;
    if (index === 20) return '二十';
    return String(index);
  }
  function formatStageTimestamp(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
    const date = new Date(timestamp * 1000);
    if (Number.isNaN(date.getTime())) return '';
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${month}-${day} ${hours}:${minutes}`;
  }
  // 扁平行模型：一条 row 就是时间轴上的一行文字，避免嵌套结构在 persistChart 的浅拷贝里串改原始数据。
  // name 非空 = 开启一张新卡片（攻击侧按 stage 分组，防守侧按 label 分卡）；name 为空 = 续接上一张卡。
  function buildAttackChainRows(caseStudy) {
    const attackTimeline = Array.isArray(caseStudy.attackTimeline) ? caseStudy.attackTimeline : [];
    const defenseTimeline = Array.isArray(caseStudy.defenseTimeline) ? caseStudy.defenseTimeline : [];
    const rows = [];
    const groups = [];
    const groupIndex = new Map();
    attackTimeline.forEach((item) => {
      if (!item) return;
      const key = `${String(item.stageId || '').trim()}::${String(item.stageName || '').trim()}`;
      if (!groupIndex.has(key)) { groupIndex.set(key, groups.length); groups.push([]); }
      groups[groupIndex.get(key)].push(item);
    });
    groups.forEach((items) => {
      const first = items[0] || {};
      const stageName = String(first.stageName || first.stageId || '未知阶段').trim();
      items.forEach((item, itemIndex) => {
        rows.push({ rowType: 'attack', name: itemIndex === 0 ? stageName : '', time: formatStageTimestamp(item.timestamp), desc: String(item.narrative || '').trim() });
      });
    });
    defenseTimeline.forEach((item) => {
      if (!item) return;
      const label = String(item.label || '防守时间线').trim();
      const entries = Array.isArray(item.timeEntries) ? item.timeEntries : [];
      if (!entries.length) { rows.push({ rowType: 'defense', name: label, time: '', desc: '' }); return; }
      entries.forEach((entry, entryIndex) => {
        rows.push({ rowType: 'defense', name: entryIndex === 0 ? label : '', time: formatStageTimestamp(entry && entry.timestamp), desc: String((entry && entry.desc) || '').trim() });
      });
    });
    return rows;
  }
  function groupAttackChainRows(rows) {
    const groups = [];
    rows.forEach((row) => {
      const name = String(row.name || '').trim();
      if (!groups.length || name) groups.push({ name, entries: [] });
      groups[groups.length - 1].entries.push(row);
    });
    return groups;
  }
  function attackChainColumnHtml(group, index) {
    const entries = group.entries.map((row) => [
      row.time ? `<div class="tm-time">${escapeXml(row.time)}</div>` : '',
      row.desc ? `<div class="tm-desc">${escapeXml(row.desc)}</div>` : ''
    ].join('')).join('');
    return [
      '<div class="tm-left"><div class="tm-card atk">',
      `<div class="tm-tag">阶段${escapeXml(formatChineseStageIndex(index + 1))}：${escapeXml(group.name || '未知阶段')}</div>`,
      entries || '<div class="tm-desc">暂无攻击侧时间线</div>',
      '<span class="tm-arrow"></span>',
      '</div></div>'
    ].join('');
  }
  function defenseChainColumnHtml(card) {
    const entries = card.entries.map((row) => {
      if (!row.time || !row.desc) return '';
      return `<div class="tm-time">${escapeXml(row.time)} ${escapeXml(row.desc)}</div>`;
    }).join('');
    return [
      '<div class="tm-right"><div class="tm-card def">',
      `<div class="tm-tag">${escapeXml(card.name || '防守时间线')}</div>`,
      entries || '<div class="tm-time">暂无时间</div>',
      '<span class="tm-arrow"></span>',
      '</div></div>'
    ].join('');
  }
  function attackChainHtml(rows) {
    const attackGroups = groupAttackChainRows(rows.filter((row) => row.rowType === 'attack'));
    const defenseCards = groupAttackChainRows(rows.filter((row) => row.rowType !== 'attack'));
    const rowCount = Math.max(attackGroups.length, defenseCards.length);
    const parts = [];
    for (let index = 0; index < rowCount; index += 1) {
      const group = attackGroups[index];
      const card = defenseCards[index];
      parts.push([
        '<div class="tm-row">',
        group ? attackChainColumnHtml(group, index) : '<div class="tm-left"></div>',
        `<div class="tm-dot ${group ? 'rd' : (card ? 'bl' : 'gn')}"></div>`,
        card ? defenseChainColumnHtml(card) : '<div class="tm-right"></div>',
        '</div>'
      ].join(''));
    }
    return `<div class="sr-attack-chain"><div class="tm">${parts.join('')}</div></div>`;
  }
  // Top5 资产风险类型柱状图在报告 HTML 里是「按风险类型堆叠条形图」：
  // 每根柱子由下面 5 个风险类型分段堆叠而成，topRiskAssets[].riskCount 只是汇总值。
  // 因此编辑必须以分段为单位写回 riskDetails，再按五段之和重算 riskCount。
  // 顺序与颜色须与 security-report-preview.html 的 top5SeriesConfig 保持一致。
  // otherEvents（既非木马/C2 也非漏洞利用的其他事件）在这张图里不显示，
  // 所以重算 riskCount 时会把它丢掉——这是有意为之。
  const TOP5_RISK_SEGMENTS = [
    { key: 'malwareC2', detailKey: 'malwareAndC2Events', label: '病毒木马/C2', full: '病毒木马/C2外联事件' },
    { key: 'exploit', detailKey: 'vulnExploitEvents', label: '漏洞利用', full: '漏洞利用' },
    { key: 'exposure', detailKey: 'totalExposures', label: '暴露面', full: '暴露面' },
    { key: 'vuln', detailKey: 'totalVulnerabilities', label: '漏洞', full: '漏洞' },
    { key: 'weakPwd', detailKey: 'weakPasswords', label: '弱口令', full: '弱口令' }
  ];
  function top5RiskRowTotal(row) {
    return TOP5_RISK_SEGMENTS.reduce((sum, segment) => sum + Math.max(0, Math.round(Number(row[segment.key]) || 0)), 0);
  }
  function blankTop5RiskRow(name) {
    const row = { name: name || '新资产' };
    TOP5_RISK_SEGMENTS.forEach((segment) => { row[segment.key] = 0; });
    row.value = 0;
    return row;
  }
  // 这三张环形图的类目颜色在报告 HTML 里是按名字查表的（assetTypeColorMap / statusColorMap），
  // 表里没有的名字会回退到 colors.asset.other，和「其它」完全同色。
  // 所以它们的类目集合是固定的：新增只能补回名单里缺的那个，不允许自由填名字。
  // 名单来自各自的数据源：
  //   assetType        asset_excel_stats.js 的 toNameValueList（固定 3 项，且总是全量输出）
  //   assetProtection  同上的 protectionDistribution（固定 2 项）
  //   assetComponent   device_component_stats.py 的 DISTRIBUTION_ORDER（固定 6 项，只输出 value > 0）
  const FIXED_CATEGORY_NAMES = {
    assetType: ['服务器', '终端', '其它'],
    assetProtection: ['防护', '未防护'],
    assetComponent: ['AF', 'EDR', 'SIP', 'STA', '深信服其他组件', '第三方组件']
  };
  function missingFixedCategories(chart) {
    const names = FIXED_CATEGORY_NAMES[chart.id];
    if (!names) return null;
    return names.filter((name) => !chart.rows.some((row) => row.name === name));
  }
  // 这几个 kind 都不需要 ECharts 实例，预览的就绪判定要把它们算作已就绪。
  function hasNoEchartsInstance(chart) { return chart?.kind === 'domText' || chart?.kind === 'attackChain' || chart?.kind === 'grade'; }
  function chartDefinitions(data) {
    const defs = [
      ['eventTypeDistribution', '安全事件类型分布', 'riskDetails.eventTypeDistribution', 'm2-ring2'],
      ['businessSystemEventDistribution', '业务系统安全事件分布', 'riskDetails.businessSystemEventDistribution', 'm2-bar-sys'],
      ['assetType', '资产类型分布', 'assetLedger.typeDistribution', 'asset-type-donut'],
      ['assetProtection', '资产防护统计', 'assetLedger.protectionDistribution', 'asset-protection-donut'],
      ['assetComponent', '安全组件分布', 'assetLedger.componentDistribution', 'asset-component-donut'],
      ['exposureOverview', '总体暴露面分布', 'internet.exposure.dist', 'm3-exposure-overview-bar'],
      ['webTop5', 'Web服务风险分布 top5', 'internet.exposure.web_top5', 'm3-web-top5-bar'],
      ['nonwebTop5', '非Web服务风险分布 top5', 'internet.exposure.nonweb_top5', 'm3-nonweb-top5-bar'],
      ['exposureAssets', '风险暴露 Top5 资产', 'internet.exposure.stack_rows', 'm3-bar'],
      ['top5Risk', 'Top5资产的风险类型', 'riskOverview.topRiskAssets', 'top5-risk-bar'],
      ['internetWeakAsset', '弱口令风险 - 资产分布', 'internet.weak_pwd.asset_rows', 'm5-bar-internet-asset'],
      ['intranetWeakBusiness', '弱口令风险 - 业务系统分布', 'intranet.weak_pwd.biz_rows', 'm5-bar-intra'],
      ['intranetWeakAsset', '弱口令风险 - 资产分布（内网）', 'intranet.weak_pwd.asset_rows', 'm5-bar-intra-asset']
    ];
    const charts = defs.map(([id, title, path, elementId]) => {
      const values = pathValue(data, path);
      if (!Array.isArray(values)) return null;
      const rows = id === 'exposureAssets'
        ? values.map((x) => {
          const web = Math.max(0, Number(x.web) || 0);
          const nonWeb = Math.max(0, Number(x.nonWeb) || 0);
          return { name: x.host || '', web, nonWeb, value: web + nonWeb };
        })
        : id === 'top5Risk'
          ? values.map((x) => {
            // 柱子高度是五段之和，不是 riskCount：两者数据源不同（riskCount 来自风险清单计数，
            // 分段来自事件/漏洞/弱口令/暴露面四张表），显示分段之和才能和预览里的柱子对上。
            const detail = (x && x.riskDetails) || {};
            const row = { name: x.name || x.asset || x.host || x.ip || '未命名' };
            TOP5_RISK_SEGMENTS.forEach((segment) => {
              row[segment.key] = Math.max(0, Math.round(Number(detail[segment.detailKey]) || 0));
            });
            row.value = top5RiskRowTotal(row);
            return row;
          })
          : values.map((x) => ({ name: x.name || x.asset || x.host || x.ip || '未命名', value: Number(x.value ?? x.count ?? x.riskTotal ?? x.riskCount ?? 0) || 0 }));
      return { id, title, path, elementId, rows };
    }).filter(Boolean);
    const attackOverview = pathValue(data, 'attackOverview') || {};
    const trendDates = Array.isArray(attackOverview.trend_dates) ? attackOverview.trend_dates : [];
    const trendValues = Array.isArray(attackOverview.trend_values) ? attackOverview.trend_values : [];
    if (trendDates.length || trendValues.length) {
      const rowCount = Math.max(trendDates.length, trendValues.length);
      charts.push({
        id: 'attackTrend',
        title: '外部攻击趋势',
        path: 'attackOverview',
        elementId: 'm-attack-trend',
        kind: 'trend',
        rows: Array.from({ length: rowCount }, (_, index) => ({
          name: String(trendDates[index] ?? `第 ${index + 1} 天`),
          value: Math.max(0, Number(trendValues[index]) || 0)
        }))
      });
    }
    charts.push({
      id: 'policyCheckCards',
      title: '安全组件策略检查',
      kind: 'domText',
      rows: [
        { name: '风险项', value: Number(pathValue(data, 'protection_effectiveness.policy_stats.abnormal_count')) || 0, selector: '[data-field="protection_effectiveness.policy_stats.abnormal_count"]' },
        { name: '全部检查项', value: Number(pathValue(data, 'protection_effectiveness.policy_stats.total')) || 0, selector: '[data-field="protection_effectiveness.policy_stats.total"]' },
        { name: '风险组件', value: Number(pathValue(data, 'protection_effectiveness.policy_stats.abnormal_component_count')) || 0, selector: '[data-field="protection_effectiveness.policy_stats.abnormal_component_count"]' },
        { name: '全部组件', value: Number(pathValue(data, 'protection_effectiveness.policy_stats.total_component_count')) || 0, selector: '[data-field="protection_effectiveness.policy_stats.total_component_count"]' }
      ]
    });
    const caseStudyRows = buildAttackChainRows(pathValue(data, 'riskDetails.caseStudy') || {});
    if (caseStudyRows.length) {
      charts.push({ id: 'attackChain', title: '典型案例 · 攻击链时间轴', kind: 'attackChain', rows: caseStudyRows });
    }
    charts.push(
      { id: 'assetSummaryCards', title: '资产概览卡片', kind: 'domText', rows: [
        { name: '台账资产', value: Number(pathValue(data, 'assetLedger.currentAssetCount')) || 0, selector: '[data-field="assets.total"]' },
        { name: '核心资产', value: Number(pathValue(data, 'assetLedger.core_asset')) || 0, selector: '[data-field="assets.core"]' },
        { name: '待审核资产', value: Number(pathValue(data, 'assetLedger.waitApproveAssetCount')) || 0, selector: '[data-field="assets.waitApprove"]' },
        { name: '安全组件接入', value: Number(pathValue(data, 'assetLedger.totalComponentCount')) || 0, selector: '[data-field="assets.component"]' }
      ] },
      { id: 'internetWeakCards', title: '弱口令发现与业务影响', kind: 'domText', rows: [
        { name: '弱口令数', value: Number(pathValue(data, 'internet.weak_pwd.total_count')) || 0, selector: '.sr-kpi-card:nth-child(1) .sr-kpi-val' },
        { name: '风险资产', value: Number(pathValue(data, 'internet.weak_pwd.affected_assets')) || 0, selector: '.sr-kpi-card:nth-child(2) .sr-kpi-item:last-child .sr-kpi-val' }
      ] },
      { id: 'intranetWeakCards', title: '内网弱口令发现与业务影响', kind: 'domText', rows: [
        { name: '弱口令数', value: Number(pathValue(data, 'intranet.weak_pwd.total_count')) || 0, selector: '.sr-kpi-card:nth-child(1) .sr-kpi-val' },
        { name: '风险业务', value: Number(pathValue(data, 'intranet.weak_pwd.risk_count')) || 0, selector: '.sr-kpi-card:nth-child(2) .sr-kpi-item:first-child .sr-kpi-val' },
        { name: '风险资产', value: Number(pathValue(data, 'intranet.weak_pwd.affected_assets')) || 0, selector: '.sr-kpi-card:nth-child(2) .sr-kpi-item:last-child .sr-kpi-val' }
      ] },
      { id: 'riskOverviewFrame', title: '风险总览（嵌入式看板）', kind: 'iframe', rows: [
        ['总体风险数', 'riskOverview.totalRiskCount', '.ro5-kpi .val--risk'],
        ['风险业务数', 'riskOverview.riskBusinessCount', '.ro5-top .ro5-kpi:nth-child(2) .val'],
        ['风险资产数', 'riskOverview.riskAssetCount', '.ro5-top .ro5-kpi:nth-child(3) .val'],
        ['互联网风险端口', 'summary.internet.exposure.risk_ports', '.ro5-biz:first-child .ro5-metric:nth-of-type(2) .num'],
        ['互联网风险资产', 'summary.internet.exposure.risk_assets', '.ro5-biz:first-child .ro5-metric:nth-of-type(2) .num--risk'],
        ['互联网漏洞总数', 'summary.internet.vuln.total', '.ro5-biz:first-child .ro5-metric:nth-of-type(3) .num'],
        ['互联网漏洞风险资产', 'summary.internet.vuln.risk_assets', '.ro5-biz:first-child .ro5-metric:nth-of-type(3) .num--risk'],
        ['互联网弱口令数', 'summary.internet.weak_pwd.total', '.ro5-biz:first-child .ro5-metric:nth-of-type(4) .num'],
        ['互联网弱口令风险资产', 'summary.internet.weak_pwd.risk_assets', '.ro5-biz:first-child .ro5-metric:nth-of-type(4) .num--risk'],
        ['内网漏洞总数', 'summary.intranet.vuln.total', '.ro5-biz:nth-child(2) .ro5-metric:nth-of-type(2) .num'],
        ['内网漏洞风险资产', 'summary.intranet.vuln.risk_assets', '.ro5-biz:nth-child(2) .ro5-metric:nth-of-type(2) .num--risk'],
        ['内网弱口令数', 'summary.intranet.weak_pwd.total', '.ro5-biz:nth-child(2) .ro5-metric:nth-of-type(3) .num'],
        ['内网弱口令风险资产', 'summary.intranet.weak_pwd.risk_assets', '.ro5-biz:nth-child(2) .ro5-metric:nth-of-type(3) .num--risk'],
        ['组件策略风险项', 'protection_effectiveness.policy_stats.risk_cnt', '.ro5-policy .num'],
        ['组件策略风险组件', 'protection_effectiveness.policy_stats.abnormal_component_count', '.ro5-policy .num--risk'],
        ['遭受攻击次数', 'attackOverview.total_attack_count', '.ro5-attack-desc .val:nth-of-type(1)'],
        ['工作时间攻击次数', 'attackOverview.workday_attack_count', '.ro5-attack-desc .val:nth-of-type(2)'],
        ['非工作时间攻击次数', 'attackOverview.night_attack_count', '.ro5-attack-desc .val:nth-of-type(3)'],
        ['有效告警数', 'riskOverview.alertTotal', '.ro5-stat-row .val--sm'],
        ['安全事件数', 'riskOverview.totalEvents', '.ro5-stat-row--gpt .val'],
        ['影响资产数', 'riskOverview.affectedAssetCount', '.ro5-badge .val'],
        ['已遏制告警', 'riskOverview.containedAlerts', '.ro5-expert-stats .row:first-child .val'],
        ['处置闭环数', 'riskOverview.closedEvents', '.ro5-expert-stats .row:nth-child(2) .val'],
        ['告警消减率', 'riskOverview.alertReductionRate', '.ro5-expert-grid > .ro5-closure:nth-of-type(2) .val'],
        ['事件闭环率', 'riskOverview.closeRate', '.ro5-expert-grid > .ro5-closure:nth-of-type(3) .val']
      ].map(([name, path, selector]) => ({ name, value: Number(pathValue(data, path)) || 0, path, selector })) },
      { id: 'operationsFrame', title: '运营总览（嵌入式看板）', kind: 'iframe', rows: [
        ['AF 设备数', 'riskDetails.af', '.ops3-device-cell:nth-child(1) .nv'],
        ['EDR 设备数', 'riskDetails.aes', '.ops3-device-cell:nth-child(2) .nv'],
        ['SIP 设备数', 'riskDetails.sip', '.ops3-device-cell:nth-child(3) .nv'],
        ['STA 设备数', 'riskDetails.sta', '.ops3-device-cell:nth-child(4) .nv'],
        ['其他设备数', 'riskDetails.other_sf', '.ops3-device-cell:nth-child(5) .nv'],
        ['第三方设备数', 'riskDetails.third', '.ops3-device-third .nv'],
        ['安全日志数', 'riskDetails.securityLogTotal', '[data-log-count]'],
        ['有效告警数', 'riskDetails.alertTotal', '.ops3-ai .ops3-stat-row .val'],
        ['安全事件数', 'riskDetails.totalEvents', '.ops3-gpt .ops3-stat-row .val'],
        ['告警消减率', 'riskDetails.alertReductionRate', '.ops3-badge-text .val'],
        ['已遏制告警', 'riskDetails.containedAlerts', '.ops3-outcome-title--left + .ops3-outcome-body b'],
        ['处置闭环数', 'riskDetails.closedEvents', '.ops3-outcome-title--right + .ops3-outcome-body b'],
        ['事件闭环率', 'riskDetails.closeRate', '.ops3-outcome-desc .hi']
      ].map(([name, path, selector]) => ({ name, value: Number(pathValue(data, path)) || 0, path, selector })) }
    );
    // 总体评级：四档各一张固定 PNG，没有数值、也不能新增/删除，所以单列一个 kind，
    // 由 renderChartGroup 渲染成下拉框、由 applyGradeEdit 把图换掉。
    // 报告里没有 GRADE_ASSETS（旧模板）时干脆不出现，别让用户看到一个改不动的空控件。
    const gradeNames = Object.keys(state.gradeAssets);
    const usable = (value) => (state.gradeAssets[value] ? value : '');
    // 档位解析不出来就不出控件：applyGradeEdit 会无条件按下拉框的值设 src，
    // 拿 gradeNames[0] 顶替等于用户没动手就把看板那张图换成了别的档位。
    const current = usable(bakedGradeFromHtml(state.sourceHtml))
      || usable(String(pathValue(data, 'scoring.grade') || '').trim());
    if (gradeNames.length > 1 && current) {
      charts.push({ id: 'riskOverviewGrade', title: '总体评级', kind: 'grade', rows: [{ name: '总体评级', value: current }] });
    }
    return charts;
  }
  function applyTop5RiskRows(target, rows) {
    const originalRows = target.slice();
    target.splice(0, target.length, ...rows.map((row, index) => {
      // 逐段写回 riskDetails，不再按比例缩放：这张图每根柱子是 5 个风险类型的堆叠，
      // 用户改的是某一段而不是总数，等比缩放会把该段吃掉或凭空造出别的段。
      const original = structuredClone(originalRows[index] || {});
      const detail = original.riskDetails || {};
      TOP5_RISK_SEGMENTS.forEach((segment) => {
        detail[segment.detailKey] = Math.max(0, Math.round(Number(row[segment.key]) || 0));
      });
      const total = top5RiskRowTotal(row);
      original.ip = row.name;
      // riskCount 是汇总值，报告 HTML 在五段全为 0 时才会回退到它，
      // 这里按五段之和覆写，保证编辑框显示的数和柱子高度一致。
      original.riskCount = total;
      original.riskDetails = detail;
      return original;
    }));
  }
  function applyExposureAssetRows(target, rows) {
    const originalRows = target.slice();
    target.splice(0, target.length, ...rows.map((row, index) => {
      const original = structuredClone(originalRows[index] || {});
      const web = Math.max(0, Math.round(Number(row.web) || 0));
      const nonWeb = Math.max(0, Math.round(Number(row.nonWeb) || 0));
      original.host = row.name;
      original.web = web;
      original.nonWeb = nonWeb;
      original.riskTotal = web + nonWeb;
      return original;
    }));
  }
  function applyRows(data, chart, rows) {
    if (chart.id === 'attackTrend') {
      const target = pathValue(data, chart.path);
      if (!target || typeof target !== 'object') return;
      target.trend_dates = rows.map((row, index) => String(row.name || `第 ${index + 1} 天`).slice(0, 40));
      target.trend_values = rows.map((row) => Math.max(0, Number(row.value) || 0));
      return;
    }
    // 评级不参与渲染（看板走的是整份模板 srcdoc，不读 previewData），这里只是让内存里那份
    // 数据副本跟编辑结果保持一致。
    if (chart.kind === 'grade') {
      const scoring = data.scoring;
      if (scoring && typeof scoring === 'object' && rows[0]) scoring.grade = rows[0].value;
      return;
    }
    if (!chart.path) return;
    const target = pathValue(data, chart.path);
    if (!Array.isArray(target)) return;
    if (chart.id === 'top5Risk') {
      applyTop5RiskRows(target, rows);
      return;
    }
    if (chart.id === 'exposureAssets') {
      applyExposureAssetRows(target, rows);
      return;
    }
    target.splice(0, target.length, ...rows.map((row) => ({ name: row.name, value: Number(row.value) || 0, count: Number(row.value) || 0, asset: row.name, host: row.name, ip: row.name, riskCount: Number(row.value) || 0 })));
  }
  function reportDataForPreview() { const data = structuredClone(state.reportData); state.charts.forEach((chart) => { const rows = state.edits.get(chart.id); if (rows) applyRows(data, chart, rows); }); if (state.activeChart) applyRows(data, state.activeChart, state.activeChart.rows); return data; }
  function replaceExposureAssetRowsInHtml(html, data) {
    const rows = pathValue(data, 'internet.exposure.stack_rows');
    if (!Array.isArray(rows)) return html;
    const replacement = JSON.stringify(rows).replace(/</g, '\\u003c');
    return html.replace(
      /(\(function initM3ExposureTop5Stack\(\) \{\s*var rows = )\[[\s\S]*?\](;)/,
      `$1${replacement}$2`
    );
  }
  function replaceInlineChartRowsInHtml(html, data) {
    const replace = (source, pattern, path) => {
      const rows = pathValue(data, path);
      if (!Array.isArray(rows)) return source;
      return source.replace(pattern, `$1${JSON.stringify(rows).replace(/</g, '\\u003c')}$2`);
    };
    let result = html;
    result = replace(result, /(var exposureDist = )\[[\s\S]*?\](;)/, 'internet.exposure.dist');
    result = replace(result, /(buildServiceTop5Bar\('m3-web-top5-bar', )\[[\s\S]*?\](\);)/, 'internet.exposure.web_top5');
    result = replace(result, /(buildServiceTop5Bar\('m3-nonweb-top5-bar', )\[[\s\S]*?\](\);)/, 'internet.exposure.nonweb_top5');
    result = replace(result, /(var WP_INTERNET = )\[[\s\S]*?\](;)/, 'internet.weak_pwd.asset_rows');
    result = replace(result, /(var WP_INTRA = )\[[\s\S]*?\](;)/, 'intranet.weak_pwd.asset_rows');
    result = replace(result, /(var WEAK_PWD_INTRA = )\[[\s\S]*?\](;)/, 'intranet.weak_pwd.biz_rows');
    return result;
  }
  // 兼容本次修复之前生成的报告：那三张环形图的中心总数直接读 assetLedger.assetTotal /
  // totalComponentCount 两个标量，编辑切片不会改变标量，中心数字就停在原值。
  // 模板里紧随其后的 if (!Number.isFinite(...)) 分支本来就会按切片求和，
  // 所以这里只把标量读法改成 NaN，让它走求和分支（安全事件类型分布 m2-ring2 一直是这么算的）。
  // 新模板已改为直接求和，此处在旧报告上生效、新报告上不再命中。
  function replaceDonutCenterTotalsInHtml(html) {
    return html
      .replace(/(var assetTypeTotal = )Number\(assetLedger\.assetTotal\)/, '$1NaN')
      .replace(/(var assetProtectionTotal = )Number\(assetLedger\.assetTotal\)/, '$1NaN')
      .replace(/(var assetComponentTotal = )Number\(assetLedger\.totalComponentCount\)/, '$1NaN');
  }
  // 总体评级在报告里不是文字而是一张 PNG：优/良/中/差各一张，四张全部内嵌在
  // tpl-ov4-iframe 的 GRADE_ASSETS 里。这里用与生成器相同的正则把它们抠出来
  // （src/template_renderer.js 的 extractGradeAssets）。注意 img 自己的写法是
  // src="data:... 而不是 'X': 'data:...，不会被这个正则命中。
  function extractGradeAssets(html) {
    const assets = {};
    for (const match of String(html).matchAll(/'([优良中差])':\s*'(data:image\/png;base64,[^']+)'/g)) assets[match[1]] = match[2];
    return assets;
  }
  // 当前显示的是哪一档。优先级与模板里的 resolveGrade() 一致：
  // iframe 自己的 <html data-report-grade> → 仪表盘卡片的 data-grade → 兜底「良」。
  // 不能靠 ?grade=：编辑器是用 srcdoc 装载模板的，about:srcdoc 文档没有可用的 location.search。
  function bakedGradeFromHtml(html) {
    const template = iframeTemplateFromHtml(html, 'ov4-iframe');
    if (!template) return '';
    const doc = new DOMParser().parseFromString(template, 'text/html');
    const card = doc.getElementById('ro5-gauge-card');
    return String(doc.documentElement.getAttribute('data-report-grade') || (card && card.getAttribute('data-grade')) || '').trim();
  }
  function mediaFilename(path) { return String(path).split(/[\\/]/).pop().toLowerCase(); }
  function componentForPath(selectedPath) {
    const metadataId = state.mediaMetadata.get(String(selectedPath).replace(/\\/g, '/'));
    // 没有元数据就没有识别依据。旧 Word 文件（2026-07-20 之前生成、没有 descr 的）
    // 曾经按文件名兜底匹配，但那是位置相关的，截图增删一次就会静默错位到别的组件上，
    // 所以整条文件名映射已移除，这里直接返回"无映射"。
    if (!metadataId) return null;
    const mapped = MEDIA_COMPONENTS.find((component) => component.charts.includes(metadataId));
    if (mapped) return mapped;
    const aliases = { 'm2-ring2': 'eventTypeDistribution', 'm2-bar-sys': 'businessSystemEventDistribution', 'asset-type-donut': 'assetType', 'asset-protection-donut': 'assetProtection', 'asset-component-donut': 'assetComponent', 'm3-exposure-overview-bar': 'exposureOverview', 'm3-web-top5-bar': 'webTop5', 'm3-nonweb-top5-bar': 'nonwebTop5', 'm3-bar': 'exposureAssets', 'top5-risk-bar': 'top5Risk', 'm5-bar-internet-asset': 'internetWeakAsset', 'm5-bar-intra': 'intranetWeakBusiness', 'm5-bar-intra-asset': 'intranetWeakAsset', 'm-attack-trend': 'attackTrend' };
    // 生成器对槽位截图写的是组件名，对卡片截图写的是 HTML 元素 id（m3-bar、top5-risk-bar 等），
    // 这里把元素 id 换算成 charts 里用的图表 id。
    const chartId = aliases[metadataId];
    if (chartId) return MEDIA_COMPONENTS.find((component) => component.charts.includes(chartId)) || null;
    // 元数据里的 id 认不出来，说明这张图没有可编辑图表（例如附录的优先矩阵）。
    return null;
  }
  function componentForSelection() { return componentForPath(state.selectedPath); }
  async function imageFromUrl(url) { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url; }); }
  function componentRoot(doc, component) {
    // 有些 root 用 :has() 定位"包含某个图表的卡片"。旧浏览器不认这个选择器会直接抛异常，
    // 这时退回下面的 closest()，它同样会取到最近的 .sr-chart-card。
    let direct = null;
    try { direct = doc.querySelector(component.root); } catch { direct = null; }
    if (direct) return direct;
    const chart = component.charts.map((id) => state.charts.find((item) => item.id === id)).find(Boolean);
    const chartDom = chart && doc.getElementById(chart.elementId);
    return chartDom?.closest('.sr-chart-slot, .sr-chart-card, .chart-box, section, div') || chartDom || doc.body;
  }
  function selectedMedia() {
    if (state.selectedMediaItem) return state.selectedMediaItem;
    const direct = state.media.find((item) => item.path === state.selectedPath);
    if (direct) return direct;
    const filename = mediaFilename(state.selectedPath);
    const byFilename = state.media.find((item) => mediaFilename(item.path) === filename);
    if (byFilename) return byFilename;
    // 兜底：没点过图片时，用元数据把当前图表反查回它的 Word 截图。
    if (!state.activeChart) return null;
    return state.media.find((item) => componentForPath(item.path)?.charts.includes(state.activeChart.id)) || null;
  }
  function drawDomTextEdits(ctx, frame, root, rootRect, chart, canvas) {
    const backgroundFor = (node) => {
      for (let current = node; current; current = current.parentElement) {
        const color = frame.contentWindow.getComputedStyle(current).backgroundColor;
        if (color && color !== 'transparent' && !/^rgba\([^)]*,\s*0\)$/.test(color)) return color;
      }
      return '#ffffff';
    };
    const rows = state.edits.get(chart.id) || chart.rows;
    rows.forEach((row) => {
      const node = root.querySelector(row.selector);
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const x = (rect.left - rootRect.left) / rootRect.width * canvas.width;
      const y = (rect.top - rootRect.top) / rootRect.height * canvas.height;
      const width = rect.width / rootRect.width * canvas.width;
      const height = rect.height / rootRect.height * canvas.height;
      const css = frame.contentWindow.getComputedStyle(node);
      const scale = canvas.width / rootRect.width;
      ctx.fillStyle = backgroundFor(node);
      ctx.fillRect(x, y, width, height);
      ctx.fillStyle = css.color || '#1e293b';
      ctx.font = `${css.fontStyle || 'normal'} ${css.fontWeight || '400'} ${Math.max(9, parseFloat(css.fontSize) * scale)}px ${css.fontFamily || 'Arial'}`;
      ctx.textAlign = css.textAlign === 'right' ? 'right' : (css.textAlign === 'center' ? 'center' : 'left');
      ctx.textBaseline = 'middle';
      const textX = ctx.textAlign === 'right' ? x + width : (ctx.textAlign === 'center' ? x + width / 2 : x);
      ctx.fillText(String(row.value), textX, y + height / 2, width);
    });
  }
  async function drawAttackChainEdits(ctx, frame, rootRect, chart, canvas) {
    const slot = frame.contentDocument.getElementById('slot-attack-chain');
    if (!slot || !rootRect.width || !rootRect.height) return;
    if (typeof window.html2canvas !== 'function') throw new Error('HTML 截图组件未加载。');
    // 报告 HTML 里没有客户端渲染器，所以先用编辑后的数据在 iframe 内重建整块时间轴，再整块盖回去。
    // Word 原图就是这个 slot 的截图，两边的 rect 一一对应，不需要逐行定位。
    slot.innerHTML = attackChainHtml(state.edits.get(chart.id) || chart.rows);
    const rect = slot.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    let background = frame.contentWindow.getComputedStyle(slot).backgroundColor;
    if (!background || background === 'transparent' || /^rgba\([^)]*,\s*0\)$/.test(background)) background = '#ffffff';
    const width = Math.ceil(Math.max(rect.width, slot.scrollWidth));
    const height = Math.ceil(Math.max(rect.height, slot.scrollHeight));
    // windowWidth/windowHeight 必须是 iframe 的真实视口，不能传元素自身尺寸：
    // 报告里有 @media (max-width: 1100px/900px) 的响应式规则，传窄了会在克隆文档里触发，
    // 时间轴会按小屏版式重排，贴回原图时被横向压扁。
    const win = frame.contentWindow;
    const source = await window.html2canvas(slot, {
      backgroundColor: background, useCORS: false, allowTaint: false, logging: false, scale: 2,
      width, height, windowWidth: win.innerWidth, windowHeight: win.innerHeight
    });
    const x = (rect.left - rootRect.left) / rootRect.width * canvas.width;
    const y = (rect.top - rootRect.top) / rootRect.height * canvas.height;
    const targetWidth = rect.width / rootRect.width * canvas.width;
    const targetHeight = rect.height / rootRect.height * canvas.height;
    // 画布尺寸是固定的（就是 Word 里那张原图，等于编辑前这个 slot 的截图），但 slot 的高度会
    // 随编辑增长——新增一张防守卡片就多一个 .tm-row。rootRect 是改 innerHTML 之前取的，
    // 所以 targetHeight 会大于 canvas.height；再按原比例贴回去，多出来的部分落到画布外面被裁掉，
    // 表现就是"新增的卡片在预览里看不到"。这里等比缩小到整条时间轴放得下。
    const scale = Math.min(1, (canvas.height - y) / targetHeight, (canvas.width - x) / targetWidth);
    if (scale < 1) {
      // 缩小后右边会空出来，先用底色盖住，否则 Word 原图的残留会从右侧透出来形成重影。
      ctx.fillStyle = background;
      ctx.fillRect(x, y, canvas.width - x, canvas.height - y);
    }
    const drawWidth = targetWidth * scale;
    const drawHeight = targetHeight * scale;
    ctx.drawImage(source, x + (canvas.width - x - drawWidth) / 2, y, drawWidth, drawHeight);
  }
  async function composeComponent(frame, component, baseItem) { const base = baseItem || selectedMedia(); const root = componentRoot(frame.contentDocument, component); if (!base || !root) throw new Error('未找到该图片的 Word 原始截图。'); const canvas = document.createElement('canvas'); canvas.width = base.width; canvas.height = base.height; const ctx = canvas.getContext('2d'); const original = await imageFromUrl(base.url); ctx.drawImage(original, 0, 0, canvas.width, canvas.height); const rootRect = root.getBoundingClientRect(); for (const id of component.charts) { const chart = state.charts.find((item) => item.id === id); if (chart?.kind === 'domText') { drawDomTextEdits(ctx, frame, root, rootRect, chart, canvas); continue; } if (chart?.kind === 'attackChain') { await drawAttackChainEdits(ctx, frame, rootRect, chart, canvas); continue; } const dom = chart && frame.contentDocument.getElementById(chart.elementId); const instance = dom && frame.contentWindow.echarts && frame.contentWindow.echarts.getInstanceByDom(dom); if (!instance || !rootRect.width || !rootRect.height) continue; const rect = dom.getBoundingClientRect(); const chartImage = await imageFromUrl(instance.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#f6f8fc' })); const x = (rect.left - rootRect.left) / rootRect.width * canvas.width; const y = (rect.top - rootRect.top) / rootRect.height * canvas.height; const width = rect.width / rootRect.width * canvas.width; const height = rect.height / rootRect.height * canvas.height; ctx.drawImage(chartImage, x, y, width, height); }
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }
  async function svgPng() { if (state.previewPending || !state.previewBlob || state.previewPath !== state.selectedPath) throw new Error('当前图片仍在渲染，请等待对应预览显示后再应用。'); return state.previewBlob; }
  async function loadDocx(file) { if (!window.DecompressionStream || !window.CompressionStream) throw new Error('当前浏览器不支持 ZIP 解压缩。请使用最新版 Edge 或 Chrome。'); setStatus('正在读取 Word...', ''); const zip = readZip(await file.arrayBuffer()); const entries = zip.entries.filter((x) => /^word\/media\/.*\.(png|jpe?g)$/i.test(x.name) && x.name.toLowerCase() !== 'word/media/image2.png'); if (!entries.length) throw new Error('这个 DOCX 中没有可替换的 PNG/JPEG 图片。'); state.docx = zip; state.docxFile = file; state.replacements.clear(); state.selectedPath = ''; state.selectedMediaItem = null; state.media = []; state.mediaMetadata = await readMediaMetadata(zip);
    for (const entry of entries) { const raw = await unpack(entry), blob = new Blob([raw], { type: entry.name.endsWith('.png') ? 'image/png' : 'image/jpeg' }), url = URL.createObjectURL(blob); const dimensions = await new Promise((resolve) => { const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight }); image.onerror = () => resolve({ width: 1380, height: 720 }); image.src = url; }); state.media.push({ path: entry.name, url, ...dimensions }); }
    renderMedia();
    if (state.charts.length) selectInitialMappedMedia();
    $('download').disabled = false; $('replace-image').disabled = false; setStatus(`已读取 ${entries.length} 张 Word 图片`, 'ok');
  }
  // 一张截图的主图表：带 iframe 的组件里，主图表就是那个看板。评级只是看板里的一小块，
  // 在分组里排最前面是为了好找，但不能拿它当这张 Word 图的标题——否则媒体列表会把整个
  // 看板截图标成「总体评级」，看着像只含一张评级图。
  function primaryChartId(component) {
    const iframeChart = state.charts.find((item) => item.kind === 'iframe' && component.charts.includes(item.id));
    return iframeChart ? iframeChart.id : component.charts[0];
  }
  // A Word screenshot may contain several charts. Keep an independent edit buffer for
  // each chart and display every chart belonging to the selected screenshot together.
  function componentCharts() {
    const component = componentForSelection();
    const ids = component ? component.charts : (state.activeChart ? [state.activeChart.id] : []);
    return ids.map((id) => state.charts.find((chart) => chart.id === id)).filter(Boolean).map((source) => {
      const edited = state.edits.get(source.id);
      return { ...structuredClone(source), rows: edited ? structuredClone(edited) : structuredClone(source.rows) };
    });
  }
  function persistChart(chart) {
    state.edits.set(chart.id, chart.rows.map((row) => ({ ...row })));
    if (state.activeChart && state.activeChart.id === chart.id) state.activeChart.rows = structuredClone(chart.rows);
  }
  function updateSummary(summary, chart) {
    if (chart.kind === 'attackChain') { summary.innerHTML = `时间轴条目 <strong>${chart.rows.length}</strong>`; return; }
    if (chart.kind === 'grade') { summary.innerHTML = `当前评级 <strong>${escapeXml((chart.rows[0] && chart.rows[0].value) || '—')}</strong>`; return; }
    if (chart.id === 'top5Risk') { summary.innerHTML = `资产 <strong>${chart.rows.length}</strong>`; return; }
    summary.innerHTML = `条目 <strong>${chart.rows.length}</strong>`;
  }
  function renderChartGroup(holder, chart) {
    const group = document.createElement('section');
    group.className = 'chart-editor-group';
    group.dataset.chartId = chart.id;
    const heading = document.createElement('h3');
    heading.textContent = chart.title;
    group.append(heading);
    const summary = document.createElement('div');
    summary.className = 'field-summary';
    updateSummary(summary, chart);
    group.append(summary);
    chart.rows.forEach((row, index) => {
      const fragment = $('row-template').content.cloneNode(true);
      const el = fragment.querySelector('.data-row');
      if (chart.kind === 'attackChain') {
        // 时间轴是文本而非数值，不能走下面的数值行模型（那里会把内容强制 Number 成 0）。
        el.classList.add('attack-chain-row');
        el.innerHTML = '<input class="name" aria-label="阶段名或卡片标签"><input class="time" aria-label="时间"><input class="desc" aria-label="说明"><button type="button" class="remove" title="删除此项">删除</button>';
        const name = el.querySelector('.name');
        const time = el.querySelector('.time');
        const desc = el.querySelector('.desc');
        name.placeholder = row.rowType === 'attack' ? '留空 = 续接上一阶段' : '留空 = 续接上一张卡片';
        time.placeholder = 'MM-DD HH:mm';
        desc.placeholder = '说明';
        const sync = () => { persistChart(chart); updateSummary(summary, chart); scheduleRedraw(); };
        name.value = row.name;
        time.value = row.time;
        desc.value = row.desc;
        name.addEventListener('input', () => { row.name = name.value.slice(0, 60); sync(); });
        time.addEventListener('input', () => { row.time = time.value.slice(0, 20); sync(); });
        desc.addEventListener('input', () => { row.desc = desc.value.slice(0, 200); sync(); });
        el.querySelector('.remove').addEventListener('click', () => { chart.rows.splice(index, 1); persistChart(chart); renderFields(); });
        group.append(fragment);
        return;
      }
      if (chart.kind === 'grade') {
        // 四档各对应一张固定 PNG（档位名、配色、仪表盘刻度全烘在图里），所以只能选不能填，
        // 也不能新增或删除——档位就是这四个。
        // 控件必须是 <select> 而不是数字框：回归门 edit_gate / p6_race 是按
        // 「#fields 里第一个 input[type=number]」定位字段的，这里放数字框会把它们的
        // 指针挪到评级上，症状是"像素对不上"，看着像渲染回归。select 不进那个集合。
        el.classList.add('grade-row');
        el.innerHTML = '<span class="grade-label">总体评级</span><select class="grade" aria-label="总体评级"></select>';
        const select = el.querySelector('.grade');
        Object.keys(state.gradeAssets).forEach((name) => {
          const option = document.createElement('option');
          option.value = name;
          option.textContent = name;
          select.append(option);
        });
        select.value = row.value;
        select.addEventListener('change', () => {
          row.value = select.value;
          persistChart(chart);
          updateSummary(summary, chart);
          scheduleRedraw();
        });
        group.append(fragment);
        return;
      }
      if (chart.id === 'top5Risk') {
        // 每根柱子是 5 个风险类型的堆叠，所以逐段给输入框，而不是只给一个总数。
        el.classList.add('top5-risk-row');
        el.innerHTML = '<div class="risk-head"><input class="name" aria-label="资产名称"><span class="risk-total"></span><button type="button" class="remove" title="删除此项">删除</button></div>'
          + '<div class="risk-segments">'
          + TOP5_RISK_SEGMENTS.map((segment) => `<label title="${segment.full}">${segment.label}<input class="${segment.key}" type="number" min="0" step="1" aria-label="${segment.full}"></label>`).join('')
          + '</div>';
        const name = el.querySelector('.name');
        const totalEl = el.querySelector('.risk-total');
        const inputs = TOP5_RISK_SEGMENTS.map((segment) => el.querySelector(`.${segment.key}`));
        const renderTotal = () => { totalEl.innerHTML = `合计 <strong>${top5RiskRowTotal(row)}</strong>`; };
        const sync = () => {
          TOP5_RISK_SEGMENTS.forEach((segment, i) => { row[segment.key] = Math.max(0, Math.round(Number(inputs[i].value) || 0)); });
          row.value = top5RiskRowTotal(row);
          renderTotal();
          persistChart(chart);
          updateSummary(summary, chart);
          scheduleRedraw();
        };
        name.value = row.name;
        TOP5_RISK_SEGMENTS.forEach((segment, i) => { inputs[i].value = Math.max(0, Number(row[segment.key]) || 0); });
        renderTotal();
        name.addEventListener('input', () => { row.name = name.value.slice(0, 40); persistChart(chart); scheduleRedraw(); });
        inputs.forEach((input) => input.addEventListener('input', sync));
        el.querySelector('.remove').addEventListener('click', () => { chart.rows.splice(index, 1); persistChart(chart); renderFields(); });
        group.append(fragment);
        return;
      }
      if (chart.id === 'exposureAssets') {
        el.classList.add('exposure-asset-row');
        el.innerHTML = '<input class="name" aria-label="资产名称"><input class="web" type="number" min="0" step="1" aria-label="Web 服务数"><input class="nonweb" type="number" min="0" step="1" aria-label="非 Web 服务数"><button type="button" class="remove" title="删除此项">删除</button>';
        const name = el.querySelector('.name');
        const web = el.querySelector('.web');
        const nonWeb = el.querySelector('.nonweb');
        const sync = () => {
          row.web = Math.max(0, Math.round(Number(web.value) || 0));
          row.nonWeb = Math.max(0, Math.round(Number(nonWeb.value) || 0));
          row.value = row.web + row.nonWeb;
          persistChart(chart);
          updateSummary(summary, chart);
          scheduleRedraw();
        };
        name.value = row.name;
        web.value = Math.max(0, Number(row.web) || 0);
        nonWeb.value = Math.max(0, Number(row.nonWeb) || 0);
        name.addEventListener('input', () => { row.name = name.value.slice(0, 40); persistChart(chart); scheduleRedraw(); });
        web.addEventListener('input', sync);
        nonWeb.addEventListener('input', sync);
        el.querySelector('.remove').addEventListener('click', () => { chart.rows.splice(index, 1); persistChart(chart); renderFields(); });
        group.append(fragment);
        return;
      }
      const name = el.querySelector('.name');
      const value = el.querySelector('.value');
      name.value = row.name;
      value.value = row.value;
      // 固定类目图的类目名决定颜色，改名会落到名单外变成灰色，所以连名字一起锁死。
      const nameLocked = chart.kind === 'iframe' || chart.kind === 'domText' || !!FIXED_CATEGORY_NAMES[chart.id];
      if (nameLocked) {
        name.readOnly = true;
        name.setAttribute('aria-readonly', 'true');
        name.title = '该类目名固定，用于匹配报告配色，不可修改';
      } else name.addEventListener('input', () => { row.name = name.value.slice(0, 40); persistChart(chart); updateSummary(summary, chart); scheduleRedraw(); });
      value.addEventListener('input', () => { row.value = Math.max(0, Number(value.value) || 0); persistChart(chart); updateSummary(summary, chart); scheduleRedraw(); });
      if (chart.kind === 'iframe' || chart.kind === 'domText') el.querySelector('.remove').remove();
      else el.querySelector('.remove').addEventListener('click', () => { chart.rows.splice(index, 1); persistChart(chart); renderFields(); });
      group.append(fragment);
    });
    const actions = document.createElement('div');
    actions.className = 'field-actions';
    if (chart.kind === 'attackChain') {
      actions.innerHTML = '<button type="button" class="add-attack">新增攻击阶段</button><button type="button" class="add-defense">新增防守卡片</button><button type="button" class="reset">恢复 HTML 原始数据</button>';
      actions.querySelector('.add-attack').addEventListener('click', () => { chart.rows.push({ rowType: 'attack', name: '新阶段', time: '', desc: '' }); persistChart(chart); renderFields(); });
      actions.querySelector('.add-defense').addEventListener('click', () => { chart.rows.push({ rowType: 'defense', name: '新卡片', time: '', desc: '' }); persistChart(chart); renderFields(); });
    } else {
      // 固定类目图（三张环形图）的类目名既决定配色又不能改名，所以只能从名单里挑还没出现的那个补回来，
      // 用下拉让用户自己选具体补哪一个；名单补齐后不再出现新增控件。其余图表仍可自由新增分类。
      const missing = missingFixedCategories(chart);
      const editable = chart.kind !== 'iframe' && chart.kind !== 'domText' && chart.kind !== 'grade';
      const resetButton = '<button type="button" class="reset">恢复 HTML 原始数据</button>';
      if (editable && missing && missing.length) {
        actions.innerHTML = '<select class="add-category" aria-label="选择要补充的类目">'
          + missing.map((nameValue) => `<option value="${escapeXml(nameValue)}">${escapeXml(nameValue)}</option>`).join('')
          + `</select><button type="button" class="add-confirm">新增分类</button>${resetButton}`;
        const select = actions.querySelector('.add-category');
        actions.querySelector('.add-confirm').addEventListener('click', () => {
          chart.rows.push({ name: select.value, value: 0 });
          persistChart(chart);
          renderFields();
        });
      } else if (editable && !missing) {
        const addLabel = chart.id === 'top5Risk' ? '新增资产' : '新增分类';
        actions.innerHTML = `<button type="button" class="add-row">${addLabel}</button>${resetButton}`;
        actions.querySelector('.add-row').addEventListener('click', () => {
          chart.rows.push(chart.id === 'exposureAssets' ? { name: '新资产', web: 0, nonWeb: 0, value: 0 }
            : chart.id === 'top5Risk' ? blankTop5RiskRow('新资产') : { name: '新分类', value: 0 });
          persistChart(chart);
          renderFields();
        });
      } else {
        actions.innerHTML = resetButton;
      }
    }
    actions.querySelector('.reset').addEventListener('click', () => {
      const original = state.charts.find((item) => item.id === chart.id);
      chart.rows = original.rows.map((item) => ({ ...item }));
      state.edits.delete(chart.id);
      if (state.activeChart && state.activeChart.id === chart.id) state.activeChart.rows = structuredClone(chart.rows);
      renderFields();
    });
    group.append(actions);
    holder.append(group);
  }
  function renderFields() {
    const active = state.activeChart;
    const holder = $('fields');
    holder.innerHTML = '';
    if (!active) return;
    const charts = componentCharts();
    // 一张截图可能对应多个图表，标题只在多于一个时提示数量；具体图表名在下拉和各组标题里已经有了。
    $('chart-title').textContent = charts.length > 1 ? `共 ${charts.length} 个图表` : active.title;
    charts.forEach((chart) => renderChartGroup(holder, chart));
    redrawComponent();
  }
  function iframeRows(chart) { return state.edits.get(chart.id) || chart.rows; }
  function setPreviewUpdating(updating) {
    const preview = $('preview');
    const existing = preview.querySelector('.preview-update-state');
    if (!updating) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const indicator = document.createElement('span');
    indicator.className = 'preview-update-state';
    indicator.textContent = '正在更新预览';
    indicator.setAttribute('role', 'status');
    preview.append(indicator);
  }
  function displayIframeValue(row) { return row.selector.includes('.slash') ? `/${row.value}` : (row.name.endsWith('率') ? `${row.value}%` : String(row.value)); }
  function setIframeValue(node, row) {
    if (row.selector.includes('.slash')) {
      node.textContent = displayIframeValue(row);
      return;
    }
    const slash = node.querySelector('.slash');
    if (slash) {
      node.firstChild.textContent = String(row.value);
      return;
    }
    node.textContent = displayIframeValue(row);
  }
  // 评级那张图不在 rows 里（它没有 selector，是个 <img>），所以单独一步。
  // 换完 src 必须等浏览器把新的 data URI 解码出来再截图：html2canvas 是克隆 DOM 再画，
  // 没解码完的那张会被拍成旧图或者空白。所以先 await imageFromUrl 预热，再写 src。
  async function applyGradeEdit(doc, chart) {
    const rows = iframeRows(chart);
    const grade = rows[0] && rows[0].value;
    const src = state.gradeAssets[grade];
    if (!src) return;
    const img = doc.getElementById('ro5-gauge-img');
    if (img && img.getAttribute('src') !== src) {
      // 预热失败（图坏了）也照样写 src：让用户在图上看到问题，而不是整个预览出不来。
      try { await imageFromUrl(src); } catch { /* 忽略 */ }
      img.src = src;
    }
    if (img) img.alt = `总体评分：${grade}`;
    // 这两个属性只是让 DOM 自洽。模板里的 resolveGrade 只在装载时跑一次，之后没人再读它，
    // 真正决定截图内容的只有上面那个 src。
    const card = doc.getElementById('ro5-gauge-card');
    if (card) card.setAttribute('data-grade', grade);
    if (doc.documentElement) doc.documentElement.setAttribute('data-report-grade', grade);
  }
  async function applyIframeEdits(doc, component) {
    // 一个组件可能同时挂着数字看板和评级两张"图"，所以按 kind 取，不能按位置取。
    const chart = state.charts.find((item) => item.kind === 'iframe' && component.charts.includes(item.id));
    if (chart) iframeRows(chart).forEach((row) => {
      const node = doc.querySelector(row.selector);
      if (!node) return;
      setIframeValue(node, row);
      if (node.hasAttribute('data-log-count')) node.setAttribute('data-log-count', String(row.value));
    });
    const gradeChart = state.charts.find((item) => item.kind === 'grade' && component.charts.includes(item.id));
    if (gradeChart) await applyGradeEdit(doc, gradeChart);
  }
  function iframeTemplateFromHtml(html, iframeId) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const template = doc.getElementById(`tpl-${iframeId}`);
    return template ? template.textContent : '';
  }
  function iframePreviewHtml(html) {
    const previewStyle = '<style>html,body{width:max-content!important;height:max-content!important;min-width:100%!important;overflow:auto!important}#fit-root{width:max-content!important;height:auto!important;overflow:visible!important}#stage{transform:none!important}</style>';
    return html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${previewStyle}`);
  }
  function showIframePreview(html, component, chart) {
    const preview = document.createElement('iframe');
    preview.className = 'html-iframe-preview';
    // 预览装的是整个看板模板，跟当前激活的是哪一组无关，所以标题用主图表的名字，
    // 别因为激活了同一张截图下的评级组就把它标成「总体评级 实时预览」。
    const label = state.charts.find((item) => item.id === primaryChartId(component)) || chart;
    preview.title = `${label.title} 实时预览`;
    preview.scrolling = 'yes';
    preview.onload = () => { applyIframeEdits(preview.contentDocument, component).catch(() => {}); };
    preview.srcdoc = iframePreviewHtml(html);
    $('preview').replaceChildren(preview);
  }
  async function rasterizeIframeComponent(doc, component, target) {
    const root = doc.getElementById('fit-root') || doc.body;
    if (!root?.children.length) throw new Error(`嵌入式看板没有渲染出内容：${component.iframe}`);
    if (typeof window.html2canvas !== 'function') throw new Error('HTML 截图组件未加载。');
    await applyIframeEdits(doc, component);
    const stage = doc.getElementById('stage') || root;
    // The template scales .stage to fit #fit-root at runtime. html2canvas captures
    // the container but does not faithfully apply that transform, leaving blank space.
    // Capture the design canvas directly at its unscaled size instead.
    const previousTransform = stage.style.transform;
    const previousRootWidth = root.style.width;
    const previousRootHeight = root.style.height;
    stage.style.transform = 'none';
    root.style.width = `${stage.offsetWidth}px`;
    root.style.height = 'auto';
    const width = Math.ceil(stage.scrollWidth || stage.offsetWidth);
    const height = Math.ceil(stage.scrollHeight || stage.offsetHeight);
    if (!width || !height) throw new Error('嵌入式看板尺寸无效。');
    try {
      const source = await window.html2canvas(stage, {
        backgroundColor: '#ffffff', useCORS: false, allowTaint: false, logging: false,
        scale: 1, width, height, windowWidth: width, windowHeight: height
      });
      const canvas = document.createElement('canvas');
      canvas.width = target.width;
      canvas.height = target.height;
      canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
      return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('看板 PNG 导出失败。')), 'image/png'));
    } finally {
      stage.style.transform = previousTransform;
      root.style.width = previousRootWidth;
      root.style.height = previousRootHeight;
    }
  }
  // "ECharts 实例已建立"这个就绪条件下得太早了。报告页在 iframe 里是边加载边排布的：
  // 图表容器的高度、图例条数往往还要等报告脚本再算一步（实测某个环图容器 240px → 325px，
  // 而且是在实例出现 300ms 之后），这时量到的 rect 是错的，贴回去的图会偏位，
  // Word 原图从底下透出来看着像画了两遍；柱状图、环图默认还有约 1s 的入场动画，
  // 动画没播完 getDataURL 拿到的是半截柱子。所以等到这个组件真正静止下来再截图。
  function chartsStillAnimating(frame, component) {
    return component.charts.some((id) => {
      const chart = state.charts.find((item) => item.id === id);
      if (hasNoEchartsInstance(chart)) return false;
      const dom = chart && frame.contentDocument.getElementById(chart.elementId);
      const instance = dom && frame.contentWindow.echarts && frame.contentWindow.echarts.getInstanceByDom(dom);
      const animation = instance && instance.getZr && instance.getZr().animation;
      // 探测不到动画状态就当作没在动，否则会一直等下去。
      return Boolean(animation && typeof animation.isFinished === 'function' && !animation.isFinished());
    });
  }
  function componentGeometry(frame, component) {
    const root = componentRoot(frame.contentDocument, component);
    if (!root) return '';
    const rootRect = root.getBoundingClientRect();
    const parts = [`${Math.round(rootRect.width)}x${Math.round(rootRect.height)}`];
    component.charts.forEach((id) => {
      const chart = state.charts.find((item) => item.id === id);
      const dom = chart && frame.contentDocument.getElementById(chart.elementId);
      const rect = dom && dom.getBoundingClientRect();
      parts.push(rect ? [Math.round(rect.left - rootRect.left), Math.round(rect.top - rootRect.top), Math.round(rect.width), Math.round(rect.height)].join(',') : '-');
    });
    return parts.join('|');
  }
  async function waitForSettled(frame, component, version, selectedPath, animationDeadlineMs) {
    const started = Date.now();
    // 动画等 2.5s 就放弃（万一哪个图表是循环动画，不能永远不截图），版式稳定最多再等 4s。
    // 增量重绘传 0：那条路上数据是同步塞进去的，没有再播入场动画的余地。
    const animationDeadline = started + (animationDeadlineMs ?? 2500);
    const deadline = started + 4000;
    let last = '';
    let stable = 0;
    while (Date.now() < deadline) {
      const geometry = componentGeometry(frame, component);
      const animating = chartsStillAnimating(frame, component) && Date.now() < animationDeadline;
      if (geometry === last && !animating) {
        stable += 1;
        if (stable >= 3) return;
      } else {
        stable = 0;
      }
      last = geometry;
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (version !== state.renderVersion || state.selectedPath !== selectedPath) return;
    }
  }
  function nextFrame() { return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); }

  // ---- 两条预览路径 ---------------------------------------------------------
  // 整份重载：把 5.95MB 的报告重新赋给 srcdoc，iframe 重新解析、重新执行全部内联脚本。
  //   旧报告和嵌入式看板只能走这条，所以它一个字都不能改。
  // 增量重绘：iframe 只装一次，之后只把新数据塞进 window.SECURITY_REPORT_DATA，
  //   再调该图表自己注册的重绘入口。前提是模板里有 window.SRChartRerender。
  //
  // 两条路的差别只在"怎么把数据送进图里"，后面的截图收尾是同一套。

  function frameIsUsable(frame) {
    return Boolean(frame && frame.__srLoaded && frame.contentWindow && frame.contentDocument);
  }
  // 换一份报告 HTML 时必须把 iframe 里那点状态清掉。否则 __srLoaded 还是上一份报告的
  // true，canPatch 会点头，patch 却打在上一份报告的 DOM 上——预览出来是新报告的版式
  // 配旧报告的数据，而且不会有任何报错。
  function resetRenderFrame() {
    const frame = $('render-frame');
    frame.__srLoaded = false;
    frame.__srPatchBroken = false;
    frame.onload = null;
    frame.removeAttribute('srcdoc');
  }
  function chartById(id) { return state.charts.find((entry) => entry.id === id); }

  // 每个非文本类图表都得在注册表里报过到，否则那张图会一直画着旧数据。
  function canPatch(frame, component) {
    if (!INCREMENTAL_REDRAW || !frameIsUsable(frame) || component.iframe) return false;
    // 一旦哪次 patch 抛了异常就整帧拉黑。注册表在但某张图重绘报错，说明模板和编辑器
    // 对不上，这不是"再试一次就好"的事——继续试只会让每次按键都白等一轮。
    if (frame.__srPatchBroken) return false;
    const win = frame.contentWindow;
    if (!win.SRChartRerender) return false;
    // 分页模式会重排整个版面（几何基准随之变化），而增量重绘不会触发重排。
    if (win.SRPagePagination && win.SRPagePagination.isPagedMode()) return false;
    return component.charts.every((id) => {
      const chart = chartById(id);
      if (!chart || hasNoEchartsInstance(chart)) return true;
      return win.SRChartRerender.has(chart.elementId);
    });
  }

  function patchCharts(frame, component, previewData) {
    const win = frame.contentWindow;
    const registry = win.SRChartRerender;
    // 关掉入场动画再重绘。截图抓的是画布当下这一帧，动画没播完就是半截柱子，
    // 而"什么时候播完"取决机器快慢——同一份数据两次导出可能不一样。
    // 关掉之后重绘是同步出终态的，waitForSettled 才敢把动画等待设成 0。
    win.SR_CHART_NO_ANIMATION = true;
    win.SECURITY_REPORT_DATA = previewData;
    let failed = null;
    component.charts.forEach((id) => {
      const chart = chartById(id);
      if (!chart || hasNoEchartsInstance(chart)) return;
      try {
        const result = registry.render(chart.elementId, previewData);
        if (!result || !result.ok) failed = chart.elementId;
      } catch (error) { failed = `${chart.elementId}: ${error.message}`; }
    });
    if (failed) return { ok: false, reason: failed };
    // 兄弟卡片进出空态会改宽度（比如环图那张卡整块换成"暂无数据"），
    // 所以全部画完之后再统一收一次尺寸，避免某张图按旧宽度排版。
    component.charts.forEach((id) => {
      const chart = chartById(id);
      const dom = chart && frame.contentDocument.getElementById(chart.elementId);
      const instance = dom && win.echarts && win.echarts.getInstanceByDom(dom);
      if (instance) instance.resize();
    });
    return { ok: true };
  }

  function buildFrameHtml(loadVersion, previewData, component) {
    if (component.iframe) {
      const html = iframeTemplateFromHtml(state.sourceHtml, component.iframe);
      if (!html) return null;
      return html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}<meta name="word-chart-editor-render" content="${loadVersion}">`);
    }
    const dataScript = `<script>window.SECURITY_REPORT_DATA=${JSON.stringify(previewData).replace(/</g, '\\u003c')};</script>`;
    let html = state.sourceHtml
      .replace(/<script>window\.SECURITY_REPORT_DATA=.*?<\/script>/, dataScript)
      .replace(/<head(\s[^>]*)?>/i, (head) => `${head}<meta name="word-chart-editor-render" content="${loadVersion}">`);
    html = replaceInlineChartRowsInHtml(html, previewData);
    html = replaceDonutCenterTotalsInHtml(html);
    if (component.charts.includes('exposureAssets')) html = replaceExposureAssetRowsInHtml(html, previewData);
    return html;
  }

  // 装载标记只认 frameLoadVersion。iframe 只装一次之后，renderVersion 会因为每次编辑
  // 而自增，但它跟"iframe 里装的是哪一版 html"已经没关系了——继续拿它校验，
  // 装载完第一次之后 marker 永远对不上。
  function loadFrame(frame, html) {
    return new Promise((resolve) => {
      frame.__srLoaded = false;
      frame.onload = () => {
        const marker = frame.contentDocument.querySelector('meta[name="word-chart-editor-render"]')?.content;
        if (marker !== String(state.frameLoadVersion)) return;
        frame.__srLoaded = true;
        resolve();
      };
      frame.srcdoc = html;
    });
  }

  // 空数据分支下的图表**永远不会有 echarts 实例**（它整块换成"暂无数据"了）。
  // 原来这里只认实例，于是空数据报告必然等到 30 秒超时、预览出不来。
  // 认一下空态哨兵/空态 div 就算画完了。
  function chartRendered(frame, chart) {
    if (!chart || hasNoEchartsInstance(chart)) return true;
    const dom = frame.contentDocument.getElementById(chart.elementId);
    if (!dom) return false;
    if (frame.contentWindow.echarts && frame.contentWindow.echarts.getInstanceByDom(dom)) return true;
    if (dom.__srEmpty) return true;
    return Boolean(frame.contentDocument.querySelector(`[data-sr-empty-for="${chart.elementId}"]`));
  }

  async function commitPreview(frame, component, chart, version, selectedPath, selectedItem, html) {
    if (version !== state.renderVersion || state.selectedPath !== selectedPath) return;
    if (component.iframe) {
      showIframePreview(html, component, chart);
      setPreviewUpdating(true);
      const blob = await rasterizeIframeComponent(frame.contentDocument, component, selectedItem);
      if (version !== state.renderVersion || state.selectedPath !== selectedPath || !blob) return;
      state.previewBlob = blob;
      state.previewPath = selectedPath;
      state.previewPending = false;
      setPreviewUpdating(false);
      $('apply-chart').disabled = false;
      return;
    }
    const blob = await composeComponent(frame, component, selectedItem);
    if (version !== state.renderVersion || state.selectedPath !== selectedPath || !blob) return;
    state.previewBlob = blob;
    state.previewPath = selectedPath;
    state.previewPending = false;
    const image = new Image(); image.alt = `${chart.title} 预览`; image.src = URL.createObjectURL(blob);
    $('preview').replaceChildren(image); setPreviewUpdating(false); $('apply-chart').disabled = false;
  }

  // 增量路径：不重载、不丢弃现有预览（丢了会闪回 Word 原图）。
  // 因为 previewPending 期间 svgPng 会拒绝出图，#apply-chart 又是 disabled 的，
  // 旧 blob 停在 state 里不会被误用。
  async function redrawByPatch(frame, component, chart, version, selectedPath, selectedItem, previewData) {
    setPreviewUpdating(true);
    const result = patchCharts(frame, component, previewData);
    if (!result.ok) {
      // 拉黑整帧：注册表在、但某张图重绘却报错，说明模板和编辑器对不上，
      // 不是"再试一次就好"。粘住比"每版回落一次"更省——否则每次按键都要先白试一轮。
      frame.__srPatchBroken = true;
      setStatus(`增量重绘不可用（${result.reason}），本次起回退整份重载。`, '');
      return false;
    }
    await nextFrame();
    await waitForSettled(frame, component, version, selectedPath, 0);
    if (version !== state.renderVersion || state.selectedPath !== selectedPath) return true;
    await commitPreview(frame, component, chart, version, selectedPath, selectedItem, null);
    return true;
  }

  async function redrawByFullLoad(frame, component, chart, version, selectedPath, selectedItem, previewData) {
    // 装载标记只认 frameLoadVersion，而且每次真正装载都得换一个新值：
    // 复用旧值的话，上一次装载迟到的 onload 也会通过校验，把旧内容当成这一版。
    state.frameLoadVersion += 1;
    const hasCurrentPreview = state.previewPath === selectedPath && Boolean($('preview').querySelector('img, iframe'));
    state.previewBlob = null;
    state.previewPath = '';
    const html = buildFrameHtml(state.frameLoadVersion, previewData, component);
    if (html === null) {
      state.previewPending = false;
      setPreviewUpdating(false);
      $('preview').innerHTML = `<p>未找到嵌入式看板模板：${escapeXml(component.iframe)}。</p>`;
      return;
    }
    const base = selectedItem || selectedMedia();
    if (!hasCurrentPreview && base && !component.iframe) {
      const image = new Image();
      image.alt = `${chart.title} 预览`;
      image.src = base.url;
      $('preview').replaceChildren(image);
    } else if (!hasCurrentPreview && !component.iframe) $('preview').innerHTML = '<p>正在生成预览...</p>';
    setPreviewUpdating(true);
    await loadFrame(frame, html);
    if (version !== state.renderVersion || state.selectedPath !== selectedPath) return;
    const started = Date.now();
    const ready = async () => {
      if (version !== state.renderVersion || state.selectedPath !== selectedPath) return;
      const complete = component.iframe
        ? Boolean(frame.contentDocument.body?.children.length)
        : component.charts.every((id) => chartRendered(frame, chartById(id)));
      if (complete) {
        try {
          await waitForSettled(frame, component, version, selectedPath);
          if (version !== state.renderVersion || state.selectedPath !== selectedPath) return;
          await commitPreview(frame, component, chart, version, selectedPath, selectedItem, html);
        } catch (error) {
          state.previewPending = false;
          setPreviewUpdating(false);
          $('preview').innerHTML = `<p>${escapeXml(error.message)}</p>`;
        }
        return;
      }
      if (Date.now() - started < 30000) setTimeout(ready, 120);
      else {
        state.previewPending = false;
        $('preview').innerHTML = '<p>嵌入式看板未能在 30 秒内完成渲染，预览仍显示 Word 原图。</p>';
      }
    };
    ready();
  }

  // 输入框防抖：按住退格键改数字本来是每个按键都重绘一次。
  // 但只加防抖会引出一个更糟的问题——防抖窗口里，上一版数据的渲染可能刚好完成，
  // 它会写 state.previewBlob 并把"应用"按钮点亮，用户此时点下去就把旧数据的 PNG
  // 加进了导出。所以这里**同步**先作废在途渲染，再安排重绘。
  const REDRAW_DEBOUNCE_MS = 140;
  let redrawTimer = 0;
  function scheduleRedraw() {
    state.renderVersion += 1;
    state.previewPending = true;
    $('apply-chart').disabled = true;
    setPreviewUpdating(true);
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => { redrawTimer = 0; redrawComponent(); }, REDRAW_DEBOUNCE_MS);
  }
  function redrawComponent() {
    // 直接调用（切换图片、增删行）要顶掉还挂着的防抖任务。不然 140ms 后它还会再跑一次，
    // 把自己刚起的渲染用版本号作废掉，白白重画一遍。
    if (redrawTimer) { clearTimeout(redrawTimer); redrawTimer = 0; }
    const chart = state.activeChart, component = componentForSelection();
    if (!state.selectedPath) {
      $('preview').innerHTML = '<p>请先在左侧选择需要编辑的 Word 图片。</p>';
      return;
    }
    if (!component) {
      $('preview').innerHTML = `<p>当前选中图片没有数据映射：${escapeXml(state.selectedPath)}。</p>`;
      return;
    }
    if (!chart || !state.sourceHtml) {
      $('preview').innerHTML = '<p>正在等待报告 HTML 的图表数据。</p>';
      return;
    }
    const version = ++state.renderVersion;
    const selectedPath = state.selectedPath;
    const selectedItem = state.selectedMediaItem;
    const frame = $('render-frame');
    const previewData = reportDataForPreview();
    const patchable = canPatch(frame, component);
    state.previewPending = true;
    $('apply-chart').disabled = true;
    setPreviewUpdating(true);
    const run = async () => {
      // 增量这条路失败（hardFail）时必须真的落回整份重载，否则预览就停在
      // "更新中"再也不出来了。patchCharts 是同步的，所以回落不会和半途的渲染打架。
      if (patchable && await redrawByPatch(frame, component, chart, version, selectedPath, selectedItem, previewData)) return;
      if (version !== state.renderVersion || state.selectedPath !== selectedPath) return;
      await redrawByFullLoad(frame, component, chart, version, selectedPath, selectedItem, previewData);
    };
    run().catch((error) => {
      state.previewPending = false;
      setPreviewUpdating(false);
      $('preview').innerHTML = `<p>${escapeXml(error.message || '预览失败')}</p>`;
    });
  }
  function activateChart(id) { const source = state.charts.find((chart) => chart.id === id); const edited = source && state.edits.get(source.id); state.activeChart = source ? { ...structuredClone(source), rows: edited ? structuredClone(edited) : structuredClone(source.rows) } : null; $('chart-select').value = source ? source.id : ''; renderFields(); $('apply-chart').disabled = true; }
  function replacementCountText() { return state.replacements.size ? `已加入 ${state.replacements.size} 张待导出图片。` : '尚未加入替换图片。'; }
  function selectMedia(item) {
    const component = componentForPath(item.path);
    state.selectedPath = item.path;
    state.selectedMediaItem = item;
    renderMedia();
    const queued = state.replacements.has(item.path) ? '该图片已加入本次导出，可继续修改并再次应用以覆盖它。' : '该图片尚未加入导出。';
    $('mapping-hint').textContent = component
      ? `已选择 ${item.path}，该截图包含 ${component.charts.length} 个图表。${queued} ${replacementCountText()}`
      : `已选择 ${item.path}。该图片没有数据映射，可使用“自选 PNG”替换。${replacementCountText()}`;
    if (!state.charts.length) return;
    try {
      if (component) activateChart(primaryChartId(component));
      else {
        activateChart('');
        $('preview').innerHTML = `<p>当前选中图片没有数据映射：${escapeXml(item.path)}。</p>`;
      }
    } catch (error) {
      $('preview').innerHTML = `<p>预览初始化失败：${escapeXml(error.message || '未知错误')}。</p>`;
      setStatus(`预览初始化失败：${error.message || '未知错误'}`, 'error');
    }
  }
  function renderMedia() {
    const list = $('media-list');
    list.innerHTML = '';
    state.media.forEach((item) => {
      const button = document.createElement('button');
      const component = componentForPath(item.path);
      const title = component && state.charts.find((c) => c.id === primaryChartId(component))?.title;
      const queued = state.replacements.has(item.path);
      button.className = `media-item ${item === state.selectedMediaItem ? 'selected' : ''} ${queued ? 'queued' : ''}`;
      button.type = 'button';
      button.innerHTML = `<img src="${item.url}" alt="${item.path}"><span>${mediaFilename(item.path)}${title ? ` · ${title}` : ''}${queued ? ' · 待导出' : ''}</span>`;
      button.addEventListener('click', () => selectMedia(item));
      list.append(button);
    });
  }
  function selectInitialMappedMedia() {
    const item = state.media.find((entry) => componentForPath(entry.path));
    if (item) selectMedia(item);
  }
  function loadHtml(file) { const reader = new FileReader(); reader.onerror = () => setStatus('无法读取 HTML 文件。', 'error'); reader.onload = () => { try { state.sourceHtml = String(reader.result); resetRenderFrame(); state.gradeAssets = extractGradeAssets(state.sourceHtml); const match = state.sourceHtml.match(/window\.SECURITY_REPORT_DATA\s*=\s*([\s\S]*?);<\/script>/); if (!match) throw new Error('HTML 中未找到 SECURITY_REPORT_DATA。请选择由本项目生成的报告 HTML。'); state.reportData = JSON.parse(match[1]); state.charts = chartDefinitions(state.reportData); state.edits.clear(); if (!state.charts.length) throw new Error('该 HTML 中没有当前版本支持的图表数据。'); const select = $('chart-select'); select.innerHTML = state.charts.map((c) => `<option value="${c.id}">${escapeXml(c.title)}</option>`).join(''); select.disabled = false; select.onchange = () => activateChart(select.value); const component = componentForSelection(); if (component) activateChart(primaryChartId(component)); else selectInitialMappedMedia(); renderMedia(); setStatus(`已加载 ${state.charts.length} 个可编辑图表`, 'ok'); } catch (error) { setStatus(error.message, 'error'); } }; reader.readAsText(file, 'utf-8'); }
  $('docx-file').addEventListener('change', async (event) => { const file = event.target.files[0]; if (!file) return; try { await loadDocx(file); } catch (error) { setStatus(error.message, 'error'); } });
  $('html-file').addEventListener('change', (event) => { const file = event.target.files[0]; if (!file) return; try { loadHtml(file); } catch (error) { setStatus(error.message, 'error'); } });
  $('apply-chart').addEventListener('click', async () => { try { if (!state.selectedPath) throw new Error('请先在左侧选择 Word 图片。'); state.replacements.set(state.selectedPath, await svgPng()); renderMedia(); $('mapping-hint').textContent = `已将 ${state.selectedPath} 加入本次导出。现在可在左侧选择其他图片继续编辑。${replacementCountText()}`; setStatus(`已准备 ${state.replacements.size} 张图表图片替换`, 'ok'); } catch (error) { setStatus(error.message, 'error'); } });
  $('replace-image').addEventListener('click', () => { if (!state.selectedPath) { setStatus('请先在左侧选择 Word 图片。', 'error'); return; } $('png-file').click(); });
  $('png-file').addEventListener('change', (event) => { const file = event.target.files[0]; if (!file) return; state.replacements.set(state.selectedPath, file); renderMedia(); $('mapping-hint').textContent = `已将自选 PNG 加入 ${state.selectedPath} 的本次导出。现在可继续选择其他图片。${replacementCountText()}`; setStatus(`已准备 ${state.replacements.size} 张图片替换`, 'ok'); event.target.value = ''; });
  $('download').addEventListener('click', async () => { try { if (!state.docx || !state.docxFile) throw new Error('请先选择原始 Word 文件。'); if (!state.replacements.size) throw new Error('尚未选择任何要替换的图片。'); setStatus('正在生成新版 Word...', ''); const blob = await buildZip(state.docx, state.replacements); const base = state.docxFile.name.replace(/\.docx$/i, ''); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${base}-图表已更新.docx`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); setStatus(`已生成新版 Word，替换 ${state.replacements.size} 张图片`, 'ok'); } catch (error) { setStatus(error.message, 'error'); } });
})();
