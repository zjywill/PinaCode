import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolExposure from "../../McpToolExposure.ts";

const ToolSearchTool = Tool.make(McpToolExposure.TOOL_SEARCH, {
  description:
    "Load PinaCode tools you do not have yet, then call them by name. Search by name or purpose: threads (pinacode_thread_*), projects (pinacode_project_*), worktrees, pinacode_preview_* browser, pinacode_device_*, pinacode_html_preview/pinacode_html_render, pinacode_schedule_task, pull requests and guides, attachments, pinacode_request_secret, environment links. Exact names work too.",
  parameters: Schema.Struct({ query: Schema.String.check(Schema.isMaxLength(500)) }),
  success: Schema.Struct({
    tools: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, McpToolExposure.McpToolExposure],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const ToolSearchToolkit = Toolkit.make(ToolSearchTool);
