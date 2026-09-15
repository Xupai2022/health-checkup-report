# Word 图表可编辑实现计划

## 1. 目标与边界

### 目标

交付一个与现有仓库、报告生成、Word 导出和 ZIP 打包流程独立的离线图表编辑器。用户不需要了解 HTML、ECharts、Canvas 或 DOCX 内部结构，只需：

1. 准备已有报告的 HTML 和 DOCX；
2. 打开图表编辑器；
3. 选择对应的 HTML 和原始 DOCX；
4. 修改图表数值和分类名称；
5. 点击“生成新版 Word”；
6. 下载替换了对应图表图片的新 DOCX。

新版 DOCX 继续使用 PNG 图表，不转为 Word 原生图表。这样保留当前 HTML 截图导出的视觉效果，同时让图表的业务数据可编辑。

### 不做的事

- 不把 PNG 反向转换为 Word 原生图表。
- 不要求用户安装 Python、Node、LibreOffice 或 Word。
- 不在用户电脑运行当前 Linux/Python 的 HTML 转 Word 脚本。
- 不修改 `health_report.js`、`template_renderer.js`、Python Word 导出器或现有 ZIP 打包逻辑。
- 不改变报告正文、表格、封面、页码和非图表图片。
- 不将 Logo、背景、封面等无业务数据的图片暴露为编辑项。

### 技术结论

浏览器不能静默读取或覆盖用户磁盘上的 DOCX。因此编辑器必须让用户选择 DOCX，并以下载方式交付新文件。这个步骤是浏览器安全模型限制，不是产品能力缺失。

## 2. 当前链路盘点

当前主流程为（仅作为编辑器的输入来源，不作改造）：

```text
MSSW/Excel 数据 -> reportData -> 渲染 HTML -> Playwright 截图 -> python-docx 写入 DOCX -> ZIP
```

- `src/template_renderer.js` 将 `reportData` 注入生成后的 HTML（`window.SECURITY_REPORT_DATA`）。
- `分支1/html_to_word/html_to_word_export.py` 根据截图选择器截取复杂组件，再把截图写进 DOCX。
- 截图对象不只有 ECharts：还可能是整张图表卡片、图表区、Canvas、iframe 和 SVG 组件。
- `health_report.js` 最终把 `安全体检报告` 目录压缩为 ZIP。

因此，可编辑能力的正确最小单位不是“某种技术图表”，而是“DOCX 中由 HTML 截图生成的一张业务图片组件”。编辑器通过独立的“导出适配配置”理解该输入约定，不写入或调用现有生成流程。

## 3. 总体设计

### 3.1 交付目录

```text
Word图表编辑器/
  index.html
  assets/
    echarts.min.js
    jszip.min.js
    html2canvas.min.js
    editor.css
    editor.js
  profiles/
    health-checkup-report-v1.json
  README.txt
```

编辑器可作为单独 ZIP 或独立文件夹交付。所有浏览器依赖必须放在其中并使用相对路径，不访问 CDN，不向外发送数据。现有报告 ZIP 不需要改变；用户只需从已有输出中选择对应 HTML 和 DOCX。

### 3.2 三份核心文件

运行时数据模型

- 编辑器从用户选择的生成 HTML 中读取 `window.SECURITY_REPORT_DATA`、图表 DOM 和 ECharts 实例，再在浏览器内创建可编辑副本。
- 只包含图表需要的类目、数值、系列、单位、合计规则和字段标签。
- 不保存 Cookie、接口地址、原始事件明细或不必要的客户敏感数据。

导出适配配置（`profiles/health-checkup-report-v1.json`）

- 记录截图选择器、截图顺序、组件 ID 提取规则、标题处理、截图尺寸、DOCX 媒体定位规则和字段适配规则。
- 适配配置由独立工具维护，当前仓库无需知道它的存在。

生成 HTML

- 用户选择的已有报告 HTML 本身就是组件 DOM、CSS、ECharts 版本和渲染脚本的来源。
- 编辑器在隔离 iframe 中加载它，避免复制模板或修改模板。

