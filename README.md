# Conditional Render for Obsidian

Conditional Render is a conditional rendering plugin for Obsidian.
It can render inline expressions, conditional blocks, multiple hidden-display styles, and interactive input controls in notes based on global variables and note frontmatter.

## Features

- Supports inline variables and expression rendering
- Supports `if / else` conditional code block rendering
- Supports reading:
  - plugin global variables
  - `this.xxx` from the current note frontmatter
- Supports a **default variable** for controlling short text display / hiding
- Supports multiple hidden styles
- Supports editing variables directly inside notes:
  - boolean checkboxes
  - text inputs
  - number inputs
- Supports the new explicit typed `cr-input` syntax
- Keeps the legacy `cr-input` syntax for compatibility
- Supports custom plugin identifiers such as `cr`, `cat`, and more
- Supports variable JSON import / export
- Supports drag-and-drop variable sorting and default variable selection
- Suitable for frontmatter-driven workflows and template systems

---

## Quick Start

### 1. Inline expressions

Use `cr:` to output the result of an expression.

```md
Plugin name: `cr: plugin_name`
Current score: `cr: this.score`
After adding 10: `cr: this.score + 10`
```

### 2. Conditional code blocks

Use a `cr` code block together with `crif:`.

````md
```cr
crif: this.published
This note has been published.
crelse:
This note is still a draft.
```
````

### 3. Access frontmatter

Use `this.xxx` to access the current note frontmatter.

```yaml
---
title: Demo Note
published: true
score: 88
---
```

```md
Title: `cr: this.title`
Published: `cr: this.published ? "Yes" : "No"`
```

---

## Syntax

## Inline Syntax

### Computed output

```md
`cr: expression`
```

Examples:

```md
`cr: plugin_name`
`cr: this.score`
`cr: this.score >= 60 ? "Pass" : "Fail"`
```

### Simple conditional text

```md
`cr "Text shown when the default variable is true"`
```

This form is suitable for showing or hiding short text, and is controlled by the **default variable** in settings.

Examples:

```md
`cr "Show this text when the default variable is true."`
`cr "Current plugin: " + plugin_name`
```

### Variable interpolation in text

You can use `{{ ... }}` inside text or block content to inject expression results.

```md
Current score: {{this.score}}
```

---

## Conditional Code Blocks

### Standard syntax

````md
```cr
crif: expression
Shown when the condition is true
crelse:
Shown when the condition is false
```
````

### Without `crelse:`

When the condition is false and there is no `crelse:`, the block content will be displayed using the current hidden style.

````md
```cr
crif: this.secret
When `this.secret` is false, this content will be handled using the hidden style.
```
````

### Code blocks controlled by the default variable

If a code block does not contain `crif:`, the plugin falls back to the **default variable**.

````md
```cr
This code block is shown or hidden based on the default variable.
```
````

---

## Hidden Styles

When a condition is false and there is no `crelse:`, Conditional Render can display “hidden content” in different ways.

### Global hidden style

You can choose the default hidden style in settings.

Available styles:

- `none`
- `text`
- `text-grey`
- `underline`
- `blank`
- `spoiler`
- `spoiler-round`
- `spoiler-white`
- `spoiler-white-round`

### Force a hidden style for a single line or code block

You can specify a style with a suffix.

Examples:

````md
```cr-underline
crif: false
Hidden with underline style
```

```cr-spoiler
crif: false
Hidden with spoiler style
```
````

```md
`cr-t "Shown as custom text"`
`cr-u "Hidden with underline"`
`cr-sp "Hidden with spoiler style"`
```

### Full identifiers and shorthand

| Full form | Shorthand |
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

---

## Interactive Inputs

Interactive inputs let you edit variables directly inside notes.

### Recommended syntax: explicit typed inputs

The newer versions recommend explicit typed syntax.
It is more stable, clearer, and easier to extend later.

```md
`cr-input: bool(plugin_status)`
`cr-input: string(plugin_name)`
`cr-input: number(this.score)`
```

### Editable targets

- Global variables: `plugin_status`
- Current note frontmatter: `this.score`

### Supported types

- `bool(...)` → checkbox
- `string(...)` → text input
- `number(...)` → number input

### Optional parameters

You can keep passing parameters after the target.

