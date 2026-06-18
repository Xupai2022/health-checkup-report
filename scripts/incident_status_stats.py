import json
import sys

from openpyxl import load_workbook


def normalize(value):
    return "" if value is None else str(value).strip()


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: incident_status_stats.py <incident.xlsx>")

    workbook = load_workbook(sys.argv[1], read_only=True, data_only=True)
    sheet = workbook.active

    total = 0
    severe = 0
    high = 0
    closed = 0
    processing = 0

    for row in sheet.iter_rows(min_row=2, values_only=True):
        if not any(normalize(cell) for cell in row):
            continue

        total += 1
        level = normalize(row[2] if len(row) >= 3 else None)
        if level == "严重":
            severe += 1
        elif level == "高危":
            high += 1

        status = normalize(row[18] if len(row) >= 19 else None)
        if status == "已闭环":
            closed += 1
        elif status == "处置中":
            processing += 1

    close_rate = round((closed / total) * 100) if total else 0
    print(json.dumps({
        "totalEvents": total,
        "severeEvents": severe,
        "highEvents": high,
        "closedEvents": closed,
        "processingEvents": processing,
        "closeRate": close_rate
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