### 3.3 组件而不是单图表

一个 DOCX 图片可能对应：

- 单个饼图或柱状图；
- 包含标题和图例的一张图表卡片；
- 两个并排图表的整块区域；
- 图表与注释共同组成的业务模块。

Manifest 必须以导出图片组件为单位。若一张 DOCX 图片包含三张 ECharts 图，编辑任意一张后必须重绘该整张组件图片，再替换其唯一的 DOCX 媒体文件。

## 4. 数据与映射契约

### 4.1 Manifest 示例

```json
{
  "schemaVersion": 1,
  "sourceDocx": "【客户】安全体检报告-xxx.docx",
  "components": [
    {
      "componentId": "slot-event-charts",
      "title": "安全事件分布",
      "docxMediaPath": "word/media/image17.png",
      "sourceElementId": "slot-event-charts",
      "renderer": "html-component",
      "viewport": { "width": 1380, "height": 720, "scale": 2 },
      "dataKey": "eventDistribution",
      "editable": true,
      "validation": { "nonNegative": true }
    }
  ]
}
```

### 4.2 数据示例

```json
{
  "schemaVersion": 1,
  "charts": {
    "eventDistribution": {
      "fields": ["严重", "高危", "中危", "低危"],
      "series": [
        { "name": "安全事件", "values": [2, 8, 18, 9] }
      ],
      "unit": "起"
    }
  }
}
```

### 4.3 必须保存的元数据

每个组件至少保存：

- `componentId`：稳定且跨导出顺序不变的 ID。
- `docxMediaPath`：DOCX ZIP 中确切的 `word/media/imageN.png`。
- `sourceElementId`：HTML 中用于重建整张组件的元素 ID。
- `chartIds`：组件包含的 ECharts DOM ID。
- `dataKey`：对应 `chart-data.json` 的键。
- `viewport`、`scale`、输出 PNG 格式：保证替换后尺寸不漂移。
- 标题是否包含在截图中、组件是否为并排/合并截图。
- 输入校验规则和版本号。

## 5. ZIP 附件集成（唯一的现有流程接点）

编辑器本身保持独立，不参与现有数据统计、HTML 渲染或 Python Word 导出。唯一接点放在 `health_report.js` 的 ZIP 打包前：把本次已生成的 DOCX、HTML 副本和独立编辑器目录放进同一报告目录，再沿用现有 ZIP 打包逻辑交付。

```text
既有流程：数据 -> HTML -> DOCX
新增尾部步骤：DOCX + HTML + 图表编辑器 + 本次数据附件 -> 现有 ZIP
```

用户从 ZIP 中得到的输入应为：原始 DOCX、对应的本次报告 HTML、图表编辑器和本次图表数据附件。编辑器只读取这些文件并在浏览器内生成新的 DOCX；它不会反向调用或改写已有生成流程。

`health_report.js` 的改动仅负责复制附件到 `安全体检报告/图表编辑器` 并打包，不承载编辑器逻辑。适配规则、DOCX 媒体定位与重绘逻辑全部保留在独立编辑器模块中。

### 5.1 独立适配配置

### 5.2 稳定 ID

独立适配配置不能只使用按循环次数形成的 `comp-N`。优先取组件已有的 HTML `id`；没有 ID 时，由适配配置根据现有选择器、章节位置和图表标题生成稳定的逻辑 ID，不修改模板。

命名规则建议：

```text
slot-事件分布
card-资产类型分布
component-互联网暴露面-top5
```

ID 必须在模板版本内稳定，不能依赖图表渲染顺序。

### 5.3 截图与 DOCX 媒体的精确关联

独立的附件准备器读取已生成 DOCX，解析其中的 drawing relationship 与 `word/media` 图片；再依据适配配置及 HTML 重绘结果建立 `componentId -> word/media/imageN.png` 映射。

禁止在编辑器侧通过“第 17 张图片”猜测映射，因为 DOCX 还包含封面、页眉、Logo 与其他图片，且顺序可随模板变化。

