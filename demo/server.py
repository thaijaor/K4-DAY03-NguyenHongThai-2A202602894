"""
🏸 SMASHHUB DEMO SERVER
Web UI demo cho ReAct Agent đặt sân cầu lông:
  - Chat với agent (stream từng bước Thought -> Action -> Observation)
  - Sơ đồ & lịch sân cập nhật live (SSE), đặt / hủy sân trực tiếp trên UI
  - Trace waterfall của từng lượt hội thoại

Chạy (từ thư mục gốc repo):
    .venv\\Scripts\\python demo/server.py          # Windows
    .venv/bin/python demo/server.py               # macOS / Linux
Mở http://127.0.0.1:8765

Chỉ dùng thư viện chuẩn Python + mã nguồn agent trong src/.
"""

import copy
import json
import mimetypes
import os
import queue
import random
import re
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DEMO_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(DEMO_DIR)
STATIC_DIR = os.path.join(DEMO_DIR, "static")
sys.path.insert(0, os.path.join(ROOT_DIR, "src"))

import tools  # noqa: E402
from app import run_react_agent  # noqa: E402
from mcp_server import MCPCourtServer  # noqa: E402
from prompts import MAX_ITERATIONS  # noqa: E402
from providers import get_llm_provider  # noqa: E402

HOST = os.getenv("DEMO_HOST", "127.0.0.1")
PORT = int(os.getenv("DEMO_PORT", "8765"))
WEEKDAYS = ["Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy", "Chủ nhật"]
DAYS_AHEAD = 7

PROVIDER = get_llm_provider()


def seed_demo_days():
    """Lab chỉ có lịch mẫu cho 18-19/09/2026; demo sinh thêm lịch cố định (theo seed ngày) cho các ngày khác trong tuần."""
    today = datetime.now().date()
    for i in range(DAYS_AHEAD):
        d = today + timedelta(days=i)
        date = d.strftime("%d/%m/%Y")
        if date in tools.BOOKINGS:
            continue
        rng = random.Random(date)
        weekend = d.weekday() >= 5
        day = {}
        for hour in range(tools.OPEN_HOUR, tools.CLOSE_HOUR):
            if 17 <= hour <= 20:
                n = rng.randint(2, 4) if weekend else rng.randint(1, 3)
            elif hour in (6, 7) or (weekend and 8 <= hour <= 10):
                n = rng.randint(0, 2)
            else:
                n = rng.choice([0, 0, 0, 1])
            if n:
                day[hour] = sorted(rng.sample(tools.COURT_IDS, n))
        tools.BOOKINGS[date] = day


seed_demo_days()
SEED_BOOKINGS = copy.deepcopy(tools.BOOKINGS)
SEED_RECORDS = copy.deepcopy(tools.BOOKING_RECORDS)
SEED_SEQ = tools._booking_seq

STATE_LOCK = threading.RLock()     # bảo vệ BOOKINGS + metadata khi agent và UI cùng đặt sân
BOOKING_META = {}                  # (date, hour, court_id) -> thông tin booking tạo trong phiên demo
SESSIONS = {}                      # session_id -> {"turns": [...], "mcp": DemoMCPServer}


# ==============================================================================
# LIVE EVENTS (Server-Sent Events)
# ==============================================================================

class EventHub:
    def __init__(self):
        self._clients = set()
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue:
        q = queue.Queue()
        with self._lock:
            self._clients.add(q)
        return q

    def unsubscribe(self, q: queue.Queue):
        with self._lock:
            self._clients.discard(q)

    def publish(self, event: dict):
        with self._lock:
            for q in list(self._clients):
                q.put(event)

    @property
    def count(self) -> int:
        return len(self._clients)


HUB = EventHub()


# ==============================================================================
# MCP SERVER CÓ GHI NHẬN NGUỒN ĐẶT SÂN
# ==============================================================================

