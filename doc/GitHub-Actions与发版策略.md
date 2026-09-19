# GitHub Actions 与发版策略

## 目标

- 建立一套与 `mskdsp` workflow 等价、但适配当前 `React + Vite + Tauri + Rust` 技术栈的研发与发版流程。
- 将开发校验、Beta、Stable 三条渠道统一到同一套命名、缓存、staging、交付与验收约定下。
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
  - `scripts/workflow/rewrite-static-updater-manifest.mjs`
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
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Tauri updater 私钥口令，可留空 | 空 |
| `R2_ACCOUNT_ID` | Cloudflare R2 账户 ID（secret） | 必填 |
| `R2_ACCESS_KEY_ID` | R2 访问密钥 ID（secret） | 必填 |
| `R2_SECRET_ACCESS_KEY` | R2 访问密钥（secret） | 必填 |
| `R2_BUCKET` | R2 桶名（variable，可留空走默认） | `mskdsp-update` |
| `R2_PREFIX` | R2 对象前缀（variable，可留空走默认） | `mskdsp-upper` |
| `R2_PUBLIC_BASE_URL` | R2 公网基地址（variable，可留空走默认） | `https://pub-19f3d71852b04011b120b1b814141c12.r2.dev` |
| `MSKDSP_UPPER_SOURCEMAP` | 是否产出前端 sourcemap | `false` |
| `beta_ref` | Beta workflow 手动指定版本线 | 空 |

## 统一实现约定

### 渠道与分支模型

- `CI`
  - 触发 `pull_request`、`push main`
  - PR 输出一次 Debug Tauri 校验结果；`push main` 在基础校验通过后只执行一次 Release Tauri 构建，输出主线测试交付包并同步到静态源 `ci` 通道
- `Beta`
  - 固定基于 `beta/x.y` 或 `beta/x.y.z`
  - 同一版本线默认只保留当前最新 prerelease
- `Stable`
  - 固定基于 `v*` tag
  - 必须由 `beta/*` 版本线演进而来
  - 正式版只能由手动推送 `v*` tag 触发（自动晋升已移除）

### 命名规则

- 统一字段：
  - 项目标识：`mskdsp-upper`
  - 版本：基础版本或带渠道后缀的 `effectiveVersion`
  - 渠道：`ci`、`beta-x.y`、`stable`
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
- 静态更新源（Cloudflare R2 桶 `<R2_BUCKET>`、前缀 `<R2_PREFIX>`）：
  - 对象键 `<R2_PREFIX>/<channel>/latest.json`
  - 对象键 `<R2_PREFIX>/<channel>/<platform>/` 下保存安装包、签名、交付包、symbols 包与校验文件
  - 对应公网地址为 `<R2_PUBLIC_BASE_URL>/<R2_PREFIX>/<channel>/latest.json` 与 `<R2_PUBLIC_BASE_URL>/<R2_PREFIX>/<channel>/<platform>/<asset>`

## 静态更新源同步

- CI / Beta / Stable 在生成 `package/out` 后调用 `scripts/workflow/Publish-R2StaticUpdater.ps1` 上传到 R2 静态源。
- 同步顺序固定为先上传安装包、签名、交付包、symbols 包与校验文件，再最后覆盖 `latest.json`。
- `latest.json` 中的 `platforms.*.url` 由 `stage-release.mjs --asset-base-url` 生成，指向静态源 `<channel>/<platform>/` 下的安装包。
- 若 GitHub Release 资产已经存在，但静态源为空或需要完整重同步，可手动运行 `Sync Static Updater Source`。
  它会下载指定 release 的所有资产，用 `rewrite-static-updater-manifest.mjs` 将 `latest.json` 的下载地址改写为静态源地址，再调用同一个上传脚本同步。
- 静态源现已托管在 Cloudflare R2，上传后不需要任何服务器操作（旧的 nginx/SSH 静态服务器链路已停用）。
- 发布仍会更新 GitHub Release。由于静态源同步发生在 GitHub Release 上传前，旧客户端即使从 GitHub endpoint 读取新的 `latest.json`，也能下载已经同步到静态源的安装包。

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
- 行为：
  - 安装 Node、Rust、protoc
  - 准备 submodule 访问并拉取 `proto/`
  - 运行 `npm run test:workflow`
  - 运行 `npm run lint`
  - 运行 `cargo test --locked --lib --manifest-path src-tauri/Cargo.toml`
  - PR 只跑上面的 verify-debug，不产出安装包
  - `push main` 时 verify-debug 与 package-build 并行执行，package-build 只做一次 Release Tauri 构建
  - 失败时上传 diagnostics
  - `push main` 时把交付包上传 artifact，并在 publish 中校验产物来源后同步到 `<R2_PUBLIC_BASE_URL>/mskdsp-upper/ci/latest.json`