附件准备器写出本次 `chart-manifest.json`，ZIP 打包前将其与编辑器一起放入报告目录。

### 5.4 本次数据附件

在 HTML 渲染完成、截图开始前：

1. 从受控的 `reportData` 中提取各组件需要的数据；
2. 为每个组件建立明确的字段映射；
3. 写出最小化的 `chart-data.json`；
4. 为编辑器输出字段标签、单位、取值范围和合计校验。

不要让编辑器任意编辑完整 `reportData`。图表数据的字段定义应集中放在新的 `src/chart_edit_manifest.js`，避免散落在模板正则或浏览器脚本里。

### 5.5 保存可复现组件

需要将图表卡片的 HTML/CSS 与渲染函数以本地资源形式交付给编辑器。优先复用现有模板中的 ECharts 版本与主题，避免编辑器使用不同版本导致字体、间距、颜色或图例换行变化。

对于 iframe、Canvas、SVG 等非 ECharts 组件，也必须定义数据输入和浏览器端渲染函数；没有可复现数据和渲染逻辑的组件标记为 `editable: false`，保留原图片。

## 6. 离线编辑器设计

### 6.1 使用流程

1. 打开 `图表编辑器/index.html`。
2. 编辑器读取同目录 `chart-manifest.json` 与 `chart-data.json`。
3. 左侧显示所有可编辑业务图，右侧显示字段表单和实时预览。
4. 用户修改数值、分类名称或系列名称。
5. 前端立即执行校验并重绘预览。
6. 用户选择 ZIP 内的原始 DOCX。
7. 点击“生成新版 Word”。
8. 编辑器替换所有被修改组件的 PNG，下载新的 DOCX。

### 6.2 编辑控件

- 数值：数字输入框，限制非负数、最大值、小数位。
- 类目/系列名：文本输入框，限制长度，防止标题溢出。
- 多系列：表格编辑器，固定列宽、可新增/删除行。
- 饼图：实时显示合计和百分比检查。
- 指标关联：提示相关数值，但第一期不自动改正文 KPI。

不要让用户编辑 ECharts option、HTML、JavaScript 或 DOCX XML。

### 6.3 浏览器端重绘

1. 根据组件配置创建固定尺寸的隐藏渲染容器。
2. 载入组件的 DOM/CSS 和本地 ECharts。
3. 使用编辑后的 `chart-data.json` 重新调用受控渲染函数。
4. 等待字体、Canvas、动画和 ResizeObserver 稳定。
5. 使用本地 `html2canvas` 输出与原截图规格一致的 PNG。
6. 对每个变更组件获得 `{ docxMediaPath, pngBlob }`。

截图应统一使用固定 viewport、DPR/scale 和背景色，不能用用户当前浏览器窗口尺寸决定图片尺寸。

### 6.4 DOCX 替换

1. 使用本地 JSZip 读取用户选择的 DOCX。
2. 校验 DOCX 中是否包含 Manifest 指定的媒体路径。
3. 用重绘 PNG 替换 `word/media/*.png` 的文件内容。
4. 不修改 `document.xml`、relationship、样式、页码和表格。
5. 生成 Blob，下载为 `原文件名-图表已更新.docx`。

图片显示尺寸来自 DOCX 内部已有的 drawing 尺寸，因此只替换二进制 PNG 通常不会导致 Word 布局变化。编辑器仍须输出相同长宽比，防止图像在 Word 中拉伸失真。

## 7. 依赖与离线要求

编辑器交付本地副本：

- ECharts：必须与报告模板当前版本一致。
- JSZip：读写 DOCX（本质是 ZIP）。
- html2canvas：将完整 HTML 组件截图为 PNG。

不得引用 CDN，不得发起接口请求，不得依赖本地 Python/Node。浏览器页面只访问用户显式选择的 DOCX 和同目录随包资源。

## 8. 安全与隐私

