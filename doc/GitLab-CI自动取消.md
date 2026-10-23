# GitLab CI 自动取消

上位机只对 `main` 的 push/web 创建 CI。新提交到来时，自动取消旧流水线中尚未完成的校验、打包作业，已开始的发布作业继续执行。

- `workflow.auto_cancel.on_new_commit: interruptible` 显式启用按作业取消。
- `upper-ci` 校验并打包，设置 `interruptible: true`；环境使用 `ci` 的 `prepare` 动作，保留环境变量作用域且不创建部署记录。
- `upper-publish` 设置 `interruptible: false`，仅在同一流水线的 `upper-ci` 成功后，通过 `needs` 下载冻结安装包、元数据和日志，再执行平台发布。重新导入 Runner 环境，不重新编译。
- 两个作业共用 `upper-ci-publish` 资源组，保持共享编译目录及发布过程串行。保留原 Git 清理策略，取消后下次检出会恢复源码并清除残余打包文件。
- 发布仍校验冻结产物的流水线、源码、SHA256，并在发布前检查远端主分支，拒绝旧构建覆盖新版本。

验证使用 GitLab CI Lint 模拟流水线，确认作业依赖、取消标志、环境动作和资源组；运行现有 `tests/gitlab` 回归及差异检查。推送后核对新流水线采用两个作业。旧流水线保留创建时的配置，不能追溯获得自动取消能力。
