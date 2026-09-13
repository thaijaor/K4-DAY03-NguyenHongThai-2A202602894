"""
🛠️ TOOL DEFINITIONS & EXECUTION BACKEND
Mã nguồn chứa danh sách Tool Schemas (JSON Schema) và Execution Layer phục vụ cho MCP Server.
Đề tài: Trợ lý Đặt sân Cầu lông SmashHub.
"""

import json
import re
from datetime import datetime
from typing import Dict, Any, List

# ==============================================================================
# 1. KHAI BÁO TOOL SCHEMAS CHUẨN NATIVE JSON SCHEMA (TASK 1.2)
# ==============================================================================

COURT_IDS = ["S1", "S2", "S3", "S4"]
OPEN_HOUR, CLOSE_HOUR = 6, 22  # Khung giờ đặt sân: 06:00 - 22:00, mỗi lượt 1 giờ

TOOLS_SCHEMA = [
    # Tool 1: Tra cứu (read-only)
    {
        "name": "court_availability",
        "description": (
            "Tra cứu các sân cầu lông còn trống theo ngày và khung giờ tại SmashHub. "
            "Luôn gọi tool này trước khi đặt sân nếu người dùng chưa chỉ định rõ sân và giờ. "
            "Nếu khung giờ đã kín, kết quả có status FULLY_BOOKED kèm các khung giờ trống gần nhất."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "date": {
                    "type": "string",
                    "description": "Ngày cần tra cứu, định dạng DD/MM/YYYY (ví dụ: '18/09/2026')"
                },
                "time_range": {
                    "type": "string",
                    "description": (
                        "Khung giờ cần tra cứu, định dạng HH:MM-HH:MM, giờ kết thúc không tính "
                        "(ví dụ: '19:00-21:00' là các lượt bắt đầu lúc 19:00 và 20:00). "
                        "Bỏ trống để tra cả ngày (06:00-22:00)."
                    )
                }
            },
            "required": ["date"]
        }
    },

    # Tool 2: Hành động (ghi dữ liệu)
    {
        "name": "book_court",
        "description": (
            "Đặt một sân cầu lông trong 1 giờ tại SmashHub. Chỉ gọi khi đã biết mã sân, giờ bắt đầu "
            "và số điện thoại khách. Trả về mã booking và giá tiền, hoặc SLOT_UNAVAILABLE nếu sân đã có người đặt."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "court_id": {
                    "type": "string",
                    "enum": COURT_IDS,
                    "description": "Mã sân cần đặt (S1, S2, S3 hoặc S4)"
                },
                "datetime_str": {
                    "type": "string",
                    "description": "Giờ bắt đầu chơi, định dạng 'HH:00 DD/MM/YYYY' (ví dụ: '20:00 18/09/2026')"
                },
                "customer_phone": {
                    "type": "string",
                    "description": "Số điện thoại khách đặt sân, 10 chữ số bắt đầu bằng 0 (ví dụ: '0912345678')"
                }
            },
            "required": ["court_id", "datetime_str", "customer_phone"]
        }
    }
]

# ==============================================================================
# 2. MÔ PHỎNG DỮ LIỆU & HÀM THỰC THI TOOL (EXECUTION LAYER)
# ==============================================================================

# Lịch đã đặt: {ngày: {giờ bắt đầu: [các sân đã kín]}}. Ngày không có trong bảng = còn trống toàn bộ.
BOOKINGS: Dict[str, Dict[int, List[str]]] = {
    "18/09/2026": {                      # Thứ Sáu
        19: ["S1", "S2", "S3", "S4"],
        20: ["S1", "S3"],
        21: ["S1"],
    },
    "19/09/2026": {                      # Thứ Bảy
        16: ["S1", "S2", "S4"],
        17: ["S1", "S2", "S3", "S4"],
        18: ["S1", "S2", "S3", "S4"],
        19: ["S1", "S2", "S3", "S4"],
        20: ["S3", "S4"],
    },
}

_booking_seq = 100


def _parse_date(date: str) -> datetime:
    return datetime.strptime(date.strip(), "%d/%m/%Y")


def _parse_hour(hhmm: str) -> int:
    match = re.fullmatch(r"(\d{1,2}):00", hhmm.strip())
    if not match:
        raise ValueError(f"Giờ '{hhmm}' không hợp lệ, sân chỉ nhận lượt tròn giờ dạng HH:00")
    return int(match.group(1))


def _price_per_hour(day: datetime, hour: int) -> int:
    if day.weekday() >= 5 or hour >= 17:  # Cuối tuần hoặc giờ cao điểm tối
        return 120_000
    return 80_000


def _free_courts(date: str, hour: int) -> List[str]:
    booked = BOOKINGS.get(date, {}).get(hour, [])
    return [c for c in COURT_IDS if c not in booked]


def _error(status: str, message: str) -> str:
    return json.dumps({"status": status, "message": message}, ensure_ascii=False)


