// @effect-diagnostics nodeBuiltinImport:off -- Owns the helper process and its stdin lifetime across desktop IPC calls.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import { DesktopTailnetStateSchema, type DesktopTailnetState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopTailnetStateSchema));

export class EmbeddedTailnet {
  state: DesktopTailnetState = { phase: "off", value: "" };
  private child: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
  private closing: Promise<void> = Promise.resolve();

  private readonly executable: string;
  private readonly directory: string;
  private readonly sourceDirectory?: string;
  constructor(executable: string, directory: string, sourceDirectory?: string) {
    this.executable = executable;
    this.directory = directory;
    if (sourceDirectory) this.sourceDirectory = sourceDirectory;
  }

  restore(port: number) {
    try {
      if (NodeFS.existsSync(this.directory)) this.start(port);
    } catch (error) {
      this.state = { phase: "error", value: String(error) };
    }
  }

  start(port: number) {
    if (this.child) return;
    NodeFS.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.state = { phase: "starting", value: "" };
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^TS(?:_|NET_)/i.test(key)),
    );
    const args = [this.directory, String(port)];
    if (this.sourceDirectory) args.unshift("run", "-mod=readonly", ".");
    const child = NodeChildProcess.spawn(this.executable, args, {
      cwd: this.sourceDirectory,
      env,
      windowsHide: true,
    });
    this.child = child;
    this.closing = new Promise((resolve) => {
      child.once("close", () => {
        this.child = undefined;
        if (this.state.phase === "signed-out") {
          try {
            NodeFS.rmSync(this.directory, { recursive: true, force: true });
            this.state = { phase: "off", value: "" };
          } catch (error) {
            this.state = { phase: "error", value: String(error) };
          }
        } else if (this.state.phase !== "error") {
          this.state = { phase: "error", value: "The Tailscale node stopped." };
        }
        resolve();
      });
    });
    child.on("error", (err) => {
      this.state = { phase: "error", value: err.message };
    });
    child.stdin.on("error", () => {});
    child.stderr.resume();
    NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
      const message = decode(line);
      if (Option.isSome(message)) this.state = message.value;
    });
  }

  async signOut(port: number) {
    if (!this.child && !NodeFS.existsSync(this.directory)) return;
    if (!this.child) this.start(port);
    this.child?.stdin.write("logout\n");
    await this.closing;
    if (this.state.phase === "error") throw new Error(this.state.value);
  }

  async close() {
    this.child?.stdin.end();
    await this.closing;
  }
}
