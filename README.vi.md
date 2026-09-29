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

Ngoài default export (HTTP route), `src/main.ts` có thể liệt kê record trigger
trong named export `triggers` và Custom Module Action trong named export
`actions`. Default export là tùy chọn khi Project có trigger hoặc action.

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
chạy local server như trên. Khi khởi động, server in ra danh sách key của
trigger; `GET /__cogover/triggers` liệt kê các trigger cùng cấu hình đã chuẩn hóa.

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
- Giá trị lookup mà runner đọc từ bản ghi đã lưu có `name: ""`, vì lệnh đọc
  không tra cứu record liên kết; trên Cogover, lookup trong `record.old` và
  `record.new` có sẵn tên. Muốn thử code dùng tên này, đưa lookup vào `changes`
  dưới dạng `{"id": "...", "name": "..."}`.
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

## Cho Process và AI Agent gọi action

Custom Module Action là một thao tác ngắn của Project mà Process hoặc AI Agent
của Cogover gọi tới. Khai báo action bằng `defineAction` của `@cogover/sdk`
0.15.0 trở lên, mô tả input và output bằng bộ dựng schema `s`, rồi đưa vào named
export `actions` của `src/main.ts`:

```typescript
import { defineAction, s } from "@cogover/sdk";

export const actions = [
  defineAction({
    key: "check_credit",
    label: "Check customer credit",
    description: "Returns whether an account can buy the given amount on credit.",
    exposeTo: ["process", "agent"],
    effect: "read",
    input: s.object({
      accountId: s.recordId("account").describe("ID of the customer account"),
      amount: s.number({ minimum: 0 }).describe("Order amount"),
    }),
    output: s.object({
      allowed: s.boolean(),
      reason: s.enum(["ok", "limit_exceeded", "account_not_found"]),
    }),
    async handler({ data }, input) {
      const account = await data.object("account").records.get(input.accountId, {
        fields: ["credit_limit", "credit_used"],
      });
      if (!account) return { allowed: false, reason: "account_not_found" };
      const remaining = Number(account.fields.credit_limit ?? 0) - Number(account.fields.credit_used ?? 0);
      const allowed = input.amount <= remaining;
      return { allowed, reason: allowed ? "ok" : "limit_exceeded" };
    },
  }),
];
```

- Sau khi publish và activate version, Process Builder hiển thị mỗi action có
  `exposeTo` chứa `"process"` thành một node **Custom Module Action**, còn AI Agent
  Builder hiển thị mỗi action có `"agent"` thành một tool thuộc nhóm
  **Custom Module**. Chúng gọi version đang active theo slug của Project và `key`
  của action, vì vậy giữ `key` ổn định giữa các version.
- Action dành cho AI Agent cần có `description`; agent cũng đọc các đoạn
  `describe` của input để điền input.
- `effect: "read"` chạy action ở chế độ chỉ đọc trên Cogover. Action `"write"`
  được phép thay đổi dữ liệu, và mặc định tool AI Agent của nó cần một người
  duyệt trước khi chạy.
- Cogover kiểm tra input trước khi handler chạy và kiểm tra output sau khi
  handler trả về. Bên gọi chỉ nhận mã lỗi và một thông báo cố định khi handler
  ném lỗi, vì vậy hãy trả các kết quả dự kiến trong output, như `reason` ở trên.
- Node Process hoặc AI Agent quyết định action chạy dưới danh tính nào. Lời gọi
  không có user cần `allowInternalSystem: true` trong identity policy đã duyệt
  của version đang active.
- Action có ngân sách của một HTTP route và chạy tối đa `timeoutMs` mili giây
  (1000 đến 8000, mặc định 8000). Việc dài hơn hãy chuyển sang background job
  bằng `jobs.enqueue`, dùng `action.runId` làm idempotency key.

Bảng tùy chọn, quy tắc schema và mã lỗi nằm trong tài liệu Custom Module Action
của SDK, `node_modules/@cogover/sdk/docs/en/api-reference/actions.md`, còn
`processes.start` và `agents.start` nằm trong
`node_modules/@cogover/sdk/docs/en/api-reference/processes-and-agents.md`.

