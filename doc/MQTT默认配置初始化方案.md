# ModbusRTU 与 DLT645 MQTT 默认配置初始化方案

## 目标

- 新安装或模块端尚无 MQTT 配置时，上位机在协议页面准备配置前自动初始化默认 MQTT 参数。
- 创建 ModbusRTU MQTT 透传连接或 DLT645 连接时，不要求用户打开 MQTT 弹窗并重复确认默认值。
- 模块端已有 MQTT 配置时，上位机不得使用前端默认值覆盖该配置。
- 模块地址尚未就绪或初始化请求暂时失败时，应在模块运行信息可用后重试，并显示可诊断日志。

## 范围

- ModbusRTU、DLT645 protobuf 增加只读 MQTT 配置查询 RPC。
- 两个模块实现查询当前持久化 MQTT 配置的 gRPC 接口。
- 上位机 Tauri、浏览器 mock 和协议页面统一采用“查询 -> 仅缺失时下发默认值”的流程。
- 保留用户通过 MQTT 配置弹窗或 ConfigPusher 下发自定义配置的优先级。

## 行为约定

1. 查询接口返回 `configured=false` 时，上位机优先下发已有的本地 MQTT 配置；本地没有有效配置时才下发对应协议的默认配置，并保存本地设置。
2. 查询接口返回 `configured=true` 时，上位机只同步已有配置到表单，不调用 `UpdateConfig`。
3. 查询或初始化失败不得阻止协议页面加载；页面应在模块地址刷新后重试，最终失败通过中文日志和页面提示暴露。
4. ModbusRTU 仅对 MQTT 透传链路要求 MQTT 配置；本地串口链路行为不变。DLT645 按现有模块契约要求 MQTT 配置。
5. 初始化请求必须幂等，重复打开页面不得改变已有配置，也不得产生无界重试。

## 默认值

- ModbusRTU：host `127.0.0.1`、port `1883`、client_id `mskdsp-modbus-rtu`、keepalive `60`、connect timeout `5000ms`。
- DLT645：host `127.0.0.1`、port `1883`、client_id `mskdsp-dlt645`、keepalive `30`、connect timeout `3000ms`。

## 异常与验收

- 无 MQTT 持久化记录时，进入页面后不操作 MQTT 弹窗也能完成默认配置落盘。
- 随后创建并启动 ModbusRTU MQTT 透传连接、DLT645 连接，不再返回“MQTT 连接参数未配置”。
- 已配置自定义 MQTT 参数时，刷新页面、重启上位机或模块均保持自定义值。
- 模块暂不可用时，页面恢复模块地址后能完成一次初始化；失败不会静默伪装为成功。
- 查询接口异常、默认值校验失败和保存失败均有中文日志，且不影响已有配置。
