#!/usr/bin/env node
// Separate settings and model directory entries for testing the GTK overlay.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MODEL_DIRS = ["whisper-models", "parakeet-models", "diarization-models", "models"];

function linkModelFiles(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  if (!fs.existsSync(source)) return;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.name.endsWith(".part") || entry.name.endsWith(".tmp")) continue;
    // Keep directories private: deleting a test model must only unlink test entries.
    if (entry.isDirectory()) linkModelFiles(from, to);
    else if (entry.isFile() && !fs.existsSync(to)) fs.symlinkSync(from, to);
  }
}

function prepareProfile(profileRoot, modelRoot) {
  const configRoot = path.join(profileRoot, "config");
  const cacheRoot = path.join(profileRoot, "cache", "openwhispr");
  fs.mkdirSync(configRoot, { recursive: true });
  const settingsRoot = path.join(configRoot, "OpenWhispr-development");
  fs.mkdirSync(settingsRoot, { recursive: true });
  const settingsFile = path.join(settingsRoot, ".env");
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      "DICTATION_KEY=F13\nVOICE_AGENT_KEY=F14\nTRANSLATION_KEY=F15\nMEETING_KEY=F16\nACTIVATION_MODE=tap\nPANEL_START_POSITION=bottom-left\n",
      { flag: "wx", mode: 0o600 }
    );
  }
  // All relocated directories must exist before getCacheRoot runs; otherwise it
  // migrates models from the regular profile into the test cache.
  for (const directory of MODEL_DIRS) {
    linkModelFiles(path.join(modelRoot, directory), path.join(cacheRoot, directory));
  }
  return { configRoot, cacheRoot };
}

function main() {
  if (process.platform !== "linux") throw new Error("Wayland testing requires Linux.");
  const appDir = path.resolve(__dirname, "..");
  if (!fs.existsSync(path.join(appDir, "src", "dist", "index.html"))) {
    throw new Error("Build the renderer first: npm run build:renderer");
  }
  const profileRoot = path.resolve(
    process.env.OPENWHISPR_TEST_PROFILE ||
      path.join(os.tmpdir(), `openwhispr-wayland-test-${process.getuid()}`)
  );
  const modelRoot = path.resolve(
    process.env.OPENWHISPR_TEST_MODELS ||
      process.env.OPENWHISPR_CACHE_ROOT ||
      path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "openwhispr")
  );
  const { configRoot, cacheRoot } = prepareProfile(profileRoot, modelRoot);
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    OPENWHISPR_CHANNEL: "development",
    OPENWHISPR_AUTH_BRIDGE_PORT: "5198",
    OPENWHISPR_WAYLAND_OVERLAY: "gtk",
    XDG_CONFIG_HOME: configRoot,
    XDG_DATA_HOME: path.join(profileRoot, "data"),
    XDG_STATE_HOME: path.join(profileRoot, "state"),
    XDG_CACHE_HOME: path.dirname(cacheRoot),
    OPENWHISPR_CACHE_ROOT: cacheRoot,
    OPENWHISPR_QDRANT_STORAGE_DIR: path.join(profileRoot, "data", "qdrant"),
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  console.log(`Test settings: ${path.join(configRoot, "OpenWhispr-development")}`);
  console.log(`Linked model files from: ${modelRoot}`);
  console.log("Close this test instance before starting another test with the same profile.");
  const child = spawn(process.execPath, [path.join(__dirname, "run-electron.js")], {
    cwd: appDir,
    env: environment,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (require.main === module) main();
module.exports = { linkModelFiles, prepareProfile };