## Chạy action trên local

Process và AI Agent chỉ gọi version đã publish và đang active. Để debug một
action trước khi publish, khởi chạy local server như trên. Khi khởi động, server
in ra danh sách key của action; `GET /__cogover/actions` liệt kê các action cùng
cấu hình đã chuẩn hóa, gồm cả JSON Schema của input và output.

Gọi một action giống như node Process hoặc AI Agent gọi:

```bash
curl -s -X POST 'http://127.0.0.1:3100/__cogover/actions/check_credit' \
  -H 'Content-Type: application/json' \
  --data '{"input": {"accountId": "<record-id>", "amount": 1200}}'
```

- `input` là bắt buộc: input của action đúng như bên gọi gửi.
- `source` là tùy chọn: `{"type": "process"}` hoặc `{"type": "agent"}`, kèm bất kỳ
  field nào của `invocation.source` (ví dụ `"runAs": "PERSONNEL"` hoặc
  `"interactive": true`). Field bị thiếu nhận giá trị giữ chỗ local;
  `initiatorPersonnelId` của nguồn agent mặc định là người gọi của Development
  Session. Khi không có `source`, runner dùng phần tử đầu tiên của `exposeTo`.
  Loại nguồn mà action không mở cho sẽ bị từ chối với HTTP 403
  `ACTION_NOT_EXPOSED`.
- `runId` là tùy chọn; nếu không gửi, runner tạo mới. Gửi lại cùng giá trị để
  thử code dùng `action.runId` làm idempotency key.

Response có HTTP status 200 mỗi khi action đã chạy, kể cả khi thất bại. Response
gồm `status` (`COMPLETED` hoặc `FAILED`), `output`, và `error` với `code`,
`message`, `details` đúng như node Process hoặc AI Agent nhận được, cùng `input`
đúng như handler nhận được, `action` (`key`, `effect`, `runId`, `source`),
`durationMs` và `warnings`. Key action không tồn tại trả về 404, body request
không hợp lệ trả về 400.

Giống Cogover, runner kiểm tra input theo schema `input` trước khi handler chạy
(`INPUT_INVALID`, handler không chạy) và kiểm tra output theo schema `output` sau
khi handler trả về (`OUTPUT_INVALID`), ngừng chờ sau `timeoutMs` (`TIMEOUT`), và
báo lỗi do handler ném ra bằng mã và thông báo cố định mà bên gọi nhận được:
`SCRIPT_ERROR` kèm `details.scriptErrorCode`, `PERMISSION_DENIED` hoặc
`RATE_LIMITED`. Terminal của local server hiển thị stack của lỗi không dự kiến.
`cogover-dev run` áp dụng ngân sách của HTTP route cho mỗi lần gọi.

Lời gọi local khác Cogover ở các điểm sau:

- Action luôn chạy dưới danh tính người gọi của Development Session, bất kể
  `runAs` hay danh tính agent mà Cogover sẽ dùng; runner thêm cảnh báo khi
  `runAs` là `"SYSTEM"`.
- Cogover từ chối lệnh ghi và các tác động phụ khác trong action `"read"`;
  Development Session local thì không. Khi thử action chỉ đọc, chạy
  `cogover-dev run --allow-writes=false` để lệnh ghi cũng thất bại trên local.
- Cogover trả lại kết quả đã lưu khi bên gọi gửi lại một `runId` đã hoàn tất, từ
  chối `runId` dùng lại với input khác và chặn vòng lặp bằng `MAX_HOP_EXCEEDED`;
  runner local không làm những việc này.
- Sau `TIMEOUT`, handler có thể vẫn đang chạy trên local; Cogover thì dừng nó.
- `processes.start` và `agents.start` khởi chạy lượt chạy thật từ Development
  Session cho phép ghi, nhưng lời gọi có truyền `onComplete` hoặc `onResult` bị
  từ chối với `NOT_SUPPORTED`: các job đó chỉ chạy trong version đã publish, vì
  vậy hãy thử chúng sau khi publish.

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
│   ├── action-runner.ts
│   ├── action-runner.test.ts
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
