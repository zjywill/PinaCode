import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/approve-agent")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
