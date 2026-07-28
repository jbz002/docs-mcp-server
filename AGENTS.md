
# docs-mcp-server Agent 指令

## 仓库概览

- **仓库**: `arabold/docs-mcp-server`
- **技术栈**: Node.js 22.x, TypeScript, Vite, AlpineJS, TailwindCSS, SQLite (better-sqlite3)
  - **Node 版本**: 本地开发和构建始终使用 **Node.js v22**，即使 `package.json` 允许更低版本。已安装 nvm 时先执行 `nvm use 22`。
- **工具链**: Biome（lint/格式化）、Vitest（测试）、Husky（pre-commit）
- **必读文档**:
  - 📖 **`README.md`** — 项目结构、安装和配置
  - 🏗️ **`ARCHITECTURE.md`** — 系统设计和组件交互，改代码前必读

## 开发工作流

### 常用命令

| 任务 | 命令 | 说明 |
|------|------|------|
| **安装依赖** | `npm install` | 安装依赖 |
| **构建** | `npm run build` | 构建 server 和 web 资源 |
| **检查** | `npm run lint` | Biome 检查 |
| **自动修复** | `npm run lint:fix` | 自动修复 lint（必要时加 `-- --unsafe`） |
| **类型检查** | `npm run typecheck` | TypeScript 编译器检查 |
| **格式化** | `npm run format` | Biome 格式化 |
| **全量测试** | `npm test` | Vitest 运行所有测试 |
| **单个测试** | `npx vitest run <path>` | 运行指定测试文件（如 `src/utils/foo.test.ts`） |

### Git 工作流

- **分支命名**: `<type>/<issue>-<desc>`（如 `feat/123-add-cache`）
- **Pre-commit**: Husky 执行 lint、typecheck 和测试。**禁止**跳过。
- **安全**: **禁止**提交密钥、凭据或敏感数据（如 `.env`）。

### 依赖管理

- 仅需 `node_modules` 时用 `npm ci`（从 lockfile 安装，不修改 lockfile）。`npm install` 仅用于有意的依赖变更。
- 保持 Node 22 — `better-sqlite3` 绑定 Node-ABI 原生二进制，不要将最低引擎版本提升到 v24+。
- 偶尔使用的 CLI 工具（如 `promptfoo` 搜索评估），通过 `package.json` scripts 中的 `npx -y <pkg>@<version>` 调用，不声明为依赖。

### 提交信息

由 `commitlint` 严格校验，格式错误则提交失败。

- **格式**: `<type>(<scope>): <subject>`（scope 可选但推荐）
- **类型**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
- **subject 规则**:
  - 必须**小写**
  - 末尾**不能**有句号
  - 标题不超过 100 字符
- **Body/Footer**:
  - 与标题用空行分隔
  - 无行长度限制（在 `commitlint.config.js` 中配置）

## 代码风格与规范

### TypeScript
- **严格性**: 禁止 `any`（除非绝对必要），禁止非空断言 `!`。
- **导入**: 全部在顶部，Biome 自动排序。
- **命名**:
  - 类/接口/类型: `PascalCase`
  - 变量/函数/方法: `camelCase`
  - 常量: 全局 `UPPER_SNAKE_CASE`，局部 `camelCase`
- **TSDoc**: 所有导出的函数/类必须写 TSDoc。先写 summary，再写 params/returns。

### 错误处理
- **边界**: API/CLI 边界使用 `try/catch`。
- **日志**: 通过 `logger.error` 记录错误，带 `❌` 前缀。
- **响应**: API 错误返回标准 HTTP 状态码（如 500）。
- **安全**: 对错误日志中的二进制内容做脱敏处理。

### Web UI (AlpineJS + HTMX)
- **组件**: AlpineJS + TSX (`kitajs`)。
- **条件渲染**: 使用三元表达式 `foo ? <Bar/> : null`（避免 `foo && <Bar/>`）。
- **样式**: TailwindCSS 工具类。

## 文档规范

### 目标文件
- `README.md`: 面向用户（安装、配置、使用）
- `ARCHITECTURE.md`: 面向开发者（概念、系统设计）
- `docs/*.md`: 特定子系统的深入文档

