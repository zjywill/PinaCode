import {
  CustomModelSetting,
  isRuntimeModeAbove,
  type ModelSelection,
  type RuntimeMode,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const DIM_DEFAULT_PRODUCT_HOME = "~/.dimcode-alpha";

export const DimSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("dima").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Dim CLI. A login-shell PATH resolves `dima`.",
        providerSettingsForm: { placeholder: "dima", clearWhenEmpty: "omit" },
      }),
    ),
    productHome: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Dim home",
        description:
          "Your Dim home, shared with the dima CLI. Empty uses DIMCODE_HOME, else ~/.dimcode-alpha.",
        providerSettingsForm: {
          placeholder: DIM_DEFAULT_PRODUCT_HOME,
          clearWhenEmpty: "omit",
        },
      }),
    ),
    socketPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Socket override",
        description:
          "Connect to an already running daemon at this socket. A set override never starts a daemon.",
        providerSettingsForm: { placeholder: "", clearWhenEmpty: "omit" },
      }),
    ),
    modelConfigPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "productHome", "socketPath"],
  },
);

export type DimSettings = typeof DimSettings.Type;

export function restrictLegacyDimRuntimeMode(
  runtimeMode: RuntimeMode,
  selection: ModelSelection,
): RuntimeMode {
  const mode = selection.options?.find((option) => option.id === "mode")?.value;
  const ceiling =
    mode === "read-only"
      ? "approval-required"
      : mode === "workspace-write"
        ? "auto-accept-edits"
        : undefined;
  return ceiling && isRuntimeModeAbove(runtimeMode, ceiling) ? ceiling : runtimeMode;
}
