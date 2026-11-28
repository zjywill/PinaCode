import { expect, it } from "vite-plus/test";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import {
  isNamedPinaConversation,
  isPinaThread,
  pinaConversationThreadId,
  pinaThreadId,
} from "./pina.ts";

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

it("recognizes a named topic while keeping the legacy assistant ID distinct", () => {
  const project = ProjectId.make("f64440c9-c47d-4bae-90b6-8193e6bcf3c6");
  const topic = pinaConversationThreadId(project, "b5ba1253-d1b0-4cf7-b0af-d94ac077509f");
  const defaultThread = pinaThreadId(project, 0);
  expect(isPinaThread(topic)).toBe(true);
  expect(isNamedPinaConversation(topic)).toBe(true);
  expect(isNamedPinaConversation(defaultThread)).toBe(false);
});
