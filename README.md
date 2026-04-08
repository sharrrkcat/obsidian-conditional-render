# Conditional Render

Conditional Render adds variable-based conditional rendering to Obsidian.

Use global plugin variables and note frontmatter to:

- render inline expressions
- show or hide block content with `if / else`
- apply hidden styles when conditions are false
- edit values directly inside notes with interactive inputs

## Highlights

- Inline expression rendering with `cr:`
- Conditional fenced blocks with `crif:` / `crelse:`
- Access current note frontmatter through `this.xxx`
- Configurable default variable for simple inline visibility
- Multiple hidden styles for false conditions without `crelse:`
- Interactive inputs for `bool`, `string`, and `number`
- Explicit typed input syntax with options
- Customizable plugin identifier, such as `cr` or `cat`
- Global variables with drag sorting and default-variable selection
- JSON import/export for variable sets

## Installation

Install from the Obsidian Community Plugins browser, then enable **Conditional Render**.

## Quick example

Frontmatter:

```yaml
---
published: true
score: 88
done: false
---
```

In the note:

```md
Published: `cr: this.published ? "Yes" : "No"`
Score: `cr: this.score`
Done: `cr-input: bool(this.done)`
```

## Syntax

### Inline expressions

Use `cr:` to evaluate and render an expression.

```md
`cr: plugin_name`
`cr: this.score`
`cr: this.score >= 60 ? "Pass" : "Fail"`
```

### Simple conditional inline text

Use the configured default variable to control whether a short text fragment is shown.

```md
`cr "Visible when the default variable is truthy"`
```

### Conditional blocks

````md
```cr
crif: this.published
This note is published.
crelse:
This note is still a draft.
```
````

Notes:

- `crelse:` is required. Plain `crelse` is not supported.
- If `crelse:` is omitted and the condition is false, the block is shown with the selected hidden style.
- If `crif:` is omitted, the plugin falls back to the configured default variable.

### Variable replacement inside text

```md
Current score: {{this.score}}
```

## Hidden styles

When a condition is false and there is no `crelse:`, content can be hidden using one of these styles:

- `none`
- `text`
- `text-grey`
- `underline`
- `blank`
- `spoiler`
- `spoiler-round`
- `spoiler-white`
- `spoiler-white-round`

You can force a style per block or inline usage.

Block examples:

````md
```cr-underline
crif: false
Hidden with underline style
```

```cr-spoiler
crif: false
Hidden as spoiler
```
````

Inline examples:

```md
`cr-t "Custom hidden text"`
`cr-u "Underline hidden text"`
`cr-sp "Spoiler hidden text"`
```

Short aliases are also supported:

| Full | Short |
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

## Interactive inputs

Interactive inputs let you edit either:

- a global plugin variable
- a frontmatter field in the current note via `this.xxx`

### Recommended syntax

Use explicit typed inputs.

```md
`cr-input: bool(plugin_status)`
`cr-input: string(plugin_name)`
`cr-input: number(this.score)`
```

Supported types:

- `bool(...)`
- `string(...)`
- `number(...)`

Supported options:

- `placeholder`
- `debounce`
- `min`
- `max`
- `step`

Examples:

```md
`cr-input: string(this.nickname, placeholder="Enter a nickname")`
`cr-input: number(this.score, min=0, max=100, step=1)`
`cr-input: string(this.title, debounce=400)`
```

### Legacy syntax

Legacy input syntax is still supported for compatibility:

```md
`cr-input plugin_status`
`cr-input this.score`
```

Legacy syntax is **not recommended**. It depends on automatic type detection and may trigger unexpected behavior in edge cases. Use explicit typed inputs in new notes and templates.

## Global variables

Global variables are managed in plugin settings.

Each variable includes:

- name
- type: `string`, `number`, or `boolean`
- value

Supported actions:

- add variables
- rename variables
- change types
- reorder by drag and drop
- set a default variable
- delete variables
- import/export variables as JSON

## Settings

Conditional Render includes settings for:

- plugin identifier
- global default hidden style
- custom hidden text for text-based styles
- global variables
- default variable
- JSON import/export

Changing the plugin identifier updates all syntax prefixes after reload. For example, `cr` can become `cat`, which changes forms such as `crif:` to `catif:` and `cr-input:` to `cat-input:`.

## Dataview access

Global variables can be accessed from DataviewJS.

```dataviewjs
const crPlugin = app.plugins.plugins["conditional-render"];

if (crPlugin) {
  const variables = crPlugin.settings.variables;
  const targetVar = variables.find(v => v.name === "plugin_status");

  if (targetVar) {
    dv.paragraph(`Loaded: **${targetVar.value}**`);
  }
}
```

## Example note

See the standalone example note:

- [Example note (English)](./example-note.en.md)

## Tips

- Use typed `cr-input` syntax in all new content.
- Use `this.xxx` when a value belongs to the current note.
- Use global variables for reusable states shared across notes.
- Prefer explicit hidden styles in templates when predictable output matters.

## License

MIT
