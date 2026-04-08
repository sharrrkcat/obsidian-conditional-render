---
title: Conditional Render 示例
published: true
secret: false
done: false
nickname: Alice
score: 88
---

# Conditional Render 示例笔记

这份笔记演示插件的主要功能。

## 行内表达式

- 插件名称：`cr: plugin_name`
- 是否发布：`cr: this.published ? "是" : "否"`
- 分数：`cr: this.score`
- 结果：`cr: this.score >= 60 ? "及格" : "不及格"`

## 默认变量控制的行内文本

`cr "当设置中的默认变量为真时，会显示这句话。"`

## 带 else 的条件代码块

```cr
crif: this.published
这篇笔记已发布。
crelse:
这篇笔记仍是草稿。
```

## 不带 else 的条件代码块

```cr-underline
crif: this.secret
当条件为假时，这个块会以下划线样式隐藏。
```

## 文本中的变量替换

替换语法读取当前分数：{{this.score}}

## 交互式输入

### 推荐的 typed 新语法

- 完成：`cr-input: bool(this.done)`
- 昵称：`cr-input: string(this.nickname, placeholder="请输入昵称")`
- 分数：`cr-input: number(this.score, min=0, max=100, step=1)`

### 全局变量输入

- 插件状态：`cr-input: bool(plugin_status)`
- 插件名称：`cr-input: string(plugin_name)`

## 强制隐藏样式

行内示例：

- `cr-t "显示为指定文本"`
- `cr-u "以下划线隐藏"`
- `cr-sp "防剧透隐藏"`

代码块示例：

```cr-spoiler
crif: false
这个块会以防剧透样式隐藏。
```

```cr-text
crif: false
这个块会显示自定义隐藏文本，而不是原始内容。
```

## Legacy 输入语法

插件仍兼容旧写法，但不推荐继续使用：

- `cr-input this.done`
- `cr-input plugin_status`

新的笔记和模板请优先使用 typed 输入语法。
