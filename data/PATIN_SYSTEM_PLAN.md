# 🛼 HỆ THỐNG WEB ĐIỀU KHIỂN THI ĐẤU PATIN — ESP32
> **Tài liệu kế hoạch phát triển (Project Plan)**  
> Phiên bản: v1.0  
> Ngày tạo: 13/05/2026  
> Công nghệ: HTML + CSS + JS thuần (không framework) | Deploy trên ESP32

---

## 1. TỔNG QUAN HỆ THỐNG

### Mục tiêu
Xây dựng một giao diện web chạy trực tiếp trên ESP32, cho phép người dùng truy cập qua smartphone hoặc máy tính bằng địa chỉ IP của ESP32. Hệ thống hỗ trợ 2 chế độ: **Tập luyện** và **Thi đấu chuyên nghiệp**.

### Ràng buộc kỹ thuật
| Yếu tố | Giới hạn |
|--------|---------|
| RAM ESP32 khả dụng | ~200KB free heap |
| File HTML | 1 file duy nhất (inline CSS + JS) |
| Framework | Không dùng (vanilla HTML/CSS/JS) |
| CDN ngoài | Không dùng (ESP32 có thể offline) |
| Font | Nhúng trực tiếp hoặc dùng web-safe font |
| Số thí sinh tối đa | ~64 người |
| Kết nối client | Smartphone / Tablet / Laptop qua WiFi |

### Kiến trúc tổng quan
```
[Client: Browser]  <──HTTP──>  [ESP32 Web Server]  <──GPIO/Serial──>  [Bảng LED]
        │                              │
   Single Page App              /api/start
   (1 file HTML)                /api/stop
                                /api/status
```

---

## 2. CẤU TRÚC ĐIỀU HƯỚNG (Single Page App)

```
[Màn hình Home]
        │
        ├──────────────────────────────────────────┐
        ▼                                          ▼
[Chế độ Tập luyện]                [Chế độ Thi đấu Chuyên nghiệp]
        │                                          │
   [Stopwatch UI]              ┌───────────────────┤
   [Nút START/STOP]            ▼                   ▼
   [Gửi lệnh ESP32]    [Import CSV]        [Xem Bracket tổng]
                               │
                       [Danh sách thí sinh]
                               │
                       [Vòng 1/16: Thi lần lượt]
                       → Chọn Top 16 thí sinh
                               │
                       [Vòng 1/8: 8 cặp đấu]
                       → Chọn Top 8 thí sinh
                               │
                       [Vòng 1/4: 4 cặp đấu]
                       → Chọn Top 4 thí sinh
                               │
                       [Chung kết: 2 cặp đấu]
                       → Top 1, 2, 3 chung cuộc
```

---

## 3. LOGIC THI ĐẤU CHUYÊN NGHIỆP (QUAN TRỌNG)

### 3.1 Vòng 1/16 — Thi lần lượt cá nhân

- **Input:** Toàn bộ thí sinh từ file CSV (không giới hạn số lượng, ví dụ 24, 30, hay 40 người).
- **Cơ chế:** Mỗi thí sinh thi đấu **lần lượt một mình** (không ghép cặp), thời gian được ghi nhận bởi bảng LED.
- **Chấm điểm:**
  - Thời gian hoàn thành (về đích sớm = điểm cao hơn)
  - Trừ điểm nếu có lỗi (phạm lỗi)
  - Điểm cuối cùng = Hàm tổng hợp (thời gian + penalty)
- **Output:** Bảng xếp hạng toàn bộ thí sinh theo điểm số, lấy **Top 16** vào vòng tiếp theo.
- **Xử lý đặc biệt:** Nếu số thí sinh < 16, lấy tất cả vào vòng 1/8 (không cần vòng 1/16).

### 3.2 Vòng 1/8 trở đi — Ghép cặp đối kháng

Từ vòng 1/8, logic ghép cặp cố định theo nguyên tắc **hạng cao đấu hạng thấp đối xứng**:

```
Ví dụ 16 người vào vòng 1/8:
  Hạng 1  ──vs──  Hạng 16
  Hạng 2  ──vs──  Hạng 15
  Hạng 3  ──vs──  Hạng 14
  Hạng 4  ──vs──  Hạng 13
  Hạng 5  ──vs──  Hạng 12
  Hạng 6  ──vs──  Hạng 11
  Hạng 7  ──vs──  Hạng 10
  Hạng 8  ──vs──  Hạng 9
```

**Công thức ghép cặp (JS):**
```javascript
function generatePairs(rankedPlayers) {
  const pairs = [];
  const n = rankedPlayers.length;
  for (let i = 0; i < n / 2; i++) {
    pairs.push({
      player1: rankedPlayers[i],         // hạng i+1
      player2: rankedPlayers[n - 1 - i]  // hạng đối xứng
    });
  }
  return pairs;
}
```

### 3.3 Bảng tóm tắt các vòng đấu

