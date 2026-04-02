/**
 * Visual Diff Viewer Extension (/diff)
 * 
 * Provides a color-coded, scrollable view of git changes.
 * Supports current unstaged changes and per-turn diffs.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, truncateToWidth, matchesKey } from "@mariozechner/pi-tui";

class DiffViewer {
  public lines: string[] = [];
  public scrollOffset = 0;
  public viewHeight = 20; // Default height

  constructor(diffOutput: string) {
    this.lines = diffOutput.trim().split("\n");
  }

  handleInput(data: string): boolean {
    let changed = false;
    if (matchesKey(data, Key.up) && this.scrollOffset > 0) {
      this.scrollOffset--;
      changed = true;
    } else if (matchesKey(data, Key.down) && this.scrollOffset < this.lines.length - this.viewHeight) {
      this.scrollOffset++;
      changed = true;
    } else if (matchesKey(data, Key.pageup)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - this.viewHeight);
      changed = true;
    } else if (matchesKey(data, Key.pagedown)) {
      this.scrollOffset = Math.min(Math.max(0, this.lines.length - this.viewHeight), this.scrollOffset + this.viewHeight);
      changed = true;
    }
    return changed;
  }

  render(width: number, theme: any): string[] {
    const visibleLines = this.lines.slice(this.scrollOffset, this.scrollOffset + this.viewHeight);
    
    return visibleLines.map(line => {
      let styled = line;
      if (line.startsWith("+")) {
        styled = theme.fg("success", line);
      } else if (line.startsWith("-")) {
        styled = theme.fg("error", line);
      } else if (line.startsWith("@@")) {
        styled = theme.fg("accent", line);
      } else if (line.startsWith("diff") || line.startsWith("index")) {
        styled = theme.fg("muted", line);
      }
      return truncateToWidth(styled, width);
    });
  }
}

export default function visualDiff(pi: ExtensionAPI) {
  pi.registerCommand("diff", {
    description: "View color-coded git diff",
    handler: async (args, ctx) => {
      let gitArgs = ["diff", "--no-color"];
      
      if (args?.includes("--staged") || args?.includes("--cached")) {
        gitArgs.push("--cached");
      }

      const { stdout, stderr, code } = await pi.exec("git", gitArgs);

      if (code !== 0) {
        ctx.ui.notify(`Git diff failed: ${stderr}`, "error");
        return;
      }

      if (!stdout.trim()) {
        ctx.ui.notify("No changes to show.", "info");
        return;
      }

      const viewer = new DiffViewer(stdout);
      
      await ctx.ui.custom((tui, theme, _kb, done) => {
        return {
          render: (w) => {
            const lines = viewer.render(w, theme);
            const headerText = ` Diff View (${viewer.scrollOffset + 1}-${Math.min(viewer.scrollOffset + viewer.viewHeight, viewer.lines.length)}/${viewer.lines.length}) `;
            const header = theme.fg("accent", headerText.padStart(Math.floor((w + headerText.length) / 2), "─").padEnd(w, "─"));
            const help = theme.fg("dim", " ↑/↓: Scroll • Esc: Close ".padStart(Math.floor((w + 26) / 2), "─").padEnd(w, "─"));
            
            return [header, ...lines, help];
          },
          handleInput: (data) => {
            if (matchesKey(data, Key.escape)) {
              done(undefined);
            } else if (viewer.handleInput(data)) {
              tui.requestRender();
            }
          },
          invalidate: () => {}
        };
      }, { overlay: true });
    }
  });
}
