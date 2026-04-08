# MskDSP Upper

`MskDSP Upper` 是 `MskDSP` 的上位机项目，采用 `React + Vite + Tauri` 实现桌面控制台。

前端页面通过 Tauri IPC 调用 Rust 后端命令，Rust 侧再通过 gRPC 连接 `ModuleManager`、`DataCenter`、`IEC104`、`ModbusRTU`、`DLT645`、`AGC` 等服务。

## 仓库结构

- `src/`: React 前端页面与适配层
- `src-tauri/`: Tauri/Rust 后端、gRPC 客户端与桌面配置
- `proto/`: 协议定义 submodule，构建时由 `build.rs` 生成 Rust gRPC client

## 首次拉取

推荐直接递归拉取：

```bash
git clone --recurse-submodules <upper-repo-url>
```

如果已经完成普通克隆，请在仓库根目录执行：

```bash
git submodule update --init --recursive
```

如果没有初始化 `proto` submodule，`src-tauri/build.rs` 会直接报错并提示补齐 submodule。

## 开发

安装 Node 依赖：

```bash
npm install
```

启动前端开发服务器：

```bash
npm run dev
```

启动 Tauri 桌面应用：

```bash
npx tauri dev
```

构建前端产物：

```bash
npm run build
```

运行 workflow helper 测试：

```bash
npm run test:workflow
```

执行最小 CI Debug 校验链路：

```bash
npm run ci:debug
```

## 打包与发布

- GitHub Actions / 发布渠道 / 命名约定：
  - [doc/GitHub-Actions与发版策略.md](doc/GitHub-Actions与发版策略.md)
- 本地打包 / 交付 / 安装 / 升级说明：
  - [doc/打包与交付说明.md](doc/打包与交付说明.md)
- 构建元数据契约：
  - [scripts/workflow/schema/build-metadata.schema.json](scripts/workflow/schema/build-metadata.schema.json)

## 运行依赖

- 默认连接 `ModuleManager` 地址：`127.0.0.1:7000`
- `upper` 已不再依赖仓库外部兄弟目录 `MskDSPProto`
- `upper` 运行时仍依赖 `MskDSP` 提供的 gRPC 服务；如果后端未启动，页面会表现为连接失败或接口报错
