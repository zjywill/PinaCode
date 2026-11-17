// @effect-diagnostics-next-line nodeBuiltinImport:off -- Source runs load the same skill that the build embeds.
import * as NodeFS from "node:fs";

declare const __T3CODE_PR_WORKFLOW_SKILL__: string | undefined;

export const PULL_REQUEST_WORKFLOW_SKILL =
  typeof __T3CODE_PR_WORKFLOW_SKILL__ === "undefined"
    ? NodeFS.readFileSync(new URL("./following-pull-requests/SKILL.md", import.meta.url), "utf8")
    : __T3CODE_PR_WORKFLOW_SKILL__;