### 写作原则
- **语态**: 陈述句，一般现在时。
- **重点**: 写"它做什么"，不写"它不做什么"。
- **图表**: 用 Mermaid 画工作流/状态图。图表标题中不加 markdown 格式。

## 日志策略

- **用户输出**: `console.*`（CLI 结果）。
- **应用事件**: `logger.info`（有意义的状态变更）。
- **调试**: `logger.debug`（细粒度流程，默认关闭）。
- **格式**: 有意义的日志加 emoji 前缀（如 `🔗`, `❌`, `✅`）。**禁止**在 `debug` 日志中使用 emoji。

## 测试策略

### 原则
- **行为驱动**: 测试可观察的契约，不测内部状态。
- **层级**: E2E（价值最高）> 集成 > 单元（仅复杂逻辑）。
- **文件**:
  - **单文件策略**: `src/foo.ts` -> `src/foo.test.ts`。单元测试和集成测试写在同一个文件中。
  - **禁止拆分**: 不要创建单独的 `*.integration.test.ts` 或 `*.spec.ts` 文件。
  - **E2E**: 系统级端到端测试放在 `test/*-e2e.test.ts`。

### 最佳实践
- **环境**: Node 22。使用 `test/setup-env.ts` 处理 polyfill。
- **隔离**: 每个测试只检查**一个**行为。
- **性能**: 单元测试控制在 100ms 以内。
- **Mock**: 谨慎使用 `vi.mock()`，优先使用真实依赖。

### 测试清单

单元 + 集成测试与代码放在一起（`src/foo.ts` ↔ `src/foo.test.ts`）。下表为 `test/` 下的系统级 E2E 测试套件，用 `npx vitest run test/<file>` 运行单个套件。

| 套件 | 覆盖范围 | 前置条件 | 在 `npm test` 中? |
|---|---|---|---|
| `cli-e2e.test.ts` | CLI 冒烟：help、version、未知参数 | 无 | 是 |
| `mcp-stdio-e2e.test.ts` | MCP stdio 协议：spawn、握手、基本工具 | 无 | 是 |
| `mcp-http-e2e.test.ts` | MCP HTTP/SSE（含旧版 `/sse` 端点） | 无 | 是 |
| `auth-e2e.test.ts` | OAuth2/OIDC 对接真实 Provider | `.env` 含 auth 配置；否则跳过 | 是（无配置则跳过） |
| `telemetry-e2e.test.ts` | `DOCS_MCP_TELEMETRY` 环境变量控制 PostHog 初始化 | 无（解析 debug 日志） | 是 |
| `html-pipeline-basic-e2e.test.ts` | HTML 抓取管线（httpbin.org） | 网络 | 是 |
| `html-pipeline-nonhtml-e2e.test.ts` | 非 HTML 内容绕过 Playwright | 无 | 是 |
| `html-pipeline-live-e2e.test.ts` | 真实文档站点抓取（反爬、JS 重） | 网络；慢且不稳定 | **否** — `npm run test:live` |
| `refresh-pipeline-e2e.test.ts` | 刷新处理：200/304/404、断链、etag | 无（mock server） | 是 |
| `archive-integration.test.ts` | `LocalFileStrategy` 归档（zip）遍历和提取 | fixture 归档 | 是 |
| `local-file-pdf-e2e.test.ts` | `file://` 目录下 PDF 与 .txt/.md 一起索引（#394 回归） | Kreuzberg 原生依赖 | 是 |
| `vector-persistence-e2e.test.ts` | Embedding 写入 `documents_vec` 虚拟表 | MSW mock OpenAI | 是 |
| `vector-search-e2e.test.ts` | 全流程：抓取 → 分割 → 嵌入 → 索引 → 搜索 | MSW mock OpenAI | 是 |
| `github-private-repo-e2e.test.ts` | 私有 GitHub 仓库抓取认证流程 | `GITHUB_TOKEN`；否则跳过 | 是（无 token 则跳过） |
| `docker-e2e.test.ts` | 生产镜像：非 root 用户、Chromium、Playwright 抓取、Kreuzberg PDF、bind-mount 文档夹递归索引 | Docker daemon；`DOCKER_IMAGE_TAG` 可复用已有镜像 | **否** — `npm run test:docker` |

