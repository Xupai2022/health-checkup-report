import json
import sys

from openpyxl import load_workbook


def normalize(value):
    return "" if value is None else str(value).strip()


def parse_number(value):
    text = normalize(value)
    if not text:
        return None

    try:
        return float(text)
    except ValueError:
        return None


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
    unique_ips = set()
    contain_total = 0.0
    contain_count = 0

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

        contain_min = parse_number(row[27] if len(row) >= 28 else None)
        if contain_min is not None:
            contain_total += contain_min
            contain_count += 1

        # Column G (index 6): host IP, format like "202.0.70.41(管理IP范围)"
        raw_ip = normalize(row[6] if len(row) >= 7 else None)
        if raw_ip:
            ip_only = raw_ip.split("(")[0].strip()
            if ip_only:
                unique_ips.add(ip_only)

    close_rate = round((closed / total) * 100) if total else 0
    average_contain_min = round(contain_total / contain_count) if contain_count else 0
    print(json.dumps({
        "totalEvents": total,
        "severeEvents": severe,
        "highEvents": high,
        "closedEvents": closed,
        "processingEvents": processing,
        "closeRate": close_rate,
        "uniqueAssetCount": len(unique_ips),
        "averageContainMin": average_contain_min
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