- 编辑器不上传文件或数据。
- `chart-data.json` 只保留图表最小必要数据，避免包含原始事件详情、Cookie、请求地址和身份凭据。
- 所有 JSON 解析做 schema 校验；字段名和图片路径必须来自受信任 Manifest，不接受用户输入路径。
- 编辑内容输出为 DOCX 下载，不覆盖原始文件。
- Manifest 带 `schemaVersion`、模板版本、DOCX 文件名和可选 SHA-256，防止用户选错报告。

## 9. 实施分期

### 第一阶段：映射基础

- 列出当前 Word 导出中所有截图组件。
- 给每个组件分配稳定 ID。
- 在 DOCX 写图时记录 `componentId -> docxMediaPath`。
- 把 Manifest 与一份只读数据样例放入 ZIP。
- 验证每个 Manifest 路径都能在 DOCX 内找到。

交付物：可审计的组件清单和正确的 `chart-manifest.json`。

### 第二阶段：ECharts 试点

- 选择 3 个代表性组件：单图、饼图、多图合并组件。
- 输出对应 `chart-data.json` 与字段校验。
- 实现离线编辑、预览、PNG 生成和 DOCX 替换。
- 用 Word/WPS 打开生成结果做人工对比。

交付物：用户可离线修改试点图并下载新版 DOCX。

### 第三阶段：全量业务图覆盖

- 将所有当前截图组件按“可编辑 / 保留原图”分类。
- 为非 ECharts 的 Canvas、iframe、SVG 组件补充浏览器端渲染器。
- 将可编辑组件全部接入同一编辑器。
- 在编辑器中按报告章节分组显示。

交付物：所有有业务数据的截图组件可编辑并可替换。

### 第四阶段：质量与可维护性

- 引入 Manifest schema 校验和版本兼容策略。
- 增加自动化回归：未编辑时，原截图与编辑器重绘图做尺寸及像素容差比对。
- 增加 DOCX 包完整性校验和媒体路径校验。
- 编写用户说明与故障提示。

## 10. 验收标准

### 功能

- ZIP 中包含 DOCX、编辑器、Manifest、数据文件和全部本地依赖。
- 用户无需编程知识即可修改数值并实时查看图表。
- 用户选择原始 DOCX 后，可下载新版 DOCX。
- 修改一个组件时，只替换 Manifest 指定的 DOCX 图片。
- 未修改的图片、正文、表格、封面、页眉、页码均保持不变。

### 视觉

- 未编辑数据时，编辑器重绘图与原导出图在尺寸、字体、配色、标题、图例和布局上保持一致。
- 生成的 DOCX 可由 Microsoft Word 与 WPS 正常打开。
- Word 中图片位置、显示尺寸和分页不发生异常变化。

### 安全

- 编辑器离线工作，无网络请求。
- 不交付 Cookie、接口密钥或完整原始业务数据。
- 不能通过编辑器提交任意 HTML、JavaScript、文件路径或 ZIP 内部路径。

## 11. 风险与决策

| 风险 | 处理方式 |
| --- | --- |
| 截图顺序变化导致替错图 | 在 Word 写图时记录确切 `word/media` 路径，禁止按顺序匹配。 |
| 一张截图包含多个子图 | 以截图组件为重绘和替换单位。 |
| 编辑器图与原图视觉不一致 | 固定 ECharts 版本、DOM、CSS、viewport 和截图参数。 |
| iframe/Canvas 图没有浏览器端渲染逻辑 | 第一阶段标为不可编辑，随后为其编写适配器。 |
| 用户选错 DOCX | 校验 Manifest 版本、文件名和可选内容哈希。 |
| 用户期望静默覆盖原文件 | 明确浏览器仅能下载新文件，保留原件可回退。 |

## 12. 推荐的首个里程碑

先不要一次性改造全部图。先完成“3 张代表图 -> 编辑器重绘 -> JSZip 替换 DOCX 图片 -> Word/WPS 验证”的完整闭环。

该里程碑通过后，组件映射、截图复现和 DOCX 替换三项关键风险均已验证；后续新增图表主要是补充数据字段与渲染适配器，而不是重做架构。
