# 🏸 SmashHub Demo UI

Giao diện web cho ReAct Agent đặt sân cầu lông:

- **Chat với agent**: từng bước Thought → Action → Observation hiện trực tiếp dưới câu trả lời. Agent tra sân trống, đặt sân và hủy sân.
- **Lịch sân live**: sơ đồ 4 sân và bảng giờ theo ngày.
  - Bấm ô trống để đặt sân (`book_court`).
  - Bấm ô đã có mã booking để hủy (`cancel_booking`, cần số điện thoại đã đặt).
  - Lượt đặt/hủy từ agent hoặc từ UI đều cập nhật ngay trên mọi tab đang mở.
- **Trace hội thoại**: luồng ReAct, waterfall độ trễ LLM/Tool, chi tiết JSON-RPC và Observation của từng lượt, tải trace JSON.

Demo dùng chung `src/` của lab (MCP Server với 3 tool `court_availability`, `book_court`, `cancel_booking`; prompts; provider trong `.env`) và chỉ cần thư viện chuẩn Python.

## Chạy

Từ thư mục gốc repo, sau khi đã cài `requirements.txt` và điền `.env`:

```powershell
.venv\Scripts\python demo/server.py
```

Mở http://127.0.0.1:8765

Đổi cổng: `$env:DEMO_PORT = "9000"; .venv\Scripts\python demo/server.py`

## Ghi chú

- Dữ liệu đặt sân nằm trong bộ nhớ; tắt server hoặc bấm **Reset demo** là quay về lịch mẫu.
- Lịch mẫu 18–19/09/2026 và booking mẫu `BK-1909-S1-001` (SĐT `0912345678`) giữ nguyên như test case của lab; các ngày khác trong tuần được sinh cố định cho demo.
- Chỉ hủy được trước giờ chơi ít nhất 12 giờ (`TOO_LATE` nếu muộn hơn).
- Demo không ghi đè `docs/trace_waterfall.json`. Trace của demo tải bằng nút **Tải trace phiên**.
