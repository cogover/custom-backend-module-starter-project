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
│   └── local-server.ts
├── src/
├── package.json
├── package-lock.json
└── tsconfig.json
```

## Giấy phép

MIT