class DemoMCPServer(MCPCourtServer):
    """MCP Server dùng chung backend với lab, thêm khóa đồng thời và phát sự kiện khi có booking mới."""

    def __init__(self, source: str, session_id: str = None):
        super().__init__()
        self.source = source
        self.session_id = session_id

    def call_tool(self, tool_name, arguments):
        with STATE_LOCK:
            response = super().call_tool(tool_name, arguments)
            result = response.get("result", {})
            if tool_name == "book_court" and result.get("status") == "SUCCESS":
                self._record_booking(result)
            if tool_name == "cancel_booking" and result.get("status") == "CANCELLED":
                self._record_cancel(result)
        return response

    def _record_cancel(self, result: dict):
        match = re.match(r"(\d{2}):00-\d{2}:00 (\d{2}/\d{2}/\d{4})", result.get("datetime", ""))
        if not match:
            return
        hour, date = int(match.group(1)), match.group(2)
        BOOKING_META.pop((date, hour, result["court_id"]), None)
        HUB.publish({"type": "cancel", "booking": {
            "booking_id": result["booking_id"], "court_id": result["court_id"], "date": date, "hour": hour,
            "source": self.source, "session_id": self.session_id,
            "created_at": datetime.now().isoformat(timespec="seconds"),
        }})

    def _record_booking(self, result: dict):
        match = re.match(r"(\d{2}):00-\d{2}:00 (\d{2}/\d{2}/\d{4})", result.get("datetime", ""))
        if not match:
            return
        hour, date = int(match.group(1)), match.group(2)
        meta = {
            "booking_id": result["booking_id"],
            "court_id": result["court_id"],
            "date": date,
            "hour": hour,
            "phone": result.get("customer_phone", ""),
            "price": result.get("price"),
            "source": self.source,
            "session_id": self.session_id,
            "created_at": datetime.now().isoformat(timespec="seconds"),
        }
        BOOKING_META[(date, hour, result["court_id"])] = meta
        HUB.publish({"type": "booking", "booking": meta})


UI_MCP = DemoMCPServer(source="ui")


# ==============================================================================
# DỮ LIỆU LỊCH SÂN
# ==============================================================================

def mask_phone(phone: str) -> str:
    return phone[:3] + "****" + phone[-3:] if len(phone) >= 7 else phone


def day_list():
    today = datetime.now().date()
    days = []
    for i in range(DAYS_AHEAD):
        d = today + timedelta(days=i)
        date = d.strftime("%d/%m/%Y")
        booked = sum(len(v) for v in tools.BOOKINGS.get(date, {}).values())
        total = len(tools.COURT_IDS) * (tools.CLOSE_HOUR - tools.OPEN_HOUR)
        days.append({
            "date": date,
            "weekday": WEEKDAYS[d.weekday()],
            "day": d.strftime("%d"),
            "month": d.strftime("%m"),
            "is_today": i == 0,
            "occupancy": round(booked / total, 3),
        })
    return days


def schedule_for(date: str) -> dict:
    day = tools._parse_date(date)
    date = day.strftime("%d/%m/%Y")
    now = datetime.now()
    slots = []
    with STATE_LOCK:
        records = {(r["date"], r["hour"], r["court_id"]): {"booking_id": bid, "phone": r["customer_phone"], "source": "seed"}
                   for bid, r in tools.BOOKING_RECORDS.items()}
        for hour in range(tools.OPEN_HOUR, tools.CLOSE_HOUR):
            booked_courts = tools.BOOKINGS.get(date, {}).get(hour, [])
            courts = []
            for court in tools.COURT_IDS:
                meta = BOOKING_META.get((date, hour, court)) or records.get((date, hour, court))
                courts.append({
                    "court_id": court,
                    "status": "booked" if court in booked_courts else "free",
                    "booking": {**meta, "phone": mask_phone(meta["phone"])} if meta else None,
                })
            slots.append({
                "hour": hour,
                "time": f"{hour:02d}:00",
                "price": tools._price_per_hour(day, hour),
                "past": day.date() < now.date() or (day.date() == now.date() and hour <= now.hour),
                "courts": courts,
            })
    return {"date": date, "weekday": WEEKDAYS[day.weekday()], "courts": tools.COURT_IDS, "slots": slots}


# ==============================================================================
# CHAT VỚI AGENT
# ==============================================================================

def get_session(session_id: str) -> dict:
    with STATE_LOCK:
        if session_id not in SESSIONS:
            SESSIONS[session_id] = {"turns": [], "mcp": DemoMCPServer(source="agent", session_id=session_id)}
        return SESSIONS[session_id]


