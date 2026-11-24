import { expect, it } from "vite-plus/test";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { isPinaThread, pinaThreadId } from "./pina.ts";

it("only recognizes assistant IDs with a project and generation", () => {
  for (const generation of [0, 1, 42]) {
    expect(isPinaThread(pinaThreadId(ProjectId.make("project-with-hyphens"), generation))).toBe(
      true,
    );
  }
  for (const id of [
    "regular-0",
    "pina-assistant-meeting-notes",
    "pina-assistant-0",
    "pina-assistant-project-01",
  ]) {
    expect(isPinaThread(ThreadId.make(id))).toBe(false);
  }
});
