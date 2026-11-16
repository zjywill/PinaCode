#!/usr/bin/env node
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    method: { type: "string", default: "GET" },
    body: { type: "string" },
    output: { type: "string" },
    "env-file": { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "asc.mjs /v1/... [--method POST|PATCH|DELETE] [--body file.json] [--output file.json] [--env-file path]",
  );
  process.exit(0);
}
const endpoint = positionals[0];
if (positionals.length !== 1 || !/^\/v[12]\//.test(endpoint ?? "")) {
  throw new Error("Provide one App Store Connect /v1/ or /v2/ endpoint.");
}
if (!["GET", "POST", "PATCH", "DELETE"].includes(values.method)) {
  throw new Error("Unsupported HTTP method.");
}
const fileConfig = {};
if (values["env-file"]) {
  for (const line of NodeFS.readFileSync(values["env-file"], "utf8").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const raw = match[2];
    const quoted = raw.startsWith('"') || raw.startsWith("'");
    if (quoted && raw.at(-1) !== raw[0]) throw new Error("Unsupported environment-file quoting.");
    fileConfig[match[1]] = quoted ? raw.slice(1, -1) : raw;
  }
}
const config = { ...fileConfig, ...process.env };
const keyId = config.ASC_KEY_ID ?? config.APP_STORE_CONNECT_API_KEY;
const issuer = config.ASC_ISSUER_ID ?? config.APP_STORE_CONNECT_ISSUER_ID;
if (!/^[A-Z0-9]{10}$/.test(keyId ?? "") || !/^[0-9a-f-]{36}$/i.test(issuer ?? "")) {
  throw new Error(
    "Configure ASC_KEY_ID and ASC_ISSUER_ID, or the supported existing environment file.",
  );
}
const keyPath =
  config.ASC_KEY_PATH ??
  NodePath.join(NodeOS.homedir(), ".appstoreconnect/private_keys", "AuthKey_" + keyId + ".p8");
const key = NodeCrypto.createPrivateKey(NodeFS.readFileSync(keyPath));
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const input =
  encode({ alg: "ES256", kid: keyId, typ: "JWT" }) +
  "." +
  encode({ iss: issuer, iat: now, exp: now + 1100, aud: "appstoreconnect-v1" });
const token =
  input +
  "." +
  NodeCrypto.sign("sha256", Buffer.from(input), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
const response = await fetch("https://api.appstoreconnect.apple.com" + endpoint, {
  method: values.method,
  headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  ...(values.body ? { body: NodeFS.readFileSync(values.body, "utf8") } : {}),
  signal: AbortSignal.timeout(60000),
});
const body = await response.text();
if (values.output) NodeFS.writeFileSync(values.output, body, { mode: 0o600 });
else console.log(body);
if (!response.ok) {
  console.error("App Store Connect returned HTTP " + response.status + ": " + body.slice(0, 1200));
  process.exitCode = 1;
}