| Vòng | Cơ chế | Số người vào | Kết quả |
|------|--------|-------------|---------|
| **1/16** | Thi lần lượt cá nhân, chấm điểm | Tất cả thí sinh từ CSV | Lấy Top 16 |
| **1/8** | Ghép cặp đối kháng (hạng 1 vs cuối) | 16 người | 8 người thắng |
| **1/4** | Ghép cặp đối kháng (tương tự) | 8 người | 4 người thắng |
| **Chung kết** | Ghép cặp đối kháng | 4 người (2 cặp) | Top 1, 2, 3 |

### 3.4 Xác định người thắng trong cặp đấu (vòng 1/8 trở đi)
- Mỗi cặp thi đấu trực tiếp, người về đích sớm hơn và không phạm lỗi = **THẮNG**
- Operator bấm nút **"Thí sinh A thắng"** hoặc **"Thí sinh B thắng"** trên giao diện
- Hệ thống tự động cập nhật bracket và chuyển sang cặp tiếp theo

### 3.5 Chung kết — Xác định Top 3
```
Cặp 1: Hạng 1 vs Hạng 4  →  Người thắng = Hạng Nhất
Cặp 2: Hạng 2 vs Hạng 3  →  Người thắng = Hạng Nhì
                           →  Người thua  = Hạng Ba
```

---

## 4. MODULE TỪNG MÀN HÌNH

### 4.1 Màn hình Home
**Thành phần:**
- Logo / Tên giải đấu (có thể cấu hình)
- Đồng hồ hiển thị giờ thực (lấy từ browser)
- 2 nút lớn: `🏋️ Tập luyện` | `🏆 Thi đấu Chuyên nghiệp`
- Hiệu ứng nền thể thao, màu tối chuyên nghiệp

---

### 4.2 Màn hình Tập luyện
**Thành phần:**
- Đồng hồ bấm giờ lớn (mm:ss:ms)
- Nút `START` (màu xanh nổi bật)
- Nút `STOP` và `RESET`
- Gửi HTTP request tới ESP32 khi bấm

**API calls:**
```
GET /api/start   → ESP32 bắt đầu đếm / bảng LED sáng
GET /api/stop    → ESP32 dừng
GET /api/reset   → Reset
GET /api/status  → Lấy thời gian hiện tại (polling)
```

---

### 4.3 Màn hình Import CSV
**Định dạng file CSV đầu vào:**
```csv
Ho ten,Ngay sinh
Nguyen Van A,15/03/2010
Tran Thi B,22/07/2011
Le Van C,08/12/2009
```

**Xử lý:**
1. User upload file `.csv` qua input `type="file"`
2. JS đọc bằng `FileReader API`
3. Parse thủ công (split theo dòng và dấu phẩy)
4. Validate: bỏ dòng thiếu tên / ngày sinh sai format
5. Tính tuổi tự động từ ngày sinh
6. Hiển thị bảng preview danh sách thí sinh
7. User xác nhận → Lưu vào biến global JS (không cần localStorage hay DB)

**Validate rules:**
- Cột `Ho ten`: không được rỗng
- Cột `Ngay sinh`: format `DD/MM/YYYY`, năm hợp lệ
- Trùng tên: cảnh báo (không tự động xóa)

---

### 4.4 Màn hình Vòng 1/16 (Thi lần lượt)
**Thành phần:**
- Thanh tiến trình: `Thí sinh X / Y`
- Tên thí sinh hiện tại (to, rõ)
- Nút `▶ START` → gửi lệnh bảng LED
- Ô nhập điểm / thời gian (operator nhập tay hoặc nhận từ ESP32)
- Nút `✔ Xác nhận & Thí sinh tiếp theo`
- Bảng xếp hạng tạm thời bên dưới (cập nhật live)

---

### 4.5 Màn hình Vòng đấu (1/8, 1/4, Chung kết)
**Thành phần:**
- Header: tên vòng hiện tại (`VÒNG 1/8 — Cặp 3/8`)
- Thẻ thí sinh 1 (trái) vs Thẻ thí sinh 2 (phải) — hiển thị tên to, hạng hiện tại
- Nút `▶ START` ở giữa → gửi lệnh bảng LED
- Sau khi thi xong:
  - Nút `🏆 [Tên thí sinh 1] THẮNG`
  - Nút `🏆 [Tên thí sinh 2] THẮNG`
- Bracket mini bên dưới (mini-map tiến trình)

---

### 4.6 Màn hình Bracket Tổng quan
**Thành phần:**
- Sơ đồ cây đấu dạng visual (vẽ bằng CSS + JS thuần, không dùng canvas/SVG lib)
- Hiển thị tên thí sinh, trạng thái (chờ / thi xong / thắng / thua)
- Cập nhật sau mỗi cặp đấu
- Nút in / chụp màn hình (window.print())

---

## 5. CẤU TRÚC DỮ LIỆU (JavaScript Global State)

