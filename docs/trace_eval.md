# 📊 BÁO CÁO THU HOẠCH NGHIỆM THU BÀI LAB 3 (BƯỚC 3 — SUBMISSION ARTIFACT)

> **Họ và Tên Học viên:** Nguyễn Hồng Thái  
> **Mã Sinh Viên / Mã Học viên:** 2A202602894  
> **Chủ đề Lựa chọn:** Đề tài Mở — Trợ lý Đặt sân Cầu lông (tra cứu sân trống + đặt sân)  

---

## 1. BẢNG CHẤM ĐIỂM AGENTIC FIT SCORING MATRIX (ĐÁNH GIÁ CHỦ ĐỀ)

| Tiêu chí Đánh giá | Mức độ (1 - 5) | Giải trình chi tiết lý do chọn điểm |
| :--- | :---: | :--- |
| **1. Multi-step Reasoning** | 4 / 5 | Yêu cầu "tìm sân trống rồi đặt" phải tách thành: tra lịch trống → chọn sân/khung giờ phù hợp → đặt sân. Chuỗi ngắn (2–3 bước) nên không đạt 5. |
| **2. Tool Interaction** | 5 / 5 | Lịch sân thay đổi liên tục, LLM không thể tự biết sân nào trống; bắt buộc đọc dữ liệu thời gian thực và ghi booking vào hệ thống qua MCP Server. |
| **3. Dynamic Decision** | 4 / 5 | Tham số `book_court` (court_id, giờ) lấy từ kết quả `court_availability`; nếu hết sân thì phải dừng đặt và gợi ý khung giờ khác thay vì đặt. |
| **4. Long Horizon Goal** | 2 / 5 | Mục tiêu gói gọn trong một phiên đặt sân, không cần theo dõi qua nhiều ngày hay nhiều phiên. |
| **TỔNG ĐIỂM AGENTIC FIT** | **15 / 20** | *> 12/20: phù hợp triển khai ReAct Agent.* |

---

## 2. TRÍCH XUẤT KẾT QUẢ WATERFALL TRACE LOG (SAU KHI CHẠY TEST SUITE TRÊN API THẬT)

> ⚠️ **YÊU CẦU NGHIỆM THU:** Mở tệp `.env` điền `GEMINI_API_KEY` (hoặc `OPENAI_API_KEY`) để kết nối LLM thật trước khi thực thi `python src/app.py --all`. Bài nộp chỉ dùng Mock Offline Provider sẽ không đạt điểm nghiệm thực tế.

Dán 1 đoạn trích xuất log tiêu biểu từ file `docs/trace_waterfall.json` sinh ra từ phản hồi LLM API thật:

**TC04 (multi_step_reasoning)** — Provider `OpenAIProvider` (endpoint OpenAI-compatible), model `ag/gemini-3.6-flash-medium`. Agent tra sân trống trước, chọn sân S4 lúc 20:00 từ Observation (S2 đã được đặt ở TC03), rồi mới đặt sân:

```json
[
  {
    "step": 1,
    "action_type": "TOOL_EXECUTION",
    "thought": "OpenAI quyết định gọi công cụ 'court_availability' với tham số: {\"time_range\": \"19:00-22:00\", \"date\": \"18/09/2026\"}",
    "tool_name": "court_availability",
    "arguments": {
      "time_range": "19:00-22:00",
      "date": "18/09/2026"
    },
    "jsonrpc_id": 3,
    "observation": {
      "status": "SUCCESS",
      "date": "18/09/2026",
      "time_range": "19:00-22:00",
      "available_slots": [
        {
          "time": "20:00",
          "free_courts": [
            "S4"
          ],
          "price_per_hour": 120000
        },
        {
          "time": "21:00",
          "free_courts": [
            "S2",
            "S3",
            "S4"
          ],
          "price_per_hour": 120000
        }
      ]
    },
    "latency_ms": 3142.52
  },
  {
    "step": 2,
    "action_type": "TOOL_EXECUTION",
    "thought": "OpenAI quyết định gọi công cụ 'book_court' với tham số: {\"customer_phone\": \"0912345678\", \"court_id\": \"S4\", \"datetime_str\": \"20:00 18/09/2026\"}",
    "tool_name": "book_court",
    "arguments": {
      "customer_phone": "0912345678",
      "court_id": "S4",
      "datetime_str": "20:00 18/09/2026"
    },
    "jsonrpc_id": 4,
    "observation": {
      "status": "SUCCESS",
      "booking_id": "BK-1809-S4-102",
      "court_id": "S4",
      "datetime": "20:00-21:00 18/09/2026",
      "customer_phone": "0912345678",
      "price": 120000,
      "message": "Đặt thành công sân S4 lúc 20:00-21:00 ngày 18/09/2026, giá 120.000đ."
    },
    "latency_ms": 2609.89
  },
  {
    "step": 3,
    "action_type": "FINAL_ANSWER",
    "thought": "OpenAI phản hồi trực tiếp bằng văn bản (không cần gọi công cụ).",
    "output": "Dạ, em đã đặt thành công sân cầu lông cho anh/chị với thông tin chi tiết như sau:\n\n- **Mã đặt sân (Booking ID):** BK-1809-S4-102\n- **Sân:** S4\n- **Thời gian:** 20:00 - 21:00, Thứ Sáu ngày 18/09/2026\n- **Số điện thoại:** 0912345678\n- **Giá tiền:** 120.000đ/giờ",
    "latency_ms": 3941.77
  }
]
```

---

## 3. TỔNG KẾT KẾT QUẢ NGHIỆM THU & NỘP BÀI

- [x] Đã điền API Key thật trong `.env` và xác nhận Agent chạy mượt mà trên LLM API thật (Gemini/OpenAI).
- **Tổng số Test Cases đã chạy thành công:** 5 / 5 test cases.
- **Số lượt gọi Tool qua MCP Server chính xác:** 5 / 5 lượt (TC02: 1, TC03: 1, TC04: 2, TC05: 1; TC01 trả lời trực tiếp, không gọi Tool).
- **Kết quả đẩy Repo nộp bài:** [ ] Đã Commit và Push mã nguồn thành công lên GitHub cá nhân.

---

> ✅ **HOÀN TẤT NỘP BÀI:** Sao chép đường link GitHub Repository cá nhân của bạn và dán vào ô nộp bài trên hệ thống LMS VLearn để hoàn tất Bài Lab 3!
