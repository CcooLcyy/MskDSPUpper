# IEC61850模型目录与IED级联选择方案

## 目标

SCL导入后，新增IED表单中的IED名称和AccessPoint必须从所选模型中选择，避免手工输入导致名称与SCL不一致。上位机只读取轻量目录元数据，不读取完整规范化SCL模型。

## 数据契约

新增只读模型目录查询，返回以下层级：

```text
模型 -> IED(name) -> AccessPoint(name, has_server) -> ConnectedAP网络(name, type)
```

`has_server`用于在上位机标记通信可用性。目录接口不返回逻辑节点、数据属性、控制块等大字段；现有模型摘要接口继续保持摘要语义。

每个AccessPoint的网络目录只返回与该IED和AccessPoint精确匹配的ConnectedAP轻量摘要，包括`subnetwork_name`和网络类型，不返回完整地址或GOOSE/SV对象。相同IED和AccessPoint下的重复ConnectedAP不得在目录层静默去重，应保留并由后端校验报告模型问题。

## 交互规则

1. 先选择模型，再加载该模型的IED列表。
2. 选择IED后，只展示该IED的AccessPoint列表。
3. 模型变更时清空IED和AccessPoint；IED变更时清空AccessPoint。
4. 只有一个候选项时自动选中；有多个候选项时不盲选。
5. 新增IED时，IED名称和AccessPoint均为必选下拉项。
6. AccessPoint优先展示包含Server的项；无Server的项保留为禁用项并说明不能启动通信。
7. 通信配置页中的IED名称和AccessPoint不得继续使用自由文本，必须使用同一目录数据或显示为只读值。

## 边界与校验

后端仍保留模型、IED和AccessPoint的精确匹配校验。选择正确的AccessPoint不代表通信一定可启动：对应的Communication/ConnectedAP必须存在；同一AccessPoint存在多个网络段时，还需在A/B通道配置中填写正确的subnetwork_name。

模型替换或刷新后，若当前配置引用的IED或AccessPoint已不存在，后端拒绝保存；上位机刷新目录后应清除失效的表单选择。

## A/B网络绑定规则

`IedConfig.channels[].subnetwork_name`是运行配置字段，用于把启用的A/B通道绑定到模型目录中的具体ConnectedAP网络。上位机加载或切换IED、AccessPoint后按`model_name + ied_name + access_point`过滤网络候选：

1. 候选网络只有一个时，自动填写该通道的`subnetwork_name`。
2. 候选网络有多个时，显示候选下拉框并要求用户明确选择，不按SCL数组顺序猜测A/B，也不因选择网段自动覆盖网卡、本地IP、对端IP或端口。
3. 已保存的网段名仍存在于候选列表时必须保留；模型替换后失效时清空并提示重新选择。
4. 禁用通道不要求填写网段名；启用通道在保存前应给出缺失或失效提示，后端启动校验仍是最终权威。

SCL中的NETA/NETB是逻辑网段名称，不天然声明物理A/B对应关系。只有现场配置明确规定固定映射时，上位机才可以显示建议值；建议值仍应允许用户修改和确认。模型中的IP地址仅作为选择提示，不能自动替换运行配置中的远端IP。

## 验收标准

- SCL导入成功后可查询模型目录，并看到文件中的IED名称和AccessPoint名称。
- 新增IED表单不能输入不在模型中的IED/AP名称。
- 切换模型或IED不会保留失效的下级选择。
- 无Server的AccessPoint不会被误选为可启动通信配置。
- 浏览器开发模式与Tauri运行模式提供一致的目录数据结构。