def execute_court_availability(date: str, time_range: str = "06:00-22:00") -> str:
    """Tra cứu sân trống theo ngày và khung giờ"""
    try:
        day = _parse_date(date)
        start_str, end_str = time_range.replace(" ", "").split("-")
        start, end = _parse_hour(start_str), _parse_hour(end_str)
    except ValueError as e:
        return _error("INVALID_ARGUMENT", f"Tham số không hợp lệ ({e}). Ngày dạng DD/MM/YYYY, khung giờ dạng HH:00-HH:00.")

    date = day.strftime("%d/%m/%Y")
    start, end = max(start, OPEN_HOUR), min(end, CLOSE_HOUR)
    if start >= end:
        return _error("CLOSED", f"Khung giờ {time_range} nằm ngoài giờ hoạt động 06:00-22:00.")

    slots = [
        {"time": f"{h:02d}:00", "free_courts": _free_courts(date, h), "price_per_hour": _price_per_hour(day, h)}
        for h in range(start, end)
    ]
    available = [s for s in slots if s["free_courts"]]

    if available:
        return json.dumps({
            "status": "SUCCESS",
            "date": date,
            "time_range": f"{start:02d}:00-{end:02d}:00",
            "available_slots": available
        }, ensure_ascii=False)

    # Kín toàn bộ khung giờ → gợi ý tối đa 3 lượt trống gần nhất trong cùng ngày
    requested_mid = (start + end) / 2
    alternatives = sorted(
        (h for h in range(OPEN_HOUR, CLOSE_HOUR) if not start <= h < end and _free_courts(date, h)),
        key=lambda h: abs(h - requested_mid)
    )[:3]
    return json.dumps({
        "status": "FULLY_BOOKED",
        "date": date,
        "time_range": f"{start:02d}:00-{end:02d}:00",
        "message": f"Tất cả các sân đã kín trong khung {start:02d}:00-{end:02d}:00 ngày {date}.",
        "nearest_available_slots": [
            {"time": f"{h:02d}:00", "free_courts": _free_courts(date, h), "price_per_hour": _price_per_hour(day, h)}
            for h in sorted(alternatives)
        ]
    }, ensure_ascii=False)


def execute_book_court(court_id: str, datetime_str: str, customer_phone: str) -> str:
    """Đặt 1 sân trong 1 giờ"""
    global _booking_seq

    court_id = court_id.strip().upper()
    if court_id not in COURT_IDS:
        return _error("INVALID_ARGUMENT", f"Sân '{court_id}' không tồn tại. Các sân hợp lệ: {', '.join(COURT_IDS)}.")
    if not re.fullmatch(r"0\d{9}", customer_phone.strip()):
        return _error("INVALID_ARGUMENT", f"Số điện thoại '{customer_phone}' không hợp lệ (cần 10 chữ số, bắt đầu bằng 0).")
    try:
        time_str, date_str = datetime_str.strip().split(maxsplit=1)
        hour, day = _parse_hour(time_str), _parse_date(date_str)
    except ValueError as e:
        return _error("INVALID_ARGUMENT", f"Thời gian '{datetime_str}' không hợp lệ ({e}). Định dạng đúng: 'HH:00 DD/MM/YYYY'.")

    date = day.strftime("%d/%m/%Y")
    if not OPEN_HOUR <= hour < CLOSE_HOUR:
        return _error("CLOSED", f"Lượt {hour:02d}:00 nằm ngoài giờ hoạt động 06:00-22:00.")
    if court_id not in _free_courts(date, hour):
        return json.dumps({
            "status": "SLOT_UNAVAILABLE",
            "message": f"Sân {court_id} lúc {hour:02d}:00 ngày {date} đã có người đặt.",
            "free_courts_same_time": _free_courts(date, hour)
        }, ensure_ascii=False)

    BOOKINGS.setdefault(date, {}).setdefault(hour, []).append(court_id)
    _booking_seq += 1
    price = _price_per_hour(day, hour)
    return json.dumps({
        "status": "SUCCESS",
        "booking_id": f"BK-{day.strftime('%d%m')}-{court_id}-{_booking_seq}",
        "court_id": court_id,
        "datetime": f"{hour:02d}:00-{hour + 1:02d}:00 {date}",
        "customer_phone": customer_phone.strip(),
        "price": price,
        "message": f"Đặt thành công sân {court_id} lúc {hour:02d}:00-{hour + 1:02d}:00 ngày {date}, giá {price:,}đ.".replace(f"{price:,}", f"{price:,}".replace(",", "."))
    }, ensure_ascii=False)


# Router gọi tool thực tế
TOOL_ROUTER = {
    "court_availability": execute_court_availability,
    "book_court": execute_book_court
}

def dispatch_tool_call(tool_name: str, arguments: Dict[str, Any]) -> str:
    """Hàm trung chuyển thực thi tool"""
    if tool_name in TOOL_ROUTER:
        try:
            return TOOL_ROUTER[tool_name](**arguments)
        except Exception as e:
            return json.dumps({"status": "EXECUTION_ERROR", "error": str(e)}, ensure_ascii=False)
    return json.dumps({"status": "UNKNOWN_TOOL", "error": f"Tool '{tool_name}' không tồn tại!"}, ensure_ascii=False)
