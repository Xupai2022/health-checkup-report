'use strict';

const { execFile } = require('child_process');
const path = require('path');
const { encodePath } = require('./path_helper');

async function summarizeIncidentStatus(excelPath) {
  if (!excelPath) {
    return null;
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'incident_status_stats.py');
  const stdout = await execPython(scriptPath, encodePath(excelPath));
  const parsed = JSON.parse(stdout);

  return {
    totalEvents: Number(parsed.totalEvents || 0),
    severeEvents: Number(parsed.severeEvents || 0),
    highEvents: Number(parsed.highEvents || 0),
    closedEvents: Number(parsed.closedEvents || 0),
    processingEvents: Number(parsed.processingEvents || 0),
    closeRate: Number(parsed.closeRate || 0),
    uniqueAssetCount: Number(parsed.uniqueAssetCount || 0)
  };
}

function execPythonWithArgs(scriptPath, args, label) {
  return new Promise((resolve, reject) => {
    execFile('python', [scriptPath, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${label}: ${stderr || error.message}`));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

function execPython(scriptPath, excelPath) {
  return execPythonWithArgs(scriptPath, [excelPath], '事件表统计失败');
}

async function removeIncidentRows(excelPath, incidentIds) {
  if (!excelPath || !Array.isArray(incidentIds) || !incidentIds.length) {
    return { removed: 0, message: '没有需要移除的行' };
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'remove_incident_rows.py');
  const idsJson = JSON.stringify(incidentIds);
  // 在 Windows 上传递长 JSON 参数时需要用双引号包裹
  const stdout = await execPythonWithArgs(scriptPath, [encodePath(excelPath), idsJson], '移除误报事件失败');
  const parsed = JSON.parse(stdout);

  return {
    removed: Number(parsed.removed || 0),
    totalBefore: Number(parsed.total_before || 0),
    totalAfter: Number(parsed.total_after || 0),
    message: parsed.message || ''
  };
}

// 与 removeIncidentRows 相同调用，但额外回传 Python 诊断输出（stderr）,
// 用于误报过滤的证据链定位。不影响主流程。
function execPythonWithDiagnostics(scriptPath, args, label) {
  return new Promise((resolve, reject) => {
    execFile('python', [scriptPath, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${label}: ${stderr || error.message}`));
        return;
      }
      resolve({ stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

// 按事件表自带的「状态说明」列删除误报行，不依赖外部接口拉取的 ID 清单。
// statusValues 未传时，Python 侧使用默认值：业务触发 / 技术误报 / 接受风险。
async function removeIncidentRowsByStatus(excelPath, statusValues) {
  if (!excelPath) {
    return { removed: 0, totalBefore: 0, totalAfter: 0, message: '事件表路径为空', diagnostics: [] };
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'remove_incident_rows.py');
  const payload = { status_values: Array.isArray(statusValues) && statusValues.length
    ? statusValues
    : ['业务触发', '技术误报', '接受风险'] };
  const { stdout, stderr } = await execPythonWithDiagnostics(scriptPath, [encodePath(excelPath), JSON.stringify(payload)], '按状态说明移除误报事件失败');
  const parsed = JSON.parse(stdout);
  const diagnostics = stderr
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return { raw: line };
      }
    });

  return {
    removed: Number(parsed.removed || 0),
    totalBefore: Number(parsed.total_before || 0),
    totalAfter: Number(parsed.total_after || 0),
    message: parsed.message || '',
    diagnostics
  };
}

async function parseIncidentGptStats(excelPath) {
  if (!excelPath) {
    return null;
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'incident_gpt_stats.py');
  const stdout = await execPythonWithArgs(scriptPath, [encodePath(excelPath)], '事件表 GPT 研判结论读取失败');
  const parsed = JSON.parse(stdout);

  return {
    hostCompromiseIds: Array.isArray(parsed.hostCompromiseIds) ? parsed.hostCompromiseIds : [],
    virusTrojanIds: Array.isArray(parsed.virusTrojanIds) ? parsed.virusTrojanIds : [],
    gptSubResultMap: parsed.gptSubResultMap && typeof parsed.gptSubResultMap === 'object' ? parsed.gptSubResultMap : {}
  };
}

async function extractIncidentDirectStats(excelPath) {
  if (!excelPath) {
    return {
      hostCompromiseIds: [],
      virusTrojanIds: [],
      exploitIds: []
    };
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'extract_incident_direct_stats.py');
  const stdout = await execPythonWithArgs(scriptPath, [encodePath(excelPath)], '事件表直接分类统计失败');
  const parsed = JSON.parse(stdout);

  return {
    hostCompromiseIds: Array.isArray(parsed.hostCompromiseIds) ? parsed.hostCompromiseIds : [],
    virusTrojanIds: Array.isArray(parsed.virusTrojanIds) ? parsed.virusTrojanIds : [],
    exploitIds: Array.isArray(parsed.exploitIds) ? parsed.exploitIds : []
  };
}

async function annotateIncidentGptConclusion(excelPath, outputDir) {
  if (!excelPath || !outputDir) {
    return {
      filePath: excelPath || '',
      classified: { C2外联: 0, 病毒木马: 0 }
    };
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'annotate_incident_gpt_conclusion.py');
  const stdout = await execPythonWithArgs(
    scriptPath,
    [encodePath(excelPath), encodePath(outputDir)],
    '追加事件 GPT 研判分类失败'
  );
  const parsed = JSON.parse(stdout);
  return {
    filePath: parsed.filePath || excelPath,
    classified: parsed.classified && typeof parsed.classified === 'object'
      ? parsed.classified
      : { C2外联: 0, 病毒木马: 0 }
  };
}

async function extractIncidentAssetInfo(incidentExcelPath, assetExcelPath, confirmedIds, virusIds) {
  if (!incidentExcelPath || !Array.isArray(confirmedIds) || !Array.isArray(virusIds)) {
    return {
      virusAttackAsset: '',
      nonAesCoveredAssets: [],
      unlabeledAssets: []
    };
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'extract_incident_asset_info.py');
  const args = [
    encodePath(incidentExcelPath),
    encodePath(assetExcelPath || ''),
    JSON.stringify(confirmedIds),
    JSON.stringify(virusIds)
  ];
  const stdout = await execPythonWithArgs(scriptPath, args, '提取事件资产信息失败');
  return JSON.parse(stdout);
}

async function summarizeTopRiskAssetDetails(options = {}) {
  const topAssets = Array.isArray(options.topAssets) ? options.topAssets : [];
  if (!Array.isArray(topAssets) || !topAssets.length) {
    return {
      assets: {}
    };
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'top_risk_asset_details.py');
  const args = [
    encodePath(options.incidentExcelPath || ''),
    encodePath(options.weakPasswordExcelPath || ''),
    encodePath(options.vulnerabilityExcelPath || ''),
    encodePath(options.exposureExcelPath || ''),
    JSON.stringify(topAssets),
    JSON.stringify(Array.isArray(options.c2Ids) ? options.c2Ids : []),
    JSON.stringify(Array.isArray(options.virusIds) ? options.virusIds : []),
    JSON.stringify(Array.isArray(options.exploitIds) ? options.exploitIds : [])
  ];
  const stdout = await execPythonWithArgs(scriptPath, args, '统计风险资产详情失败');
  const parsed = JSON.parse(stdout);

  return {
    assets: parsed && parsed.assets && typeof parsed.assets === 'object' ? parsed.assets : {}
  };
}

async function extractC2ConnectionExamples(incidentExcelPath, confirmedIds) {
  if (!incidentExcelPath || !Array.isArray(confirmedIds) || !confirmedIds.length) {
    return {
      c2Connections: []
    };
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'extract_c2_connection_examples.py');
  const stdout = await execPythonWithArgs(
    scriptPath,
    [encodePath(incidentExcelPath), JSON.stringify(confirmedIds)],
    '提取 C2 外联事件举例失败'
  );
  return JSON.parse(stdout);
}

async function extractVirusTrojanExamples(incidentExcelPath, confirmedIds) {
  if (!incidentExcelPath || !Array.isArray(confirmedIds) || !confirmedIds.length) {
    return {
      viruses: []
    };
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'extract_virus_trojan_examples.py');
  const stdout = await execPythonWithArgs(
    scriptPath,
    [encodePath(incidentExcelPath), JSON.stringify(confirmedIds)],
    '提取病毒木马事件举例失败'
  );
  return JSON.parse(stdout);
}

async function extractVulnExploitExamples(incidentExcelPath, incidentIds) {
  if (!incidentExcelPath || !Array.isArray(incidentIds) || !incidentIds.length) {
    return {
      vulnExploits: []
    };
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'extract_vuln_exploit_examples.py');
  const stdout = await execPythonWithArgs(
    scriptPath,
    [encodePath(incidentExcelPath), JSON.stringify(incidentIds)],
    '提取漏洞利用事件举例失败'
  );
  return JSON.parse(stdout);
}

async function summarizeIncidentResponseStats(assetExcelPath, incidentExcelPath) {
  if (!assetExcelPath || !incidentExcelPath) {
    return {
      AvgResponseTime: 0,
      topEventType: '',
      top3BusinessSystems: '',
      businessSystemEventDistribution: []
    };
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'incident_response_stats.py');
  const stdout = await execPythonWithArgs(scriptPath, [encodePath(assetExcelPath), encodePath(incidentExcelPath)], '全量事件响应统计失败');
  const parsed = JSON.parse(stdout);

  return {
    AvgResponseTime: Number(parsed.AvgResponseTime || 0),
    topEventType: String(parsed.topEventType || ''),
    top3BusinessSystems: String(parsed.top3BusinessSystems || ''),
    businessSystemEventDistribution: Array.isArray(parsed.businessSystemEventDistribution) ? parsed.businessSystemEventDistribution : []
  };
}

async function extractExploitStats(incidentExcelPath) {
  if (!incidentExcelPath) {
    return {
      total: 0,
      highRiskAsset: '',
      closedCount: 0,
      processingCount: 0,
      incidentIds: []
    };
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'extract_exploit_stats.py');
  const stdout = await execPythonWithArgs(scriptPath, [encodePath(incidentExcelPath)], '提取漏洞利用统计失败');
  const parsed = JSON.parse(stdout);

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  return {
    total: Number(parsed.total || 0),
    highRiskAsset: String(parsed.highRiskAsset || ''),
    closedCount: Number(parsed.closedCount || 0),
    processingCount: Number(parsed.processingCount || 0),
    incidentIds: Array.isArray(parsed.incidentIds) ? parsed.incidentIds : []
  };
}

async function extractIncidentTypeStats(incidentExcelPath) {
  if (!incidentExcelPath) {
    return {
      topEventType: '',
      eventTypeDistribution: []
    };
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'incident_type_stats.py');
  const stdout = await execPythonWithArgs(scriptPath, [encodePath(incidentExcelPath)], '提取事件类型分布失败');
  const parsed = JSON.parse(stdout);

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  return {
    topEventType: String(parsed.topEventType || ''),
    eventTypeDistribution: Array.isArray(parsed.eventTypeDistribution) ? parsed.eventTypeDistribution : []
  };
}

async function extractCaseStudyCandidates(incidentExcelPath, options = {}) {
  if (!incidentExcelPath) {
    return {
      candidateCount: 0,
      matchedCandidates: []
    };
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'extract_case_study_candidates.py');
  const stdout = await execPythonWithArgs(
    scriptPath,
    [
      encodePath(incidentExcelPath),
      JSON.stringify(Array.isArray(options.c2Ids) ? options.c2Ids : []),
      JSON.stringify(Array.isArray(options.virusIds) ? options.virusIds : []),
      JSON.stringify(Array.isArray(options.exploitIds) ? options.exploitIds : [])
    ],
    '提取典型案例候选事件失败'
  );
  const parsed = JSON.parse(stdout);

  return {
    candidateCount: Number(parsed.candidateCount || 0),
    matchedCandidates: Array.isArray(parsed.matchedCandidates) ? parsed.matchedCandidates : []
  };
}

module.exports = {
  summarizeIncidentStatus,
  removeIncidentRows,
  removeIncidentRowsByStatus,
  parseIncidentGptStats,
  extractIncidentDirectStats,
  annotateIncidentGptConclusion,
  extractIncidentAssetInfo,
  summarizeTopRiskAssetDetails,
  extractC2ConnectionExamples,
  extractVirusTrojanExamples,
  extractVulnExploitExamples,
  summarizeIncidentResponseStats,
  extractExploitStats,
  extractIncidentTypeStats,
  extractCaseStudyCandidates
};
