Nuvio PikPak WebDAV Provider

Addon/provider kết nối thư viện phim từ PikPak WebDAV với Nuvio, hỗ trợ tìm phim theo IMDb ID và phát trực tiếp thông qua signed download URL của PikPak.

📁 Cấu trúc

Davio-PikPak/
├── index.js
├── package.json
├── manifest.json
└── icon.png

🚀 Chạy thử nghiệm Local

1. Cài Node.js

Khuyến nghị Node.js 18 trở lên.

2. Cài dependencies

Mở Terminal/Command Prompt tại thư mục project:

npm install

3. Cấu hình tài khoản PikPak

Không lưu username/password trực tiếp trong "index.js".

Đặt hai Environment Variables:

PIKPAK_USERNAME=your_pikpak_username
PIKPAK_PASSWORD=your_pikpak_password

Windows PowerShell

$env:PIKPAK_USERNAME="your_pikpak_username"
$env:PIKPAK_PASSWORD="your_pikpak_password"
npm start

Linux / macOS / Termux

export PIKPAK_USERNAME="your_pikpak_username"
export PIKPAK_PASSWORD="your_pikpak_password"
npm start

Server local mặc định chạy tại:

http://localhost:3000

Manifest:

http://localhost:3000/manifest.json

Health check:

http://localhost:3000/health

Danh sách file đã scan:

http://localhost:3000/debug/files

Có thể yêu cầu scan lại:

http://localhost:3000/refresh

---

☁️ Deploy lên Render

1. Đưa project lên GitHub

Repository cần có tối thiểu:

index.js
package.json
manifest.json
icon.png
README.md

Không commit username hoặc password PikPak vào GitHub.

---

2. Tạo Web Service trên Render

Trên Render chọn:

New
→ Web Service

Sau đó chọn repository GitHub chứa project.

Build Command

npm install

Start Command

npm start

Instance Type

Có thể sử dụng Free để thử nghiệm trước.

---

3. Thêm Environment Variables

Trong phần Environment Variables của Render, thêm:

PIKPAK_USERNAME

và:

PIKPAK_PASSWORD

Giá trị tương ứng là tài khoản PikPak của bạn.

Không đưa các giá trị này vào GitHub.

---

4. Kiểm tra server

Sau khi Render deploy thành công, bạn sẽ nhận được URL dạng:

https://your-service-name.onrender.com

Kiểm tra:

https://your-service-name.onrender.com/health

Nếu server hoạt động bình thường, endpoint sẽ trả thông tin trạng thái tương tự:

{
  "status": "ok",
  "service": "PikPak Direct Stream",
  "scanning": false,
  "cachedFiles": 1218
}

Số lượng "cachedFiles" phụ thuộc vào thư viện PikPak của bạn.

---

📺 Cài addon vào Nuvio

Sau khi Render deploy thành công, sử dụng:

https://your-service-name.onrender.com/manifest.json

để thêm addon vào Nuvio.

Addon sử dụng IMDb ID để tìm phim.

Ví dụ:

tt0499549

là Avatar.

Nếu tìm thấy file phù hợp trong PikPak, addon sẽ trả stream cho Nuvio.

---

🔄 Cơ chế hoạt động

Nuvio
   │
   │ IMDb ID
   ▼
Nuvio PikPak Provider
   │
   │ Cinemeta
   ▼
Tên phim
   │
   ▼
FILE_CACHE
   │
   │ Tìm file phù hợp
   ▼
PikPak WebDAV
   │
   │ HTTP 302
   ▼
PikPak Signed Download URL
   │
   ▼
Nuvio Player

Addon không tải toàn bộ phim về server Render.

Khi Nuvio yêu cầu phát phim, server lấy signed download URL từ PikPak rồi chuyển hướng trình phát tới URL đó.

---

⚠️ Lưu ý

Render có thể restart service

Khi service restart, bộ nhớ "FILE_CACHE" sẽ bị xóa và addon cần scan lại thư viện PikPak.

Vì vậy thời gian khởi động có thể lâu hơn nếu thư viện có nhiều file.

Không lưu thông tin đăng nhập trong GitHub

Không viết:

username: "your_username",
password: "your_password"

trực tiếp trong source code.

Sử dụng:

PIKPAK_USERNAME
PIKPAK_PASSWORD

Environment Variables.

Không commit file chứa secret

Nếu repository GitHub đã từng chứa password PikPak, nên đổi password PikPak trước khi sử dụng repository công khai.

---

🛠 Endpoint

Endpoint| Chức năng
"/manifest.json"| Manifest của addon
"/stream/movie/<imdbId>"| Tìm stream phim
"/stream/series/<imdbId>"| Tìm stream series
"/proxy-stream?path=..."| Lấy signed URL từ PikPak và redirect
"/health"| Kiểm tra trạng thái server
"/debug/files"| Xem file đã scan
"/refresh"| Scan lại thư viện PikPak

---

📌 Phiên bản

Current version:

1.0.0

Provider được thiết kế để chạy trên Node.js 18+ và tương thích với môi trường hosting như Render.