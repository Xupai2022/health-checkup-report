'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildAssetExportRequestBody,
  buildIncidentExportRequestBody,
  buildIncidentCountRequestBody,
  parseLocalDate,
  resolveIncidentTimeRange,
  mapAssetTypeLabels,
  mapExposureTypeLabels,
  mapProtectionTypeLabels,
  normalizeCookieContent,
  normalizeAssetTypeResponse,
  normalizeAssetExposureResponse,
  normalizeAssetProtectionResponse,
  normalizeAssetStatisticsResponse,
  readXdrCookieInfo
} = require('../src/xdr_asset_client');

async function main() {
  const body = buildAssetExportRequestBody({
    asset_info: [{ key: 'ip' }]
  });

  assert.deepStrictEqual(body, {
    branch_id: 'all',
    search_type: 'current',
    platform_ids: [],
    is_all: false,
    ids: [],
    exclude_ids: [],
    export_fields: {
      asset_info: [{ key: 'ip' }]
    }
  });

  assert.strictEqual(parseLocalDate('2026-06-16'), Math.floor(new Date(2026, 5, 16, 0, 0, 0, 0).getTime() / 1000));
  assert.strictEqual(parseLocalDate('2026-06-16', true), Math.floor(new Date(2026, 5, 16, 23, 59, 59, 999).getTime() / 1000));
  assert.deepStrictEqual(resolveIncidentTimeRange({ start: '2026-06-16', end: '2026-06-16' }), {
    begin: Math.floor(new Date(2026, 5, 16, 0, 0, 0, 0).getTime() / 1000),
    end: Math.floor(new Date(2026, 5, 16, 23, 59, 59, 999).getTime() / 1000)
  });

  const incidentBody = buildIncidentExportRequestBody({
    begin: 1779033600,
    end: 1781625599
  });
  assert.strictEqual(incidentBody.type, 'exportIncidentExcel');
  assert.strictEqual(incidentBody.viewInstanceId, '6734768b73bfc87aeb00462c');
  assert.strictEqual(incidentBody.tableArea.viewName, 'IncidentView');
  assert.strictEqual(incidentBody.tableArea.tableFields[0].field, 'mssIncidentServiceStatus');
  assert.deepStrictEqual(
    incidentBody.tableArea.tableFields.find((field) => field.field === 'description'),
    {
      field: 'description',
      show: true,
      selected: false,
      sort: 'disable',
      columnWidth: 320,
      fixed: null,
      dataType: 'value'
    }
  );
  assert.strictEqual(incidentBody.tableArea.extensionParams.spl, 'filter xthConfirm= true');
  assert.strictEqual(incidentBody.tableArea.serviceInfo.handler, 'incidentTableQueryHandler');

  const incidentCountBody = buildIncidentCountRequestBody({
    begin: 1779120000,
    end: 1781711999
  });
  assert.deepStrictEqual(incidentCountBody, {
    extensionParams: null,
    spl: {
      mappedSpl: '',
      originalSpl: '',
      extensionParams: {
        frontRender: [],
        mappedInputSpl: '',
        originalInputSpl: ''
      }
    },
    serviceInfo: {
      appName: 'incident',
      servletContextPath: '/',
      serviceType: 'table',
      handler: 'incidentTableQueryHandler'
    },
    globalCondition: {
      branchIds: [],
      time: {
        timeField: 'startTime',
        begin: { type: 'absolute', value: 1779120000 },
        end: { type: 'absolute', value: 1781711999 }
      }
    },
    table: {
      enable: true,
      viewName: 'IncidentView',
      aggregationStrategies: null,
      tableFields: buildIncidentExportRequestBody({
        begin: 1779120000,
        end: 1781711999
      }).tableArea.tableFields,
      pageNum: 1,
      pageSize: 1000,
      serviceInfo: {
        appName: 'incident',
        servletContextPath: '/',
        serviceType: 'table',
        handler: 'incidentTableQueryHandler'
      },
      subTable: null,
      rightClicked: false,
      selectAllPage: true,
      routers: [
        {
          icon: null,
          path: '/incident/sec-event/detail',
          type: 'drillDown',
          params: null,
          actionParams: {
            disposedDisableFlag: '$disposedDisableFlag',
            orderDisableFlag: '$orderDisableFlag',
            disposingDisableFlag: '$disposingDisableFlag',
            pendingDisableFlag: '$pendingDisableFlag',
            ignoreDisableFlag: '$ignoreDisableFlag',
            id: '$uuId',
            hungupDisableFlag: '$hungupDisableFlag',
            soarDisableFlag: '$soarDisableFlag'
          },
          applicableCols: ['name']
        }
      ],
      rightActions: [
        {
          name: 'addFilter',
          type: 'filter',
          params: null,
          actionParams: null,
          applicableCols: ['attackState', 'devSourceNames', 'xthExpert', 'occurTime', 'soarMatchEventTag', 'ignoreDisableFlag', 'platformIsDelete', 'platformHostBranchId', 'hostBranchId', 'remarkInfo', 'huntingDomains', 'serviceEventId', 'incidentThreatClass', 'devUIdProxy', 'suppressTime', 'id', 'dataSources', 'phishing', 'read', 'gptStartAt', 'hostIp', 'huntingIps', 'mssTagType', 'hostAssetAnalyzeResult', 'dealStatus', 'soarDisableFlag', 'insertTime', 'hostProvinceName', 'hostIpAll', 'orderDisableFlag', 'auditTime', 'auditLogTraceInfo', 'disposingDisableFlag', 'name', 'dataAuthorityBranchId', 'gptResult', 'xthAttackIntent', 'whiteStatus', 'alertNumber', 'incidentSourceProxy', 'gptEndAt', 'eventRuleId', 'description', 'isAutoDispose', 'regionIds', 'auditType', 'hungupDisableFlag', 'mssIncidentServiceStatus', 'platformRole', 'auditFrom', 'xthTag', 'pendingDisableFlag', 'eventEngine', 'startTime', 'addWhiteDisableFlag', 'hostGroupIds', 'gptAnalyzeTime', 'hostAssetId', 'severity', 'hostClassify1Id', 'connectStatus', 'disposedDisableFlag', 'hostClassifyId', 'xthConfirm', 'pendingXth', 'platformId', 'uploadTime', 'uuId', 'logTraceInfo', 'timeLimit', 'incidentThreatType', 'devUId', 'platformHostGroupIds', 'fromXth', 'riskTag', 'disposeTime', 'alertIds', 'dealAction', 'hostCountryName', 'regionId', 'huntingMD5s', 'xthType', 'endTime', 'threatDefine']
        },
        {
          name: 'copyCellText',
          type: 'copy',
          params: null,
          actionParams: null,
          applicableCols: ['name', 'uuId', 'hostIp']
        },
        {
          name: 'removeFilter',
          type: 'filter',
          params: null,
          actionParams: null,
          applicableCols: ['attackState', 'devSourceNames', 'xthExpert', 'occurTime', 'soarMatchEventTag', 'ignoreDisableFlag', 'platformIsDelete', 'platformHostBranchId', 'hostBranchId', 'remarkInfo', 'huntingDomains', 'serviceEventId', 'incidentThreatClass', 'devUIdProxy', 'suppressTime', 'id', 'dataSources', 'phishing', 'read', 'gptStartAt', 'hostIp', 'huntingIps', 'mssTagType', 'hostAssetAnalyzeResult', 'dealStatus', 'soarDisableFlag', 'insertTime', 'hostProvinceName', 'hostIpAll', 'orderDisableFlag', 'auditTime', 'auditLogTraceInfo', 'disposingDisableFlag', 'name', 'dataAuthorityBranchId', 'gptResult', 'xthAttackIntent', 'whiteStatus', 'alertNumber', 'incidentSourceProxy', 'gptEndAt', 'eventRuleId', 'description', 'isAutoDispose', 'regionIds', 'auditType', 'hungupDisableFlag', 'mssIncidentServiceStatus', 'platformRole', 'auditFrom', 'xthTag', 'pendingDisableFlag', 'eventEngine', 'startTime', 'addWhiteDisableFlag', 'hostGroupIds', 'gptAnalyzeTime', 'hostAssetId', 'severity', 'hostClassify1Id', 'connectStatus', 'disposedDisableFlag', 'hostClassifyId', 'xthConfirm', 'pendingXth', 'platformId', 'uploadTime', 'uuId', 'logTraceInfo', 'timeLimit', 'incidentThreatType', 'devUId', 'platformHostGroupIds', 'fromXth', 'riskTag', 'disposeTime', 'alertIds', 'dealAction', 'hostCountryName', 'regionId', 'huntingMD5s', 'xthType', 'endTime', 'threatDefine']
        },
        {
          name: 'incidentUnRead',
          type: 'modifyReadStatus',
          params: null,
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentRead',
          type: 'modifyReadStatus',
          params: null,
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentPending',
          type: 'modifyDealStatus',
          params: { disable: '$pendingDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentDisposing',
          type: 'modifyDealStatus',
          params: { disable: '$disposingDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentDisposed',
          type: 'modifyDealStatus',
          params: { disable: '$disposedDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentSuppress',
          type: 'modifyDealStatus',
          params: { disable: '$disposedDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentHungup',
          type: 'modifyDealStatus',
          params: { disable: '$hungupDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentIgnored',
          type: 'modifyDealStatus',
          params: { disable: '$ignoreDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentAddWhite',
          type: 'addWhite',
          params: { disable: '$addWhiteDisableFlag' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'soarDisposalRecord',
          type: 'item',
          params: { disable: '$soarDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'flowDisposalRecord',
          type: 'item',
          params: { disable: '$orderDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        }
      ],
      extensionParams: {
        spl: 'filter xthConfirm= true'
      },
      tag: [
        {
          field: 'fromXth',
          fieldValue: true,
          tagColor: '#1C6EFF',
          tagValue: 'XTH',
          tagSuspendedValue: 'XTH：云端主动威胁狩猎'
        }
      ]
    },
    viewName: 'IncidentView',
    model: 'simple',
    viewInstanceId: '6734768b73bfc87aeb00462c',
    enableHistory: true
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdr-cookie-'));
  const cookiePath = path.join(tmpDir, 'xdr_cookies.txt');
  fs.writeFileSync(cookiePath, 'sid=abc; x-csrf-token=token123', 'utf8');

  const normalized = normalizeCookieContent(fs.readFileSync(cookiePath, 'utf8'));
  assert.strictEqual(normalized.cookieString, 'sid=abc; x-csrf-token=token123');

  const jsonCookie = normalizeCookieContent(JSON.stringify([
    { name: 'sid', value: 'abc', domain: '.xdrsz.sangfor.com.cn' },
    { name: 'x-csrf-token', value: 'token123', domain: '.xdrsz.sangfor.com.cn' }
  ]));
  assert.strictEqual(jsonCookie.xdrBaseUrl, 'xdrsz.sangfor.com.cn');

  const cookieInfo = await readXdrCookieInfo(cookiePath);
  assert.strictEqual(cookieInfo.csrfToken, 'token123');

  assert.deepStrictEqual(normalizeAssetStatisticsResponse({
    data: {
      approve_asset: 61271,
      core_asset: 0,
      eliminate_asset: 0,
      manage_asset: 555
    },
    success: true
  }), {
    approve_asset: 61271,
    core_asset: 0,
    eliminate_asset: 0,
    manage_asset: 555
  });

  assert.deepStrictEqual(mapProtectionTypeLabels({
    demoted: 0,
    disabled: 0,
    offline: 274,
    online: 228,
    unprotected: 53
  }), [
    { name: '在线', value: 228 },
    { name: '离线', value: 274 },
    { name: '已禁用', value: 0 },
    { name: '已降级', value: 0 },
    { name: '未防护', value: 53 }
  ]);

  assert.deepStrictEqual(normalizeAssetProtectionResponse({
    data: {
      total: 555,
      type: {
        demoted: 0,
        disabled: 0,
        offline: 274,
        online: 228,
        unprotected: 53
      }
    },
    success: true
  }), {
    protectionDistribution: [
      { name: '在线', value: 228 },
      { name: '离线', value: 274 },
      { name: '已禁用', value: 0 },
      { name: '已降级', value: 0 },
      { name: '未防护', value: 53 }
    ]
  });

  assert.deepStrictEqual(mapExposureTypeLabels({
    other: 0,
    server: 0,
    terminal: 0
  }), [
    { name: '服务器', value: 0 },
    { name: '终端', value: 0 },
    { name: '其他', value: 0 }
  ]);

  assert.deepStrictEqual(normalizeAssetExposureResponse({
    data: {
      total: 0,
      type: {
        other: 0,
        server: 0,
        terminal: 0
      }
    },
    success: true
  }), {
    internetExposureDistribution: [
      { name: '服务器', value: 0 },
      { name: '终端', value: 0 },
      { name: '其他', value: 0 }
    ]
  });

  assert.deepStrictEqual(mapAssetTypeLabels({
    other: 0,
    server: 115,
    terminal: 440
  }), [
    { name: '服务器', value: 115 },
    { name: '终端', value: 440 },
    { name: '其他', value: 0 }
  ]);

  assert.deepStrictEqual(normalizeAssetTypeResponse({
    data: {
      total: 555,
      type: {
        other: 0,
        server: 115,
        terminal: 440
      }
    },
    success: true
  }), {
    typeDistribution: [
      { name: '服务器', value: 115 },
      { name: '终端', value: 440 },
      { name: '其他', value: 0 }
    ]
  });

  console.log('xdr_asset_client.test.js passed');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
