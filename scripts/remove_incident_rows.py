#!/usr/bin/env python3
"""
从事件 Excel 中移除误报事件的行。

两种模式（由第二个参数决定）：
  1. 按事件ID删除：第二个参数为 ID 数组 JSON，如 '["incident-xxx","incident-yyy"]'
  2. 按「处置状态」列删除（默认/推荐）：第二个参数为对象 JSON，如 '{"status_values":["已忽略"]}'
     直接读取事件表自带的「处置状态」列，值命中即删除；不依赖外部接口拉取的ID清单。

用法: python remove_incident_rows.py <incident.xlsx> '<payload_json>'
"""
import json
import sys

from openpyxl import load_workbook

from _path_helper import decode_argv
decode_argv()

# 「处置状态」列可能出现的表头名（子串匹配）
STATUS_ACTION_ALIASES = ["处置状态", "处理状态", "处置情况", "status_action", "statusaction"]
# 视为误报、需要删除的处置状态文字
DEFAULT_FALSE_POSITIVE_STATUS_VALUES = ["已忽略"]


def normalize(value):
    return "" if value is None else str(value).strip()


def find_column(sheet, aliases):
    """在表头中查找列名，支持多个别名"""
    header = [normalize(cell) for cell in next(sheet.iter_rows(min_row=1, max_row=1, values_only=True))]
    for index, name in enumerate(header):
        if not name:
            continue
        name_normalized = name.lower().replace(" ", "").replace("_", "").replace("-", "")
        for alias in aliases:
            if alias.lower().replace(" ", "").replace("_", "").replace("-", "") in name_normalized:
                return index
    return None


def parse_payload(raw):
    """解析第二个参数：数组 -> 按ID模式；对象 -> 按状态说明模式。

    返回 (mode, status_values, incident_id_set)
    """
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        raise SystemExit(f"无法解析删除参数 JSON: {e}")

    if isinstance(payload, dict):
        values = payload.get("status_values")
        if values is None:
            values = DEFAULT_FALSE_POSITIVE_STATUS_VALUES
        values = [normalize(v) for v in values if normalize(v)]
        return "status", values, set()

    if isinstance(payload, list):
        return "id", [], set(normalize(item) for item in payload if normalize(item))

    raise SystemExit(f"无法识别的删除参数类型: {type(payload).__name__}")


def remove_by_status_values(sheet, status_col, status_values):
    """按「状态说明」列的值删除行，返回 (rows_to_keep, removed_count, total_before, matched_details, status_counter)"""
    value_set = set(status_values)
    rows_to_keep = []
    removed_count = 0
    total_before = 0
    matched_details = []
    status_counter = {}

    for row_idx, row in enumerate(sheet.iter_rows(min_row=1, values_only=True)):
        if row_idx == 0:
            rows_to_keep.append(row)
            continue
        if not any(normalize(cell) for cell in row):
            continue
        total_before += 1
        status_value = normalize(row[status_col]) if status_col < len(row) else ""
        status_counter[status_value] = status_counter.get(status_value, 0) + 1
        if status_value in value_set:
            removed_count += 1
            matched_details.append({
                "row": row_idx + 1,
                "status_action": status_value,
            })
        else:
            rows_to_keep.append(row)

    return rows_to_keep, removed_count, total_before, matched_details, status_counter


def remove_by_ids(sheet, col_index, incident_id_set, status_note_col):
    """按事件ID列删除行，返回 (rows_to_keep, removed_count, total_before, excel_fp_ids)"""
    rows_to_keep = []
    removed_count = 0
    total_before = 0
    excel_fp_ids = []

    for row_idx, row in enumerate(sheet.iter_rows(min_row=1, values_only=True)):
        if row_idx == 0:
            rows_to_keep.append(row)
            continue
        if not any(normalize(cell) for cell in row):
            continue
        total_before += 1
        cell_value = normalize(row[col_index]) if col_index < len(row) else ""
        if cell_value in incident_id_set:
            removed_count += 1
        else:
            rows_to_keep.append(row)

        if status_note_col is not None and status_note_col < len(row):
            status_note_value = normalize(row[status_note_col])
            if status_note_value in ("1", "2"):
                excel_fp_ids.append({
                    "incident_id": cell_value,
                    "status_note": status_note_value,
                    "matched_by_pull": cell_value in incident_id_set
                })

    return rows_to_keep, removed_count, total_before, excel_fp_ids


