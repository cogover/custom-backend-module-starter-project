# Bộ khởi tạo Custom Backend Module cho Cogover

[English](README.md) | [Tiếng Việt](README.vi.md)

Bộ khởi tạo TypeScript tối giản để phát triển, kiểm thử và publish Custom Backend
Module trên Cogover. Cùng một handler chạy được qua HTTP runner local và trên
Cogover Runtime Server.

## Yêu cầu

- Node.js 20 trở lên.
- Một Project Custom Backend Module trên Cogover, cùng Project ID và slug.
- HTTPS origin của Workspace, ví dụ `https://example.cogover.com`.
- Project key để tạo Development Session khi phát triển local.
- Workspace API key riêng để publish hoặc activate bằng CLI.

## Cài đặt

Cài Cogover Dev CLI và các dependency của project:

```bash
npm install --global @cogover/dev-cli
npm install
```

## Cấu hình Project

Tạo file cấu hình Project local:

```bash
cp cogover.example.json cogover.json
```

Thay các giá trị mẫu trong `cogover.json`:

```json
{
  "version": 1,
  "runtimeUrl": "https://example.cogover.com",
  "projectId": "replace-with-project-id",
  "projectSlug": "replace_with_project_slug"
}
```

`runtimeUrl` phải là HTTPS origin của Workspace, không kèm đường dẫn.
File `cogover.json` local được chủ động loại khỏi Git bằng quy tắc ignore.

## Thêm entry point

Tạo `src/main.ts`. Ví dụ:

```typescript
import { createRouter } from "@cogover/sdk";

const router = createRouter();
router.get("/", async () => ({ ok: true }));

export default router.toHandler();
```

Đặt code cần deploy trong `src/`. Các file trong `local/` chỉ hỗ trợ phát triển
local và không được import từ code trong `src/`.

## Phát triển local

Đăng nhập bằng Project key tại lời nhắc nhập ẩn, sau đó kiểm tra cấu hình:

```bash
cogover-dev login --profile <project-slug>
cogover-dev doctor --profile <project-slug>
```

Khởi chạy API local thông qua Development Session:

```bash
COGOVER_LOCAL_PORT=3100 cogover-dev run --profile <project-slug> -- npm run dev
```

URL local là:

```text
http://127.0.0.1:3100/api/v1/ts-projects/<project-slug>
```

Có thể chạy kiểm tra kiểu dữ liệu độc lập bằng lệnh:

```bash
npm run typecheck
```

Chạy test của bộ công cụ local bằng lệnh:

```bash
npm test
```

## Chạy record trigger trên local

Cogover chỉ gửi sự kiện thay đổi record thật tới version đã publish và đang
active của Project. Để debug một trigger trước khi publish, khai báo trigger
bằng `defineTrigger`, đưa vào named export `triggers` của `src/main.ts` rồi khởi
chạy local server như trên. Default export trở thành tùy chọn khi Project chỉ có
trigger. Khi khởi động, server in ra danh sách key của trigger; `GET
/__cogover/triggers` liệt kê các trigger cùng cấu hình đã chuẩn hóa.

Chạy một trigger theo yêu cầu với record thật được đọc qua Development Session:

```bash
curl -s -X POST 'http://127.0.0.1:3100/__cogover/triggers/order_credit_check' \
  -H 'Content-Type: application/json' \
  --data '{"operation": "update", "recordId": "<record-id>", "changes": {"status": "confirmed"}}'
```

- `operation` là `create`, `update` hoặc `delete`.
- `update` và `delete` đọc record `recordId` của Object mà trigger khai báo,
  giới hạn theo `fields` của trigger, để làm `record.old`. Với `update`,
  `changes` được phủ lên để tạo `record.new`; dùng giá trị đúng như handler cần
  nhìn thấy.
- `create` dựng `record.new` chỉ từ `changes`; record chưa có `id`.
- Gửi `records: [{"recordId": "...", "changes": {...}}, ...]` thay cho dạng rút
  gọn một record để chạy một lần gọi cho tối đa 200 record.

Response gồm `input.records` đúng như handler nhận được, `results` chứa
`changes` và `errors` của từng record theo định dạng handler trả về cho Cogover,
và `warnings`. Runner không đánh giá `when`, `changedFields` hay `runWhen`; nó
ghi vào `warnings` khi Cogover sẽ bỏ qua trigger. Field trong `changes` không
nằm trong `fields` bị bỏ qua và được báo lại.

Handler before-change chỉ được đọc trên Cogover, nhưng Development Session local
không ép buộc điều đó. Khi thử trigger before-change, chạy `cogover-dev run
--allow-writes=false` để một lệnh ghi trong handler cũng thất bại trên local.
Các route dưới `/__cogover/` chỉ tồn tại trên local server.

## Publish và activate

`npm run build` kiểm tra TypeScript trước khi publish; lệnh này không tạo file
nén để upload. Publish thư mục `src/` và activate version đã sẵn sàng:

```bash
npm run build
cogover-dev publish
cogover-dev activate <version-id>
```

Publish và activate yêu cầu Workspace API key. Workspace API key và Project key
là hai loại thông tin xác thực khác nhau, không thể dùng thay thế cho nhau.

## Bảo mật

Không đặt Project key, Workspace API key, session cookie, token hay thông tin
xác thực khác trong source code, `cogover.json`, Git hoặc đối số dòng lệnh.
CLI cho phép nhập key mà không hiển thị lại ký tự đã nhập. Không đưa `.env` và
các file session đã xuất vào Git.

## Cấu trúc project

```text
.
├── cogover.example.json
├── local/
│   ├── cli.ts
│   ├── local-server.ts
│   ├── trigger-runner.ts
│   └── trigger-runner.test.ts
├── src/
├── package.json
├── package-lock.json
└── tsconfig.json
```

## Giấy phép

MIT
