'use strict';

const { execFile } = require('child_process');
const path = require('path');

async function summarizeIncidentStatus(excelPath) {
  if (!excelPath) {
    return null;
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'incident_status_stats.py');
  const stdout = await execPython(scriptPath, excelPath);
  const parsed = JSON.parse(stdout);

  return {
    totalEvents: Number(parsed.totalEvents || 0),
    severeEvents: Number(parsed.severeEvents || 0),
    highEvents: Number(parsed.highEvents || 0),
    closedEvents: Number(parsed.closedEvents || 0),
    processingEvents: Number(parsed.processingEvents || 0),
    closeRate: Number(parsed.closeRate || 0),
    uniqueAssetCount: Number(parsed.uniqueAssetCount || 0),
    averageContainMin: Number(parsed.averageContainMin || 0)
  };
}

function execPython(scriptPath, excelPath) {
  return new Promise((resolve, reject) => {
    execFile('python', [scriptPath, excelPath], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`事件表统计失败: ${stderr || error.message}`));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

module.exports = {
  summarizeIncidentStatus
};