def main():
    if len(sys.argv) < 3:
        raise SystemExit("Usage: remove_incident_rows.py <incident.xlsx> '<payload_json>'")

    excel_path = sys.argv[1]
    mode, status_values, incident_id_set = parse_payload(sys.argv[2])

    workbook = load_workbook(excel_path)
    sheet = workbook.active
    header_row = [normalize(cell) for cell in next(sheet.iter_rows(min_row=1, max_row=1, values_only=True))]

    if mode == "status":
        status_col = find_column(sheet, STATUS_ACTION_ALIASES)
        print(json.dumps({
            "diag": "status_column_detection",
            "mode": "status",
            "status_action_column_index": status_col,
            "status_action_column_header": header_row[status_col] if status_col is not None and status_col < len(header_row) else None,
            "target_status_values": status_values,
            "header": header_row
        }, ensure_ascii=False), file=sys.stderr)

        if status_col is None:
            raise SystemExit(f"无法找到「处置状态」列 (表头: {header_row})")

        rows_to_keep, removed_count, total_before, matched_details, status_counter = remove_by_status_values(
            sheet, status_col, status_values
        )
    else:
        # 兼容模式：按事件ID删除（保留，供旧调用/对照使用）
        col_index = find_column(sheet, ["事件id", "事件编号", "incident_id", "uuid", "uu id"])
        if col_index is None:
            for i, name in enumerate(header_row):
                normalized = name.lower().replace(" ", "").replace("_", "").replace("-", "")
                if "incident" in normalized or "event" in normalized:
                    col_index = i
                    break
        if col_index is None:
            raise SystemExit(f"无法找到事件ID列 (表头: {header_row})")

        status_note_col = find_column(sheet, STATUS_ACTION_ALIASES)
        print(json.dumps({
            "diag": "column_detection",
            "mode": "id",
            "id_column_index": col_index,
            "id_column_header": header_row[col_index] if col_index < len(header_row) else "",
            "status_action_column_index": status_note_col,
            "status_action_column_header": header_row[status_note_col] if status_note_col is not None and status_note_col < len(header_row) else None,
            "header": header_row
        }, ensure_ascii=False), file=sys.stderr)

        rows_to_keep, removed_count, total_before, excel_fp_ids = remove_by_ids(
            sheet, col_index, incident_id_set, status_note_col
        )
        pulled_id_set = set(incident_id_set)
        excel_fp_id_set = set(item["incident_id"] for item in excel_fp_ids if item["incident_id"])
        leaked_by_pull = sorted(excel_fp_id_set - pulled_id_set)
        leaked_details = [item for item in excel_fp_ids if item["incident_id"] in set(leaked_by_pull)]
        print(json.dumps({
            "diag": "post_remove_reverse_check",
            "excel_status_note_1_2_total": len(excel_fp_ids),
            "excel_status_note_1_2_unique_ids": len(excel_fp_id_set),
            "pulled_id_count": len(pulled_id_set),
            "removed_count": removed_count,
            "residual_false_positive_count": len(leaked_by_pull),
            "residual_details": leaked_details
        }, ensure_ascii=False), file=sys.stderr)

    if total_before == 0:
        print(json.dumps({"removed": 0, "total_before": 0, "total_after": 0, "message": "事件表为空，无需移除"}))
        return

    # 清除原工作表并写入保留的行
    sheet.delete_rows(1, sheet.max_row)
    for row_data in rows_to_keep:
        sheet.append(row_data)
    workbook.save(excel_path)

    if mode == "status":
        # 诊断：逐行命中的状态说明值，便于核对删除判据
        print(json.dumps({
            "diag": "post_remove_status_check",
            "target_status_values": status_values,
            "removed_count": removed_count,
            "total_before": total_before,
            "total_after": total_before - removed_count,
            "status_value_distribution": status_counter,
            "matched_details": matched_details
        }, ensure_ascii=False), file=sys.stderr)

    print(json.dumps({
        "removed": removed_count,
        "total_before": total_before,
        "total_after": total_before - removed_count,
        "message": f"已从事件表中移除 {removed_count} 条误报事件"
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()