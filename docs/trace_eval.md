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

```json
[
  {
    "step": 1,
    "action_type": "TOOL_EXECUTION",
    "tool_name": "academic_query",
    "arguments": {
      "student_id": "SV2026001"
    },
    "observation": {
      "status": "SUCCESS",
      "student_id": "SV2026001",
      "data": {
        "full_name": "Nguyễn Văn An",
        "gpa": 3.85
      }
    },
    "latency_ms": 120.5
  }
]
```

---

## 3. TỔNG KẾT KẾT QUẢ NGHIỆM THU & NỘP BÀI

- [ ] Đã điền API Key thật trong `.env` và xác nhận Agent chạy mượt mà trên LLM API thật (Gemini/OpenAI).
- **Tổng số Test Cases đã chạy thành công:** ___ / 5 test cases.
- **Số lượt gọi Tool qua MCP Server chính xác:** ___ lượt.
- **Kết quả đẩy Repo nộp bài:** [ ] Đã Commit và Push mã nguồn thành công lên GitHub cá nhân.

---

> ✅ **HOÀN TẤT NỘP BÀI:** Sao chép đường link GitHub Repository cá nhân của bạn và dán vào ô nộp bài trên hệ thống LMS VLearn để hoàn tất Bài Lab 3!
