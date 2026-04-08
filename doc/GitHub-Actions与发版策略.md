# GitHub Actions 与发版策略

## 目标

- 建立一套与 `mskdsp` workflow 等价、但适配当前 `React + Vite + Tauri + Rust` 技术栈的研发与发版流程。
- 将开发校验、Nightly、Beta、Stable 四条渠道统一到同一套命名、缓存、staging、交付与验收约定下。
- 让构建、打包、校验、预发布、正式发布都能通过仓库内脚本与 GitHub Actions 复用同一条真实链路。

## 范围与非目标

### 范围

- 仓库内文档、脚本、GitHub Actions workflow、staging/package 目录约定。
- 版本元数据、Beta 版本线解析、Stable 来源校验、子模块访问、缓存、诊断物上传。
- Windows x64 Tauri 安装包、交付 zip、debug symbols 包、校验文件。

### 非目标

- 不引入与当前项目不匹配的 `CMake`、`vcpkg`、Linux system package、Docker 镜像链路。
- 不重写现有页面、业务逻辑或 `proto` 契约。
- 不将当前仓库强行改造成多平台矩阵仓库；当前发布架构以 `Windows x64` 为准。

## 输入输出

### 输入

- 根目录 [package.json](../package.json) 版本。
- [src-tauri/Cargo.toml](../src-tauri/Cargo.toml) 与 [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json)。
- [package-lock.json](../package-lock.json)、[src-tauri/Cargo.lock](../src-tauri/Cargo.lock)。
- `proto/` submodule commit。
- GitHub Actions 触发上下文：分支、tag、SHA、时间戳、可选 secrets。

### 输出

- `package/staging/<channel>/<platform>/` 统一 staging 目录。
- `package/out/<channel>/<platform>/` 最终交付目录。
- Tauri 安装包、交付 zip、symbols 包、`SHA256SUMS`。
- GitHub Artifact、GitHub prerelease、GitHub Release。

## 接口 / 协议

- 构建元数据契约：
  - [scripts/workflow/schema/build-metadata.schema.json](../scripts/workflow/schema/build-metadata.schema.json)
- 关键脚本：
  - `scripts/workflow/emit-build-metadata.mjs`
  - `scripts/workflow/apply-channel-version.mjs`
  - `scripts/workflow/render-tauri-config.mjs`
  - `scripts/workflow/stage-release.mjs`
  - `scripts/workflow/create-delivery-bundle.mjs`
  - `scripts/workflow/write-sha256sums.mjs`
  - `scripts/workflow/resolve-beta-ref.mjs`
  - `scripts/workflow/verify-beta-lineage.mjs`

## 配置项

| 配置项 | 作用 | 默认值 |
| --- | --- | --- |
| `SUBMODULE_TOKEN` | 访问私有 submodule 的 PAT | 空 |
| `SUBMODULE_SSH_KEY` | submodule SSH key 回退 | 空 |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater 签名私钥 | 空 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Tauri updater 私钥口令 | 空 |
| `MSKDSP_UPPER_SOURCEMAP` | 是否产出前端 sourcemap | `false` |
| `beta_ref` | Beta workflow 手动指定版本线 | 空 |
| `threshold_hours` | Auto Promote workflow 的空窗阈值 | `72` |

## 统一实现约定

### 渠道与分支模型

- `CI`
  - 触发 `pull_request`、`push main/master/beta/**`
  - 输出 Debug 校验结果与主线测试交付包
- `Nightly`
  - 固定基于默认分支
  - 每日或手动重建最新包
- `Beta`
  - 固定基于 `beta/x.y` 或 `beta/x.y.z`
  - 同一版本线默认只保留当前最新 prerelease
- `Stable`
  - 固定基于 `v*` tag
  - 必须由 `beta/*` 版本线演进而来
  - 默认支持“beta 分支 3 天无更新自动晋升 stable”

### 命名规则

- 统一字段：
  - 项目标识：`mskdsp-upper`
  - 版本：基础版本或带渠道后缀的 `effectiveVersion`
  - 渠道：`ci`、`nightly`、`beta-x.y`、`stable`
  - 时间戳：`YYYYMMDDtHHMMSSz`
  - 短 SHA：7 位
  - 平台：`windows-x64`
- 统一文件名基底：
  - `${project}-${effectiveVersion}-${channel}-${timestamp}-${sha}-${platform}`

### staging / package 目录

- `package/staging/<channel>/<platform>/app`
  - 安装包、updater 元数据、可执行文件、`dist/`
- `package/staging/<channel>/<platform>/symbols`
  - `.pdb` 与前端 `.map`
- `package/staging/<channel>/<platform>/diagnostics`
  - 构建日志、锁文件、配置、submodule 状态、staging manifest
- `package/out/<channel>/<platform>`
  - 最终交付 zip、symbols zip、校验文件、原始安装包

