
# Conditional Render

Conditional Render是一个轻量插件，为 Obsidian 提供基于变量的条件渲染能力。

[English](README.md) | **简体中文**

---

## 亮点

- 使用`cr "文本"`一键隐藏或显示文本，支持9种隐藏样式
- 支持读取、修改笔记frontmatter变量和自建全局变量
- 使用 `cr:` 渲染行内表达式
- 使用 `crif:` / `crelse:` 渲染条件代码块
- 使用 `cr-input` 一键编辑变量
- 支持自定义插件标识符，例如 `cr`、`cat`

## 安装

还在测试中，暂时未提交至 Obsidian 社区插件库，先前往release安装。

## 快速示例
Global Variables

```
default_var = false
plugin_name = Conditional Render
```

Frontmatter：

```yaml
---
published: true
HP: 88
done: false
---
```

笔记中：

```md
这是一款名叫`cr: plugin_name`的插件。
如果默认变量为false，`cr "这段话就会被隐藏，"`有些文字你就看不到了。
可用选择多种隐藏样式，比如`cr-sp "只有鼠标移上才会显示"`

这篇文档`cr: this.published ? "已经发布" : "还没有发布"`。
英雄的生命现在是：`cr-input: number(this.score, min=0, max=100, step=1)`
学会了：`cr-input: bool(this.done)`
```

## 全局变量

全局变量在插件设置中管理。

每个变量包含：

- 名称
- 类型：`string`、`number`、`boolean`
- 值

支持操作：

- 增删、重命名、拖拽排序
- 编辑值、修改类型
- 设为默认变量
- JSON 导入 / 导出

## 语法

### 行内表达式

使用 `cr:` 计算并输出表达式结果。

```md
`cr: plugin_name`
`cr: "这是名叫" + plugin_name + "的插件"`
`cr: this.score + 1`
`cr: this.score >= 60 ? "及格" : "不及格"`
```

### 简单条件行内文本

用默认变量控制一小段文本是否显示。

```md
`cr "当默认变量为真时显示的文字，为假时以隐藏样式显示"`
```

### 条件代码块

````md
```cr
crif: this.published
这篇笔记已发布。
>支持**原生**_样式_
crelse:
这篇笔记仍是草稿。
我正在使用{{plugin_name}}，距离满分还差{{100 - this.score}}.
```
````

说明：

- 不支持嵌套
- 使用{{变量名}}进行变量替换
- 如果修改了插件标识符，这里也需要同步修改，如`catif:`、`catelse:`
- 若省略 `crelse:` 且条件为假，内容会按当前隐藏样式显示。
- 若省略 `crif:`，插件会回退到设置中的默认变量。


## 隐藏样式

当条件为假且没有 `crelse:` 时，可使用隐藏样式对单个代码块或单条行内内容强制指定样式。

代码块示例：

````md
```cr-underline
crif: false
以下划线样式隐藏
```

```cr-sp
crif: false
以防剧透样式隐藏
```
````

行内示例：

```md
`cr-text "显示为指定文本"`
`cr-u "以下划线隐藏"`
`cr-sp "防剧透隐藏"`
```

也支持简写：

| 完整写法                     | 简写        |
| ------------------------ | --------- |
| `cr-none`                | `cr-n`    |
| `cr-text`                | `cr-t`    |
| `cr-text-grey`           | `cr-tg`   |
| `cr-underline`           | `cr-u`    |
| `cr-blank`               | `cr-b`    |
| `cr-spoiler`             | `cr-sp`   |
| `cr-spoiler-round`       | `cr-spr`  |
| `cr-spoiler-white`       | `cr-spw`  |
| `cr-spoiler-white-round` | `cr-spwr` |

## 交互式输入

交互式输入可直接编辑：

- 插件全局变量
- 当前笔记 frontmatter 中的 `this.xxx`


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



## 设置项

Conditional Render 提供以下设置：

- 插件标识符
- 全局默认隐藏样式
- 文本类隐藏样式的自定义提示文本
- 全局变量
- 默认变量
- JSON 导入 / 导出

修改插件标识符后，重启后所有前缀会随之变化。例如把 `cr` 改成 `cat` 后，`crif:` 会变成 `catif:`，`cr-input:` 会变成 `cat-input:`。

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

示例笔记见：

- [示例笔记（中文）](./example-notes/example-note.zh-CN.md)


## License

MIT
