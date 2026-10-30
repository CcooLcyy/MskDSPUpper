# CI 测试运行器反序列化修复

## 原始失败与依据

- 提交 `a039c9e` 的 [流水线 210](http://192.168.10.198:8929/mskdsp/mskdspupper/-/pipelines/210)、作业 884 保留原始失败记录。workflow 为 620 通过、1 失败、10 跳过；Rust 为 414 通过，未进入打包和发布。
- `security-admin.test.mjs` 由 Node 内部 `FileTest.parseMessage` 报出 `Unable to deserialize cloned data due to invalid or unsupported version.`，本地单独运行其 18 个用例通过，前一条流水线 209 成功。
- 堆栈与 [Node 官方问题 64061](https://github.com/nodejs/node/issues/64061) 一致。非 ASCII 标准输出与报告消息合并读取时，消息长度可能按有符号整数解析；[官方修复 64706](https://github.com/nodejs/node/pull/64706) 转为无符号长度。[24.20.0](https://nodejs.org/en/blog/release/v24.20.0) 首次在 24.x 包含该修复。

## 范围与方案

- 仅修复 GitLab Windows 校验及打包作业的 Node 运行环境，不修改测试断言、被测组件、并发方式或中文日志，不加自动重试，也不改失败退出码。
- 使用固定 [Node 24.22.2 LTS](https://nodejs.org/en/blog/release/v24.22.2) 官方 Windows x64 便携包，SHA256 为 `ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2`。
- 下载、完整性检查及安全解压均成功后才启用缓存；失败终止作业，不回退旧版。后续作业复用缓存前校验实际文件及版本。
- 优先缓存到 `RUNNER_ENV_ROOT/cache/mskdsp-upper-node`；未配置环境根时使用作业工作区 `.ci-tools/node`。只调整当前 PowerShell 作业进程的 PATH，不安装全局工具、不覆盖既有 Node。
- MSVC 环境导入后准备 Node；verify 和 package 都显式启用相同版本。日志记录版本、路径与缓存来源，原有 Node/npm 身份校验会使旧依赖缓存失效并重新锁定安装。
- 两个校验分支必须原样完成，全部成功才进入打包发布；工具链准备失败时两个分支均不得启动。

## 验收

1. 工具准备单元测试覆盖首次下载、缓存复用、包校验失败、失效缓存和不安全 ZIP；失败不得产生可复用安装。
2. PowerShell 集成测试验证 Node 在依赖、workflow 和打包前启用，准备失败阻止测试及发布；保留原有并行、退出码和清理断言。
3. 使用旧版及固定新版运行同一最小复现，并在固定新版运行原 workflow/offline 测试；保留原始失败记录。
4. 推送后读取新流水线的实际版本、测试与发布结果，不将本地通过当作 CI 已通过。

## 本地验证记录

- 官方 Node 24.10.0 Windows x64 可执行文件经官网 SHA256 验证后，运行中文输出探针一次即复现原始反序列化错误，退出码 1；日志保留在任务临时目录。
- 固定 Node 24.22.2 通过完全相同探针，1 通过、0 失败；真实便携包首次下载及再次完整校验复用均通过。
- 使用固定 Node 执行原 workflow 646/646、offline 110/110 和严格 lint，通过；45 项 Python CI 脚本回归通过。
- 原 `security-admin.test.mjs` 的 18 项用例、中文日志及所有断言保持不变。
