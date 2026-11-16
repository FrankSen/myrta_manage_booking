# 实现计划：独立应用（Electron）

设计：`docs/specs/2026-11-16-electron-app-design.md`。分支 `feat/electron-app`。每个任务完成后 `npm test`、`npm run typecheck` 通过再提交。

| # | 任务 | 主要文件 | 状态 |
|---|---|---|---|
| 1 | 学员上限 5、考点上限 2、预计刷新时间 | `config/settings.ts`、`ui/validate.ts`、`config/interval.ts`、`ui/server.ts`、前端 | 完成 |
| 2 | 添加学员复用 probe 目录 | `app/start.ts`、`ui/server.ts` | 完成 |
| 3 | 授权：签名校验、到期、时间回调；生成脚本 | `license/*.ts`、`scripts/license.ts`、`app/start.ts`、`ui/server.ts`、`engine/service.ts` | 完成 |
| 4 | 中英文：翻译表、状态与记录存代码、悉尼时间显示 | `i18n/*`、`engine/checker.ts`、`domain/matcher.ts`、`storage/*`、`notify/notifier.ts`、`ui/*` | 完成 |
| 5 | Electron 主进程：窗口、退出确认、通知、单实例、数据目录、快捷方式 | `electron/main.ts`、`app/start.ts` | 完成 |
| 6 | 打包：Electron 二进制、图标、Info.plist、zip 符号链接 | `scripts/build.ts`、`scripts/zip.ts`、`scripts/icons.ts`、`assets/` | 完成 |
| 7 | 文档：中英文使用手册、iOA 白名单、升级步骤、交接说明 | `docs/*` | 完成 |
| 8 | 联网验证（Mac 包）与 Chrome 最小化实测 | — | |

## 测试运行
- Node 24：`npm test`
- Electron 内置 Node 22：`npm run test:electron`（`ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`）

## 依赖
- `electron@38.7.2`（开发依赖，`ELECTRON_SKIP_BINARY_DOWNLOAD=1` 安装；二进制由 `scripts/electron-bin.ts` 从缓存或 npmmirror 取并校验）
- `resedit`（开发依赖，Windows exe 图标与版本信息）