```md
`cr-input: string(this.nickname, placeholder="Please enter a nickname")`
`cr-input: number(this.score, min=0, max=100, step=1)`
`cr-input: string(this.title, debounce=400)`
```

Currently supported parameters:

- `placeholder`
- `debounce`
- `min`
- `max`
- `step`

### Example

```yaml
---
done: false
name: Alice
score: 75
---
```

```md
Done: `cr-input: bool(this.done)`
Name: `cr-input: string(this.name, placeholder="Please enter a name")`
Score: `cr-input: number(this.score, min=0, max=100, step=1)`
```

### Legacy input syntax

The plugin still supports the old syntax:

```md
`cr-input plugin_status`
`cr-input this.score`
```

**Legacy syntax is not recommended for continued use.**
Because it relies on automatic type detection, it may trigger unexpected issues in some edge cases.
For new notes and templates, prefer explicit typed syntax.

---

## Global Variables

Global variables are stored in plugin settings.
Each variable includes:

- name
- type: `string`, `number`, `boolean`
- value

Supported operations:

- add variables
- rename variables
- drag to reorder
- change variable type
- set as default variable
- delete variables
- JSON import / export

### Example

If settings contain:

- `plugin_status = true`
- `plugin_name = "Conditional Render"`

Then:

```md
`cr: plugin_name`
`cr: plugin_status ? "Running" : "Stopped"`
```

---

## Default Variable

You can set one global variable as the **default variable**.
It is used for:

- inline syntax without `:`, such as `` `cr "..."` ``
- `cr` code blocks without `crif:`

Example:

```md
`cr "This sentence is shown only when the default variable is true."`
```

---

## Custom Identifier

The default identifier is `cr`.
You can change it in settings.

For example, after changing the identifier to `cat`:

- `cr:` → `cat:`
- `crif:` → `catif:`
- `crelse:` → `catelse:`
- `cr-input:` → `cat-input:`
- `cr-spoiler` → `cat-spoiler`

Example:

```md
`cat: this.score`
`cat-input: bool(this.done)`
```

---

## Settings Overview

Plugin settings include:

- **Plugin Identifier**
- **Global Default Hidden Style**
- **Custom hidden text** (for text / text-grey)
- **Global variable management**
- **Default variable setting**
- **Variable JSON import / export**
- Full-form / shorthand legend

---

## Variable Import and Export

Conditional Render supports exporting all global variables as JSON and importing them later.
This is useful for:

- backing up configurations
- sharing presets
- reusing variable sets across multiple vaults

---

## Example Note

````md
---
title: Demo
published: true
score: 88
secret: false
---

# Conditional Render Demo

Title: `cr: this.title`
Status: `cr: this.published ? "Published" : "Draft"`

`cr "This line is controlled by the default variable."`

```cr
crif: this.published
Because this note is published, this section will be shown.
crelse:
When the note is not published, this section will be shown instead.
```

```cr-spoiler
crif: this.secret
When secret is false, this content will be hidden with spoiler style.
```

Score editor: `cr-input: number(this.score, min=0, max=100, step=1)`
Publish state editor: `cr-input: bool(this.published)`
````

---

## Error Handling

When typed input syntax is invalid, the plugin shows an inline error message instead of failing silently.
Common errors include:

- empty input target
- invalid typed syntax format
- unsupported type
- invalid target variable format
- invalid parameter format
- typed input declared type does not match the configured global variable type

Examples:

```md
`cr-input: bool()`
`cr-input: text(this.done)`
`cr-input: bool(my var)`
```

---

## Compatibility Notes

- `crelse:` in conditional code blocks must include the colon
- legacy `cr-input target` is kept for compatibility only
- strongly recommended to migrate to the new `cr-input: type(target)` syntax
- if a typed global input declares a type that does not match the variable type in settings, an inline error will be shown directly

---

## Advanced Usage

Because global variables are stored in plugin settings, advanced users can also access them through the plugin instance in contexts such as DataviewJS.
A common approach is to get the plugin instance via `app.plugins.plugins["conditional-render"]` and then read `settings.variables`.

---

## Best Practices

- Use typed input syntax consistently in new notes and templates
- Prefer frontmatter for note-local state
- Prefer global variables for state shared across notes
- Keep one semantically clear default variable
- For reusable templates, prefer explicitly specifying hidden styles

---

## License

License information can be added here.
