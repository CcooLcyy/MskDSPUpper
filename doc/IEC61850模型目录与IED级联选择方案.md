# IEC61850模型目录与IED级联选择方案

## 目标

SCL导入后，新增IED表单中的IED名称和AccessPoint必须从所选模型中选择，避免手工输入导致名称与SCL不一致。上位机只读取轻量目录元数据，不读取完整规范化SCL模型。

## 数据契约

新增只读模型目录查询，返回以下层级：

```text
模型 -> IED(name) -> AccessPoint(name, has_server)
```

`has_server`用于在上位机标记通信可用性。目录接口不返回逻辑节点、数据属性、控制块等大字段；现有模型摘要接口继续保持摘要语义。

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

## 验收标准

- SCL导入成功后可查询模型目录，并看到文件中的IED名称和AccessPoint名称。
- 新增IED表单不能输入不在模型中的IED/AP名称。
- 切换模型或IED不会保留失效的下级选择。
- 无Server的AccessPoint不会被误选为可启动通信配置。
- 浏览器开发模式与Tauri运行模式提供一致的目录数据结构。
