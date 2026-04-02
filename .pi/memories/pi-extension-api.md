# Pi Extension API — Common Pitfalls
**Updated:** 2026-04-02

Lessons learned from auditing 23 extensions. These are the mistakes batch workers make repeatedly.

## Event handler signatures
All pi event handlers take `(event, ctx)` — event first, context second.
```typescript
pi.on("session_start", async (_event, ctx) => { ... });
pi.on("tool_call", async (event, ctx) => { ... });
pi.on("input", async (event, _ctx) => { ... });  // event.text is the input
```
WRONG: `(ctx)`, `(ctx, event)`, `(_ctx, ev)`

## registerCommand API
```typescript
pi.registerCommand("name", {
  description: "...",
  handler: async (args, ctx) => { ... }
});
```
WRONG: `run:`, `execute:`, `args: []`

## Status bar
Use `ctx.ui.setStatus("id", "text")` — NOT `pi.setStatus()`.
Clear with `undefined`, not empty string.

## sendUserMessage
Must specify delivery mode when agent may be streaming:
```typescript
pi.sendUserMessage(text, { deliverAs: "followUp" });
```

## notify requires severity
```typescript
ctx.ui.notify("message", "info");  // "info" | "warning" | "error" | "success"
```
WRONG: `"warn"` — must be `"warning"`.

**Gotcha:** `notify` flashes briefly and can disappear before the user reads it.
For command output that should persist, use `sendUserMessage` with `deliverAs: "followUp"` instead.

## getActiveTools() vs getAllTools()
`getActiveTools()` returns objects with a different shape than `getAllTools()`.
Tool `.name` may come back as empty string — inspect the actual return shape before assuming
it matches `getAllTools()`. Debug with `JSON.stringify()` first.

## No emoji in TUI
Emoji and Unicode box-drawing characters can cause TUI width calculation crashes.
Use ASCII only. Always use `truncateToWidth(line, width)` from pi-tui.

## File I/O
Use `fs.readFileSync()` / `fs.writeFileSync()` for simple file reads, NOT `pi.exec("cat", ...)`.
Use `pi.exec()` for git commands and system tools.

## Timestamps
Session entry timestamps are ISO 8601 strings, not epoch numbers.
Parse with `new Date(entry.timestamp).getTime()`.

## Model access
The current model is `ctx.model` — NOT `ctx.modelRegistry.current()`.
To look up a specific model: `ctx.modelRegistry.find(provider, id)`.
```typescript
// CORRECT
const model = ctx.model;
// WRONG — .current() does not exist
const model = ctx.modelRegistry.current();
```

## pi.exec return shape
```typescript
const { stdout, stderr, code, killed } = await pi.exec("git", ["status"]);
```