## 研发流程

1. 先更新文档和契约，再进入实现。
2. 新增 workflow/helper 时，先补脚本级测试，再补实现。
3. 所有新增关键脚本都输出结构化日志，失败时可生成最小诊断集合。
4. 文档、脚本、workflow 三者保持同一套命名和目录约定。

## 各 workflow 摘要

### CI

- 触发：
  - `pull_request`
  - `push main`
  - `push master`
  - `push beta/**`
- 行为：
  - 安装 Node、Rust、protoc
  - 准备 submodule 访问并拉取 `proto/`
  - 运行 `npm run test:workflow`
  - 运行 `npm run lint`
  - 运行 `cargo test --locked --manifest-path src-tauri/Cargo.toml`
  - 运行 `npx tauri build --debug --no-bundle`
  - 失败时上传 diagnostics
  - `push main/master` 时继续打包 `ci` 渠道交付包并上传 artifact

### Nightly

- 触发：
  - `schedule`
  - `workflow_dispatch`
- 行为：
  - 始终 checkout 默认分支
  - 使用 nightly 渠道版本后缀
  - 生成安装包、symbols 包、校验文件
  - 上传 artifact

### Beta

- 触发：
  - `push beta/**`
  - `schedule`
  - `workflow_dispatch`
- 行为：
  - 解析目标 beta 版本线
  - 先跑 Debug 校验
  - 再做 Release 打包与 staging
  - 上传 artifact
  - 清理同版本线旧 prerelease
  - 创建当前最新 prerelease
  - 若存在最近 stable tag，则以其为 release notes 基线

### Release

- 触发：
  - `push tags v*`
- 行为：
  - 跑发布前 Debug 校验
  - 校验 tag 对应提交属于某条 `beta/*`
  - 生成正式安装包、symbols 包、校验文件
  - 创建或更新 GitHub Release

### Promote Stable

- 触发：
  - `schedule`
  - `workflow_dispatch`
- 行为：
  - 扫描 `beta/*` 分支最近一次提交时间
  - 若某条 beta 线 3 天无更新，且 `package.json` 版本与 beta 线匹配、对应 `v*` tag 尚不存在，则自动创建 stable tag
  - stable tag 创建后由 `release.yml` 接手正式打包与发布

## 依赖缓存策略

- Node 依赖缓存：
  - `actions/setup-node` + `package-lock.json`
- Cargo 依赖缓存：
  - `Cargo.lock` 驱动的 registry/git 缓存
- 编译缓存：
  - `sccache`
  - key 包含 `Cargo.lock`、`Cargo.toml`、`tauri.conf.json`、`package.json`、workflow 文件

## 私有依赖 / 子模块访问方式

- checkout 不直接带 submodule。
- 先执行 [scripts/workflow/Prepare-SubmoduleAccess.ps1](../scripts/workflow/Prepare-SubmoduleAccess.ps1)。
- 再执行 `git submodule update --init --recursive`。
- 凭据优先级：
  - `SUBMODULE_TOKEN`
  - `SUBMODULE_SSH_KEY`
  - 匿名 HTTPS

## 调试符号策略

- 当前项目原生支持 Windows `.pdb`。
- Nightly / Beta / Stable 默认单独产出 symbols 包。
- 前端调试信息通过 `MSKDSP_UPPER_SOURCEMAP=true` 生成 `.map` 并并入 symbols 包。

## 约束与异常场景

- 缺失 `proto/` submodule 时，Rust 构建失败。
- 未配置 Tauri 签名私钥时，workflow 仍会产出安装包与 checksum，但 updater 元数据会按 `auto` 策略关闭。
- 当前仓库没有 Docker 化部署载体，因此交付形式采用 `NSIS 安装包 + 交付 zip`。

## Hotfix 维护线建议

- 若需要 hotfix，建议从最近 stable tag 切 `hotfix/x.y.z`。
- 修复完成后先合回对应 `beta/*`，再打新的 stable tag。
- 不建议直接绕过 beta 线打正式 tag。

## Beta 自动晋升约束

- 自动晋升窗口默认 3 天，可在手动触发时覆盖。
- 只会晋升 `package.json` 为稳定三段式版本号的 beta 分支，例如 `0.1.0`。
- `beta/0.1` 允许对应 `0.1.z`，`beta/0.1.0` 只允许对应精确的 `0.1.0`。
- 若对应 `vX.Y.Z` 已存在，则不会重复打 tag。

## 验收标准

- 四条 workflow 文件可在仓库中直接运行。
- `npm run test:workflow`、`npm run lint`、`cargo test --locked --manifest-path src-tauri/Cargo.toml` 可作为最小校验链路。
- 任一打包渠道都能产出：
  - 安装包或等价交付包
  - debug symbols 包
  - 校验文件
  - diagnostics
