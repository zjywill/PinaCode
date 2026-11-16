import { describe, expect, it } from "vite-plus/test";

import {
  T3_MCP_TOOL_NAMES,
  resolveT3McpSummaryAction,
  resolveT3McpToolDefinition,
  resolveT3McpToolPresentation,
} from "./t3McpToolPresentation.ts";

describe("resolveT3McpToolPresentation", () => {
  it("recognizes every PinaCode tool across provider prefixes and completion suffixes", () => {
    for (const tool of T3_MCP_TOOL_NAMES) {
      const presentation = resolveT3McpToolPresentation(tool);
      for (const prefix of [
        "mcp__pinacode__",
        "PinaCode.",
        "pinacode-direct.",
        "mcp__pinacode_direct__",
        "pinacode/",
        "pinacode:",
        "mcp_pinacode_",
        "PinaCode ",
        "pinacode · ",
      ]) {
        expect(resolveT3McpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveT3McpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
      expect(resolveT3McpToolPresentation(`mcp__t3-code__${tool}`), tool).toBeNull();
      expect(resolveT3McpToolPresentation(tool.replace(/^pinacode_/, "")), tool).toBeNull();
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveT3McpToolPresentation("pinacode-thread_opencode2-adapter_pinacode_delegate_task")
        ?.displayName,
    ).toBe("Delegate a child task");
    expect(resolveT3McpToolPresentation("pinacode-thread_opencode2-adapter_not_a_tool")).toBeNull();
  });
});

describe("resolveT3McpToolDefinition", () => {
  it("labels an action tool call as the action it ran", () => {
    expect(
      resolveT3McpToolDefinition("mcp__pinacode__pinacode_preview_act", { action: "type" })?.labels,
    ).toEqual(resolveT3McpToolDefinition("pinacode_preview_type")?.labels);
    expect(
      resolveT3McpToolDefinition("pinacode_thread_transfer", { action: "fork" })?.displayName,
    ).toBe(resolveT3McpToolDefinition("pinacode_thread_fork")?.displayName);
    expect(
      resolveT3McpToolDefinition("pinacode_preview_act", { action: "unknown" })?.labels[2],
    ).toBe("Used");
  });
});

describe("resolveT3McpSummaryAction", () => {
  it("summarizes an action tool by the action each call ran", () => {
    expect(resolveT3McpSummaryAction("mcp__pinacode__pinacode_queue", { action: "list" })).toBe(
      "queue-list",
    );
    expect(resolveT3McpSummaryAction("pinacode_queue", { action: "edit" })).toBe("queue-edit");
    expect(resolveT3McpSummaryAction("pinacode_thread_transfer", { action: "status" })).toBe(
      "thread-transfers",
    );
    expect(resolveT3McpSummaryAction("pinacode_thread_configure", {})).toBe("thread-configuration");
    expect(resolveT3McpSummaryAction("pinacode_schedule_task", { scheduledTaskId: "task-1" })).toBe(
      "schedule-update",
    );
    expect(resolveT3McpSummaryAction("pinacode_delegate_task", { task: "x" })).toBe("delegate");
  });
});