备注:
- "live" 和 "docker" 套件需要外部网络或 Docker daemon，排除在 `npm test` / `npm run test:e2e` 之外。CI 在专用 `docker-test` job 中运行 `docker-e2e.test.ts`。
- "优雅跳过"的套件启动时检查所需环境变量，缺失则短路退出，留在默认运行中是安全的。
- 测试固件（PDF、docx、xlsx、归档等）放在 `test/fixtures/`，复用已有固件，不要临时生成。

## Docker 部署（WSL2）

本项目在 WSL2 中以 Docker 容器运行，通过共享网络与 AIHelms 通信栈（LiteLLM 等）互联。

### 服务架构

`docker-compose.yml` 定义三个服务：worker（文档处理，8080）、mcp（MCP 协议端点，6280）、web（管理 UI，6281）。
`docker-compose.wsl.yml` 覆盖层：禁用 web UI（`profiles: [web]`），将 mcp 服务桥接到 `aihelms_default` 外部网络，使 LiteLLM 可通过 `http://docs-mcp-server:6280/sse` 访问。

### 部署命令

**必须从本项目目录部署**，build 需要 Dockerfile。禁止使用 `AIHelms/docker/docs-mcp-server.yml`（单容器模式，缺少独立 worker）。

前置条件：AIHelms middleware compose 必须先运行（创建 `aihelms_default` 网络）：
```bash
# AIHelms 目录
docker compose -f docker-compose.middleware.yaml -p aihelms up -d
```

本项目的部署和更新：
```bash
# WSL2 中，本项目目录下
cd /mnt/d/project/docs-mcp-server
docker compose -f docker-compose.yml -f docker-compose.wsl.yml up -d --build
```

### 快速热更新（仅代码变更）

仅改 `src/` 时跳过 Docker build：本地编译，cp 进三个容器（文件系统独立，需各自 cp），秒级生效。

```bash
npm run build   # Windows 侧编译，Vite 缓存加速
wsl bash -lc 'docker cp /mnt/d/project/docs-mcp-server/dist/. docs-mcp-server:/app/dist/ && docker cp /mnt/d/project/docs-mcp-server/public/. docs-mcp-server:/app/public/ && docker cp /mnt/d/project/docs-mcp-server/dist/. docs-mcp-web:/app/dist/ && docker cp /mnt/d/project/docs-mcp-server/public/. docs-mcp-web:/app/public/ && docker cp /mnt/d/project/docs-mcp-server/dist/. docs-mcp-worker:/app/dist/ && docker cp /mnt/d/project/docs-mcp-server/public/. docs-mcp-worker:/app/public/ && docker restart docs-mcp-server docs-mcp-web docs-mcp-worker'
```

**避坑**（从 Windows Git Bash 经 `wsl` 调用 Docker 时）：
- **必须 `-l`（login shell）**：`bash -lc` 而非 `bash -c`，否则 WSL PATH 不含 `docker`，报 `command not found`。
- **禁用 `$c` 循环变量**：`for c in ...; do ... $c ...` 中的 `$c` 经 `wsl bash -lc '...'` 调用层时被吞成空，导致 `docker cp` 报 `must specify at least one container source`。逐容器显式 `docker cp` 写全路径。
- 其余 `docker compose`/`docker ps` 命令假设已在 WSL shell 内运行（PATH 自带 docker），无需 `wsl` 前缀。

**注意**：修改 `package.json`（依赖变更）、`Dockerfile`、`db/` 等非 `src/` 文件时，仍需完整 Docker build。

停止（不影响 AIHelms）：
```bash
docker compose -f docker-compose.yml -f docker-compose.wsl.yml down
```

### 验证

```bash
# 容器健康检查
docker ps --filter "name=docs-mcp"

# 从 LiteLLM 容器测试 MCP 连通性（预期输出 200）
docker exec aihelms-litellm-1 python -c "import urllib.request; print(urllib.request.urlopen('http://docs-mcp-server:6280/sse', timeout=5).status)"
```