```javascript
const AppState = {
  mode: null, // 'training' | 'competition'

  competition: {
    players: [
      // { id, name, dob, age, score, rank }
    ],

    currentRound: 'R16', // 'R16' | 'R8' | 'R4' | 'FINAL'

    rounds: {
      R16: {
        players: [],       // danh sách thi lần lượt
        results: [],       // { playerId, score, time, penalty }
        qualified: []      // Top 16 sau khi xong
      },
      R8: {
        pairs: [],         // [{ player1, player2 }]
        results: [],       // { winnerId, loserId }
        qualified: []      // 8 người thắng
      },
      R4: { pairs: [], results: [], qualified: [] },
      FINAL: { pairs: [], results: [], podium: { gold, silver, bronze } }
    },

    currentMatch: {
      round: null,
      pairIndex: null,
      playerIndex: null  // dùng cho R16
    }
  }
};
```

---

## 6. API ENDPOINTS (ESP32 Server)

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET | `/` | Trả về file HTML chính |
| GET | `/api/start` | Bắt đầu đếm giờ / bật bảng LED |
| GET | `/api/stop` | Dừng đếm giờ |
| GET | `/api/reset` | Reset về 0 |
| GET | `/api/status` | Trả JSON: `{ time_ms, running, score }` |
| POST | `/api/config` | Gửi cấu hình (tên giải, chế độ) |

**Response format (JSON):**
```json
{
  "time_ms": 12540,
  "running": false,
  "score": 95.5,
  "penalty": 0
}
```

---

## 7. THỨ TỰ BUILD

### Giai đoạn 1 — Skeleton & Navigation
- [ ] Tạo file HTML duy nhất
- [ ] CSS variables, reset, typography
- [ ] JS Router (hiển thị/ẩn section theo hash hoặc state)
- [ ] Màn hình Home

### Giai đoạn 2 — Module Tập luyện
- [ ] Stopwatch UI (mm:ss:ms)
- [ ] Nút START / STOP / RESET
- [ ] Mock API call (console.log) → sau thay bằng fetch thật

### Giai đoạn 3 — Import CSV & Quản lý thí sinh
- [ ] Upload UI
- [ ] FileReader + CSV parser
- [ ] Validate + preview bảng
- [ ] Lưu vào AppState

### Giai đoạn 4 — Vòng 1/16
- [ ] UI thi lần lượt
- [ ] Nhập điểm / thời gian
- [ ] Tính xếp hạng & chọn Top 16
- [ ] Giao diện bảng xếp hạng live

### Giai đoạn 5 — Vòng 1/8, 1/4, Chung kết
- [ ] Hàm generatePairs() theo logic đối xứng
- [ ] UI cặp đấu
- [ ] Nút chọn người thắng
- [ ] Tự động chuyển cặp / vòng tiếp theo

### Giai đoạn 6 — Bracket Visualization
- [ ] Vẽ cây đấu bằng CSS thuần
- [ ] Cập nhật realtime
- [ ] In / xuất

### Giai đoạn 7 — Tích hợp ESP32
- [ ] Thay mock API bằng fetch thật
- [ ] Polling `/api/status` (setInterval mỗi 200ms)
- [ ] Tối ưu kích thước file HTML (minify inline)
- [ ] Test trên thiết bị thật
- [ ] Xử lý timeout / mất kết nối

---

## 8. LƯU Ý KỸ THUẬT CHO ESP32

1. **Kích thước file:** Cố gắng giữ file HTML < 100KB sau khi minify
2. **Polling thay WebSocket:** ESP32 Arduino WebSocket library nặng; dùng `setInterval` + `fetch /api/status` mỗi 200ms là đủ
3. **SPIFFS / LittleFS:** Nên lưu file HTML vào flash filesystem thay vì hardcode vào `.ino`
4. **CORS:** Nếu test trên máy tính local, thêm header `Access-Control-Allow-Origin: *` vào ESP32 response
5. **Không dùng localStorage:** Dữ liệu chỉ tồn tại trong session (biến JS global); nếu user reload là mất → cân nhắc thông báo cho user
6. **Watchdog:** ESP32 có thể reset nếu loop bị block; đảm bảo server handle request nhanh

---

## 9. GIAO DIỆN — ĐỊNH HƯỚNG THIẾT KẾ

- **Theme:** Dark mode — nền đen/xám đậm, accent màu vàng/cam thể thao
- **Typography:** Font đậm, dễ đọc từ xa (dùng system font hoặc nhúng 1 font duy nhất)
- **Nút START:** Kích thước lớn, màu nổi bật, không thể bỏ qua
- **Responsive:** Ưu tiên mobile-first (operator dùng điện thoại)
- **Contrast:** Cao — dễ nhìn dưới ánh sáng ngoài trời / phòng thi đấu

---

## 10. CHECKLIST TRƯỚC KHI DEPLOY

- [ ] Test trên Chrome mobile (Android)
- [ ] Test trên Safari mobile (iOS)  
- [ ] Test CSV với ký tự tiếng Việt có dấu
- [ ] Test với số thí sinh tối thiểu (1 người) và tối đa (64 người)
- [ ] Đảm bảo không crash khi mất kết nối ESP32 giữa chừng
- [ ] Kiểm tra RAM ESP32 khi load trang (Serial Monitor)
- [ ] Xác nhận API response time < 500ms

---

*Tài liệu này sẽ được cập nhật liên tục trong quá trình phát triển.*
