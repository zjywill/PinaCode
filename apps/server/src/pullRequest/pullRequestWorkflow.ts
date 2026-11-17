import { PINACODE_PR_WORKFLOW_SKILL } from "@t3tools/contracts";
import { matchInlineSkills } from "@t3tools/shared/inlineSkills";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Source runs load the same skill that the build embeds.
import * as NodeFS from "node:fs";

declare const __T3CODE_PR_WORKFLOW_SKILL__: string | undefined;

export const PULL_REQUEST_WORKFLOW_SKILL =
  typeof __T3CODE_PR_WORKFLOW_SKILL__ === "undefined"
    ? NodeFS.readFileSync(new URL("./following-pull-requests/SKILL.md", import.meta.url), "utf8")
    : __T3CODE_PR_WORKFLOW_SKILL__;

export function expandPullRequestWorkflowPrompt(text: string): string {
  const mentions = [...matchInlineSkills(text, [PINACODE_PR_WORKFLOW_SKILL])];
  if (mentions.length === 0) return text;
  let request = text;
  for (const mention of mentions.toReversed()) {
    request = request.slice(0, mention.start) + request.slice(mention.end);
  }
  return `<pinacode_builtin_skill>
${PULL_REQUEST_WORKFLOW_SKILL}
</pinacode_builtin_skill>

<user_request>
${request.trim()}
</user_request>`;
}
