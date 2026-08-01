import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(root, "release-assets");
const tauriConfig = JSON.parse(readFileSync(resolve(root, "apps/editor/src-tauri/tauri.conf.json"), "utf8"));
const version = tauriConfig.version;

const variants = {
  "linux-x86_64": {
    ".AppImage": `coscup-cut-${version}-linux-x86_64.AppImage`,
    ".deb": `coscup-cut-${version}-linux-x86_64.deb`,
    ".rpm": `coscup-cut-${version}-linux-x86_64.rpm`,
  },
  "windows-x86_64": {
    ".exe": `coscup-cut-${version}-windows-x86_64-setup.exe`,
    ".msi": `coscup-cut-${version}-windows-x86_64.msi`,
  },
  "macos-intel": {
    ".dmg": `coscup-cut-${version}-macos-intel.dmg`,
  },
  "macos-apple-silicon": {
    ".dmg": `coscup-cut-${version}-macos-apple-silicon.dmg`,
  },
};

function argument(name) {
  const value = process.argv.find((item) => item.startsWith(`${name}=`));
  if (!value) throw new Error(`Missing ${name}=... argument`);
  return value.slice(name.length + 1);
}

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function expectedReleaseAssets() {
  return Object.values(variants).flatMap((files) => Object.values(files)).sort();
}

function collect() {
  const target = argument("--target");
  const variant = argument("--variant");
  const expected = variants[variant];
  if (!expected) throw new Error(`Unknown release variant: ${variant}`);

  const bundleDirectory = resolve(root, "target", target, "release/bundle");
  if (!existsSync(bundleDirectory)) throw new Error(`Bundle directory does not exist: ${bundleDirectory}`);
  const bundleFiles = filesBelow(bundleDirectory);

  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });

  for (const [extension, outputName] of Object.entries(expected)) {
    const matches = bundleFiles.filter((path) => path.endsWith(extension));
    if (matches.length !== 1) {
      throw new Error(`Expected one ${extension} bundle for ${variant}, found ${matches.length}`);
    }
    const destination = resolve(outputDirectory, outputName);
    copyFileSync(matches[0], destination);
    process.stdout.write(`${matches[0]} -> ${destination}\n`);
  }
}

function verify() {
  const tag = argument("--tag");
  if (tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match app version ${version}`);
  }
  if (!existsSync(outputDirectory)) throw new Error(`Release asset directory does not exist: ${outputDirectory}`);

  const actual = readdirSync(outputDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const expected = expectedReleaseAssets();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Release assets do not match.\nExpected: ${expected.join(", ")}\nActual: ${actual.join(", ")}`);
  }

  for (const file of actual) {
    const path = resolve(outputDirectory, file);
    if (statSync(path).size === 0) throw new Error(`Release asset is empty: ${file}`);
  }
  process.stdout.write(`Verified ${actual.length} release assets for ${tag}\n`);
}

const command = process.argv[2];
if (command === "collect") collect();
else if (command === "verify") verify();
else throw new Error("Usage: release-assets.mjs <collect|verify> [arguments]");