def build_agent_query(session: dict, message: str) -> str:
    """Bổ sung ngày hôm nay và vài lượt hội thoại gần nhất để agent hiểu 'hôm nay', 'sân đó'..."""
    today = datetime.now()
    lines = [f"(Ngữ cảnh hệ thống: hôm nay là {WEEKDAYS[today.weekday()]}, ngày {today:%d/%m/%Y}, bây giờ là {today:%H:%M}.)"]
    recent = [t for t in session["turns"] if t.get("answer")][-3:]
    if recent:
        lines.append("Lịch sử hội thoại gần đây:")
        for turn in recent:
            lines.append(f"Khách: {turn['message']}")
            lines.append(f"Trợ lý: {turn['answer'][:600]}")
    lines.append(f"Tin nhắn mới của khách: {message}")
    return "\n".join(lines)


def run_turn(session_id: str, message: str, send):
    session = get_session(session_id)
    turn = {
        "turn_id": uuid.uuid4().hex[:8],
        "message": message,
        "started_at": datetime.now().isoformat(timespec="seconds"),
        "provider": PROVIDER.__class__.__name__,
        "model": getattr(PROVIDER, "model_name", ""),
        "events": [],
        "trace": [],
        "answer": None,
        "fallback": False,
        "error": None,
    }
    t0 = time.perf_counter()

    def on_event(event: dict):
        event = {**event, "t_ms": round((time.perf_counter() - t0) * 1000, 2)}
        turn["events"].append(event)
        if event["event"] == "trace":
            turn["trace"].append(event["entry"])
        if event["event"] == "llm_fallback":
            turn["fallback"] = True
        send(event)

    send({"event": "turn_start", "turn_id": turn["turn_id"], "message": message,
          "provider": turn["provider"], "model": turn["model"], "t_ms": 0})
    try:
        query = build_agent_query(session, message)
        run_react_agent(query, PROVIDER, session["mcp"], on_event=on_event)
        final = next((e for e in reversed(turn["trace"]) if e["action_type"] != "TOOL_EXECUTION"), None)
        turn["answer"] = final["output"] if final else ""
    except Exception as e:  # lỗi ngoài dự kiến vẫn trả về UI thay vì treo request
        turn["error"] = f"{type(e).__name__}: {e}"
        turn["answer"] = "Xin lỗi, hệ thống gặp lỗi khi xử lý yêu cầu."
    turn["total_ms"] = round((time.perf_counter() - t0) * 1000, 2)
    with STATE_LOCK:
        session["turns"].append(turn)
    send({"event": "turn_end", "turn": public_turn(turn)})


def public_turn(turn: dict) -> dict:
    return {k: v for k, v in turn.items()}


# ==============================================================================
# HTTP HANDLER
# ==============================================================================

