# Sudoku Arena
Thi một mình, đối kháng 1v1, thi theo nhóm (2 đội cùng giải chung một bảng). Bảng xếp hạng điểm và thời gian tốt nhất.

## Chạy thử
    npm install
    REDIS_URL="rediss://default:<pass>@<host>:6379" npm start   # http://localhost:3000

## Triển khai
1. Upstash: tạo Redis database, copy **TCP endpoint** dạng `rediss://default:...@...upstash.io:6379`.
2. Đẩy thư mục này lên GitHub.
3. Render: New > Web Service (hoặc Blueprint dùng render.yaml), thêm biến môi trường `REDIS_URL`.

Lưu ý: phòng thi đối kháng/nhóm lưu trong RAM, nên chỉ chạy **1 instance**. Dữ liệu người dùng, điểm và xếp hạng lưu ở Redis.
