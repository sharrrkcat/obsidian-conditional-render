---
title: Conditional Render Demo
published: true
secret: false
done: false
nickname: Alice
score: 88
---

# Conditional Render Example Note

This note demonstrates the main features of the plugin.

## Inline expressions

- Plugin name: `cr: plugin_name`
- Published: `cr: this.published ? "Yes" : "No"`
- Score: `cr: this.score`
- Result: `cr: this.score >= 60 ? "Pass" : "Fail"`

## Default variable inline text

`cr "This sentence is shown when the configured default variable is truthy."`

## Conditional block with else

```cr
crif: this.published
This note is published.
crelse:
This note is still a draft.
```

## Conditional block without else

```cr-underline
crif: this.secret
This block is hidden with the underline style when the condition is false.
```

## Variable replacement in text

Current score with replacement syntax: {{this.score}}

## Interactive inputs

### Recommended typed syntax

- Done: `cr-input: bool(this.done)`
- Nickname: `cr-input: string(this.nickname, placeholder="Enter a nickname")`
- Score: `cr-input: number(this.score, min=0, max=100, step=1)`

### Global variable inputs

- Plugin status: `cr-input: bool(plugin_status)`
- Plugin name: `cr-input: string(plugin_name)`

## Forced hidden styles

Inline text examples:

- `cr-t "Custom hidden text"`
- `cr-u "Underline hidden text"`
- `cr-sp "Spoiler hidden text"`

Block examples:

```cr-spoiler
crif: false
This block is hidden as a spoiler.
```

```cr-text
crif: false
This block shows custom hidden text instead of the original content.
```

## Legacy input syntax

Legacy syntax is still supported, but not recommended:

- `cr-input this.done`
- `cr-input plugin_status`

Use typed inputs in new notes and templates.