### Beta

- 触发：
  - `push beta/**`
  - `schedule`
  - `workflow_dispatch`
- 行为：
  - 解析目标 beta 版本线
  - 先运行 workflow tests、lint 和 Cargo tests
  - 再做一次 Release 打包与 staging
  - 上传 artifact
  - 清理同版本线旧 prerelease
  - 创建当前最新 prerelease
  - 若存在最近 stable tag，则以其为 release notes 基线

### Release

- 触发：
  - `push tags v*`
- 行为：
  - 运行 workflow tests、lint 和 Cargo tests
  - 校验 tag 对应提交属于某条 `beta/*`
  - 生成正式安装包、symbols 包、校验文件
  - 创建或更新 GitHub Release

### Sync Static Updater Source

- 触发：
  - `workflow_dispatch`
- 输入：
  - `channel`: `stable` 或 `beta`
  - `release_tag`: 可选；默认 stable 使用 `v<package.json version>`，beta 使用 `beta-latest`
  - `platform`: 可选；默认 `windows-x64`
- 行为：
  - 下载指定 GitHub Release 的全部资产
  - 校验 `latest.json` 与 updater 资产存在
  - 将 `latest.json` 的 `platforms.*.url` 改写到静态源
  - 先上传资产，最后上传 `latest.json`

## 依赖缓存策略

- Node 依赖缓存：
  - `actions/setup-node` + `package-lock.json`
- Cargo 依赖缓存：
  - `Cargo.lock` 驱动的 registry/git 缓存
- 编译缓存：
  - `mozilla-actions/sccache-action@v0.0.10`
  - 通过 `SCCACHE_GHA_ENABLED=true` 使用 GitHub Actions cache backend
  - `SCCACHE_GHA_VERSION=mskdsp-upper-windows-msvc-v1` 作为共享命名空间，CI / Beta / Release 复用同一类编译缓存
  - 不再把 `github.sha` 放入编译缓存维度，避免每个 commit 生成彼此隔离的 `.sccache` 缓存包
  - `Swatinem/rust-cache` 同时缓存 Cargo registry/git 依赖和依赖类 `src-tauri/target` 产物（`cache-targets: true`）；CI/Beta 的 verify 与 package Job 使用独立 shared key，分别保留 test 与 release profile 的依赖缓存，避免前一个 Job 的缓存阻止后一个 Job 保存更新
  - `rust-cache` 默认不保存 workspace crate；上位机自身源码和最终链接仍由 Cargo/Tauri 在对应 profile 中重新生成，Rust 编译结果由共享 sccache 跨 Job、跨 profile 补充复用
  - 每个 Rust job 在缓存步骤后输出 `cache-hit`，并在构建结束输出 sccache 命中统计，便于区分依赖缓存和编译缓存问题
  - 每个 Rust/Tauri 构建 job 结束时执行 [scripts/workflow/Show-SccacheStats.ps1](../scripts/workflow/Show-SccacheStats.ps1)，输出命中率用于评估提速效果

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
- Beta / Stable 默认单独产出 symbols 包。
- 前端调试信息通过 `MSKDSP_UPPER_SOURCEMAP=true` 生成 `.map` 并并入 symbols 包。

## 约束与异常场景

- 缺失 `proto/` submodule 时，Rust 构建失败。
- 未配置 Tauri 签名私钥时，workflow 仍会产出安装包与 checksum，但 updater 元数据会按 `auto` 策略关闭。
- 当前仓库没有 Docker 化部署载体，因此交付形式采用 `NSIS 安装包 + 交付 zip`。

## Hotfix 维护线建议

- 若需要 hotfix，建议从最近 stable tag 切 `hotfix/x.y.z`。
- 修复完成后先合回对应 `beta/*`，再打新的 stable tag。
- 不建议直接绕过 beta 线打正式 tag。

## 验收标准

- 四条 workflow 文件可在仓库中直接运行。
- `npm run test:workflow`、`npm run lint`、`cargo test --locked --manifest-path src-tauri/Cargo.toml` 可作为最小校验链路。
- 任一打包渠道都能产出：
  - 安装包或等价交付包
  - debug symbols 包
  - 校验文件
  - diagnostics
