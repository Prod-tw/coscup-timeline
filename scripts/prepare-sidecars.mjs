import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binaryDirectory = resolve(root, "apps/editor/src-tauri/binaries");
const requestedTarget = process.argv.find((value) => value.startsWith("--target="))?.split("=")[1];
const target = requestedTarget ?? execFileSync("rustc", ["-vV"], { encoding: "utf8" })
  .match(/^host: (.+)$/m)?.[1];

if (!target) throw new Error("Unable to determine the Rust target triple");

function findExecutable(name) {
  const explicit = process.env[`${name.toUpperCase()}_PATH`];
  if (explicit && existsSync(explicit)) return explicit;
  const locator = process.platform === "win32" ? "where" : "which";
  const output = execFileSync(locator, [name], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
  if (!output || !existsSync(output)) throw new Error(`${name} was not found on PATH`);
  return output;
}

mkdirSync(binaryDirectory, { recursive: true });
for (const name of ["ffmpeg", "ffprobe"]) {
  const source = findExecutable(name);
  const suffix = target.includes("windows") ? ".exe" : "";
  const destination = resolve(binaryDirectory, `coscup-${name}-${target}${suffix}`);
  copyFileSync(source, destination);
  if (process.platform !== "win32") chmodSync(destination, 0o755);
  process.stdout.write(`Prepared ${destination}\n`);
}
