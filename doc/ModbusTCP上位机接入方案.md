# ModbusTCP 上位机接入方案

## 目标

- 为独立的下位机 `ModbusTCP` 模块提供独立上位机入口，不复用 `ModbusRTU` 模块名或 gRPC 服务。
- 支持 TCP 主站连接、点表、轮询启停、运行状态和源端实时值查看。
- 将 ModbusTCP 链路纳入系统总览以及配置导入导出。

## 边界

- 上位机直接调用 `ModbusTCP.ModbusTCPService`，不经 ConfigPusher 转发。
- RTU 与 TCP 共享点位定义、功能码、数据类型、地址基准和读取策略；链路传输参数保持独立。
- TCP 链路仅配置目标主机、端口、Unit ID、连接超时、请求超时、轮询周期、地址基准和读取策略。
- 本次不改变 `ModbusRTU` 页面及其串口/MQTT 透传行为。

## 接口与数据

- 模块名：`ModbusTCP`。
- 服务：`ModbusTCPProto.ModbusTCPService`。
- 链路管理：`UpsertLink`、`RenameLink`、`GetLink`、`ListLinks`、`DeleteLink`。
- 功能启停：`StartLink`、`StopLink`。
- 点表管理：`UpsertPointTable`、`GetPointTable`。
- TCP 参数：`host`、`port`、`unit_id`、`connect_timeout_ms`、`request_timeout_ms`。
- 点表采用 `ModbusRTUProto.Point`，因此页面沿用既有功能码与数据类型校验。

## 交互与异常

- 连接和点表仅在链路停止时修改；运行中的修改由上位机先停止、保存，再按原状态重启。
- 重命名保留 `conn_id`；复制连接创建新的 `conn_id` 并复制点表。
- 主机不能为空，端口范围为 `1..65535`，Unit ID 范围为 `1..247`，超时和轮询周期必须为正整数。
- 下位机当前尚未执行 TCP 显式读取区间和死区过滤，因此 TCP 页面固定使用逐点读取，不展示区间读取或死区编辑器；编辑、复制时仍保留已有字段值，避免外部导入配置被静默清空。
- 模块未运行、RPC 失败或点表加载失败时在页面显示中文错误，既有数据显示不被静默覆盖。
- 实时值通过 DataCenter 源端查询，模块名固定为 `ModbusTCP`。

## 配置导入导出

- 新增 `modbus_tcp` 配置段，保存链路与点表，不包含 RTU 的 MQTT 全局配置。
- 覆盖导入会收敛删除文件中不存在的 TCP 链路；合并导入对重名连接自动改名，并同步改写数据总线路由中的连接名。
- 旧配置文件未包含 `modbus_tcp` 时按空配置处理，保持向后兼容。

## 验收标准

- 导航可进入独立的 Modbus TCP 页面。
- 页面可完成连接新建、编辑、重命名、复制、删除和轮询启停。
- 页面可完成点位增删改查、复制和实时值显示；暂未生效的读取策略与死区字段不开放编辑但会原样保留。
- Tauri 与浏览器开发模式均暴露完整的 `modbusTcp*` API。
- 系统总览统计包含 ModbusTCP 链路，并可报告其加载失败。
- 配置导入导出可完整往返 `modbus_tcp` 链路与点表。