class Handler(BaseHTTPRequestHandler):
    server_version = "SmashHubDemo/1.0"

    def log_message(self, fmt, *args):
        if "/api/events" not in (self.path or ""):
            sys.stderr.write(f"[{datetime.now():%H:%M:%S}] {fmt % args}\n")

    # ---------- helpers ----------
    def _json(self, data, status=HTTPStatus.OK, extra_headers=None):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _static(self, rel_path: str):
        full = os.path.normpath(os.path.join(STATIC_DIR, rel_path))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            return self._json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---------- routes ----------
    def do_GET(self):
        url = urlparse(self.path)
        qs = parse_qs(url.query)
        path = url.path

        if path in ("/", "/index.html"):
            return self._static("index.html")
        if path.startswith("/static/"):
            return self._static(path[len("/static/"):])
        if path == "/api/info":
            return self._json({
                "provider": PROVIDER.__class__.__name__,
                "model": getattr(PROVIDER, "model_name", ""),
                "mcp_server": UI_MCP.server_name,
                "mcp_version": UI_MCP.version,
                "tools": [t["name"] for t in UI_MCP.list_tools()],
                "max_iterations": MAX_ITERATIONS,
                "open_hour": tools.OPEN_HOUR,
                "close_hour": tools.CLOSE_HOUR,
                "courts": tools.COURT_IDS,
                "today": datetime.now().strftime("%d/%m/%Y"),
                "days": day_list(),
            })
        if path == "/api/schedule":
            date = (qs.get("date") or [datetime.now().strftime("%d/%m/%Y")])[0]
            try:
                return self._json({**schedule_for(date), "days": day_list()})
            except ValueError:
                return self._json({"error": "Ngày không hợp lệ (DD/MM/YYYY)"}, HTTPStatus.BAD_REQUEST)
        if path == "/api/trace":
            session_id = (qs.get("session_id") or [""])[0]
            session = SESSIONS.get(session_id)
            turns = [public_turn(t) for t in session["turns"]] if session else []
            headers = {}
            if (qs.get("download") or [""])[0]:
                headers["Content-Disposition"] = f'attachment; filename="smashhub_trace_{session_id[:8]}.json"'
            return self._json({"session_id": session_id, "turns": turns}, extra_headers=headers)
        if path == "/api/events":
            return self._sse()
        return self._json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            body = self._read_json()
        except json.JSONDecodeError:
            return self._json({"error": "Body không phải JSON"}, HTTPStatus.BAD_REQUEST)

        if path == "/api/book":
            args = {
                "court_id": str(body.get("court_id", "")),
                "datetime_str": f"{int(body.get('hour', -1)):02d}:00 {body.get('date', '')}",
                "customer_phone": str(body.get("phone", "")),
            }
            response = UI_MCP.call_tool("book_court", args)
            ok = response["result"].get("status") == "SUCCESS"
            return self._json({"request": {"tool": "book_court", "arguments": args}, **response},
                              HTTPStatus.OK if ok else HTTPStatus.CONFLICT)
        if path == "/api/cancel":
            args = {"booking_id": str(body.get("booking_id", "")), "customer_phone": str(body.get("phone", ""))}
            response = UI_MCP.call_tool("cancel_booking", args)
            ok = response["result"].get("status") == "CANCELLED"
            return self._json({"request": {"tool": "cancel_booking", "arguments": args}, **response},
                              HTTPStatus.OK if ok else HTTPStatus.CONFLICT)
        if path == "/api/chat":
            message = str(body.get("message", "")).strip()
            session_id = str(body.get("session_id") or uuid.uuid4().hex)
            if not message:
                return self._json({"error": "Tin nhắn trống"}, HTTPStatus.BAD_REQUEST)
            return self._chat_stream(session_id, message)
        if path == "/api/reset":
            with STATE_LOCK:
                tools.BOOKINGS.clear()
                tools.BOOKINGS.update(copy.deepcopy(SEED_BOOKINGS))
                tools.BOOKING_RECORDS.clear()
                tools.BOOKING_RECORDS.update(copy.deepcopy(SEED_RECORDS))
                tools._booking_seq = SEED_SEQ
                BOOKING_META.clear()
                SESSIONS.clear()
            HUB.publish({"type": "reset"})
            return self._json({"ok": True})
        return self._json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def _chat_stream(self, session_id: str, message: str):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Session-Id", session_id)
        self.end_headers()
        alive = {"ok": True}

        def send(event: dict):
            if not alive["ok"]:
                return
            try:
                self.wfile.write((json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                alive["ok"] = False  # client đóng tab: agent vẫn chạy xong và lưu trace

        run_turn(session_id, message, send)
        self.close_connection = True

    def _sse(self):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = HUB.subscribe()
        try:
            self.wfile.write(b"event: hello\ndata: {}\n\n")
            self.wfile.flush()
            while True:
                try:
                    event = q.get(timeout=15)
                    payload = json.dumps(event, ensure_ascii=False)
                    self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            HUB.unsubscribe(q)
            self.close_connection = True


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print("==========================================================")
    print("🏸 SMASHHUB DEMO — ReAct Agent + MCP + Live Court Board")
    print("==========================================================")
    print(f"🔌 LLM Provider : {PROVIDER.__class__.__name__} ({getattr(PROVIDER, 'model_name', '')})")
    print(f"🌐 MCP Server   : {UI_MCP.server_name}")
    print(f"🚀 Mở trình duyệt: http://{HOST}:{PORT}")
    print("   Ctrl+C để dừng.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 Đã dừng demo server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
