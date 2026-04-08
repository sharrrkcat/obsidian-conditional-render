# Conditional Render

Conditional Render 为 Obsidian 提供基于变量的条件渲染能力。

可基于插件全局变量和当前笔记 frontmatter，实现：

- 行内表达式渲染
- `if / else` 条件块显示
- 条件为假时的多种隐藏样式
- 在笔记内直接编辑变量和 YAML 字段

## 亮点

- 使用 `cr:` 渲染行内表达式
- 使用 `crif:` / `crelse:` 渲染条件代码块
- 通过 `this.xxx` 访问当前笔记 frontmatter
- 支持默认变量控制简短文字显示
- 支持多种隐藏样式
- 支持 `bool`、`string`、`number` 三类交互式输入
- 支持显式类型的 `cr-input` 新语法
- 支持自定义插件标识符，例如 `cr`、`cat`
- 支持全局变量拖拽排序与默认变量设置
- 支持变量 JSON 导入 / 导出

## 安装

可从 Obsidian 社区插件市场安装，并启用 **Conditional Render**。

## 快速示例

Frontmatter：

```yaml
---
published: true
score: 88
done: false
---
```

笔记中：

```md
已发布：`cr: this.published ? "是" : "否"`
分数：`cr: this.score`
完成：`cr-input: bool(this.done)`
```

## 语法

### 行内表达式

使用 `cr:` 计算并输出表达式结果。

```md
`cr: plugin_name`
`cr: this.score`
`cr: this.score >= 60 ? "及格" : "不及格"`
```

### 简单条件行内文本

用默认变量控制一小段文本是否显示。

```md
`cr "当默认变量为真时显示的文字"`
```

### 条件代码块

````md
```cr
crif: this.published
这篇笔记已发布。
crelse:
这篇笔记仍是草稿。
```
````

说明：

- `crelse:` 必须带冒号，裸 `crelse` 不支持。
- 若省略 `crelse:` 且条件为假，内容会按当前隐藏样式显示。
- 若省略 `crif:`，插件会回退到设置中的默认变量。

### 文本中的变量替换

```md
当前分数：{{this.score}}
```

## 隐藏样式

当条件为假且没有 `crelse:` 时，可使用以下隐藏样式：

- `none`
- `text`
- `text-grey`
- `underline`
- `blank`
- `spoiler`
- `spoiler-round`
- `spoiler-white`
- `spoiler-white-round`

可对单个代码块或单条行内内容强制指定样式。

代码块示例：

````md
```cr-underline
crif: false
以下划线样式隐藏
```

```cr-spoiler
crif: false
以防剧透样式隐藏
```
````

行内示例：

```md
`cr-t "显示为指定文本"`
`cr-u "以下划线隐藏"`
`cr-sp "防剧透隐藏"`
```

也支持简写：

| 完整写法 | 简写 |
|---|---|
| `cr-none` | `cr-n` |
| `cr-text` | `cr-t` |
| `cr-text-grey` | `cr-tg` |
| `cr-underline` | `cr-u` |
| `cr-blank` | `cr-b` |
| `cr-spoiler` | `cr-sp` |
| `cr-spoiler-round` | `cr-spr` |
| `cr-spoiler-white` | `cr-spw` |
| `cr-spoiler-white-round` | `cr-spwr` |

## 交互式输入

交互式输入可直接编辑：

- 插件全局变量
- 当前笔记 frontmatter 中的 `this.xxx`

### 推荐语法

推荐使用显式类型输入。

```md
`cr-input: bool(plugin_status)`
`cr-input: string(plugin_name)`
`cr-input: number(this.score)`
```

支持的类型：

- `bool(...)`
- `string(...)`
- `number(...)`

支持的参数：

- `placeholder`
- `debounce`
- `min`
- `max`
- `step`

示例：

```md
`cr-input: string(this.nickname, placeholder="请输入昵称")`
`cr-input: number(this.score, min=0, max=100, step=1)`
`cr-input: string(this.title, debounce=400)`
```

### Legacy 旧语法

插件仍兼容旧写法：

```md
`cr-input plugin_status`
`cr-input this.score`
```

Legacy 写法**不推荐继续使用**。它依赖自动类型识别，在某些边缘情况下可能触发意外问题。新的笔记和模板请优先使用显式类型语法。

## 全局变量

全局变量在插件设置中管理。

每个变量包含：

- 名称
- 类型：`string`、`number`、`boolean`
- 值

支持操作：

- 新增变量
- 重命名变量
- 修改类型
- 拖拽排序
- 设为默认变量
- 删除变量
- JSON 导入 / 导出

## 设置项

Conditional Render 提供以下设置：

- 插件标识符
- 全局默认隐藏样式
- 文本类隐藏样式的自定义提示文本
- 全局变量
- 默认变量
- JSON 导入 / 导出

修改插件标识符后，重载后所有前缀会随之变化。例如把 `cr` 改成 `cat` 后，`crif:` 会变成 `catif:`，`cr-input:` 会变成 `cat-input:`。

## Dataview 访问

可在 DataviewJS 中访问插件全局变量。

```dataviewjs
const crPlugin = app.plugins.plugins["conditional-render"];

if (crPlugin) {
  const variables = crPlugin.settings.variables;
  const targetVar = variables.find(v => v.name === "plugin_status");

  if (targetVar) {
    dv.paragraph(`读取成功：**${targetVar.value}**`);
  }
}
```

## 示例笔记

独立示例笔记见：

- [示例笔记（中文）](./example-note.zh-CN.md)

## 使用建议

- 新内容统一使用 typed `cr-input` 语法。
- 当前笔记独有的数据优先放在 `this.xxx`。
- 多篇笔记共享状态时使用全局变量。
- 模板场景下，建议显式指定隐藏样式以获得稳定输出。

## License

MIT
