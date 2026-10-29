const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { prepareProfile } = require("../../scripts/run-wayland-test");

test("test profiles link existing models without sharing settings or model directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-profile-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, "original");
  const modelDirectory = path.join(original, "parakeet-models", "model");
  fs.mkdirSync(modelDirectory, { recursive: true });
  const model = path.join(modelDirectory, "model.onnx");
  fs.writeFileSync(model, "existing model");
  fs.writeFileSync(path.join(original, ".env"), "PRIVATE_SETTINGS=original");
  const { configRoot, cacheRoot } = prepareProfile(path.join(root, "test"), original);
  assert.deepEqual(fs.readdirSync(configRoot), ["OpenWhispr-development"]);
  const settings = fs.readFileSync(path.join(configRoot, "OpenWhispr-development", ".env"), "utf8");
  assert.match(settings, /DICTATION_KEY=F13/);
  assert.doesNotMatch(settings, /PRIVATE_SETTINGS/);
  for (const directory of ["whisper-models", "parakeet-models", "diarization-models", "models"]) {
    assert.ok(fs.statSync(path.join(cacheRoot, directory)).isDirectory());
    assert.equal(fs.lstatSync(path.join(cacheRoot, directory)).isSymbolicLink(), false);
  }
  const linked = path.join(cacheRoot, "parakeet-models", "model", "model.onnx");
  assert.equal(fs.realpathSync(linked), model);
  prepareProfile(path.join(root, "test"), original);
  fs.rmSync(path.join(cacheRoot, "parakeet-models", "model"), { recursive: true });
  assert.equal(fs.readFileSync(model, "utf8"), "existing model");
});

test(
  "SIGTERM reaches Electron through both launchers and waits for its cleanup",
  { skip: process.platform !== "linux", timeout: 10000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-launcher-signal-"));
    let launcher;
    const receiptPath = path.join(root, "receipt.json");
    const shutdownPath = path.join(root, "shutdown-complete");
    t.after(() => {
      if (launcher?.exitCode === null && launcher?.signalCode === null) launcher.kill("SIGKILL");
      if (fs.existsSync(receiptPath)) {
        try {
          process.kill(JSON.parse(fs.readFileSync(receiptPath, "utf8")).pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    for (const directory of [
      "scripts",
      "src/helpers",
      "src/dist/wayland-overlay",
      "node_modules/electron",
    ]) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    for (const file of [
      "scripts/run-wayland-test.js",
      "scripts/run-electron.js",
      "src/helpers/xwayland.js",
      "src/helpers/linuxSession.js",
    ]) {
      fs.copyFileSync(path.resolve(__dirname, "../..", file), path.join(root, file));
    }
    fs.writeFileSync(path.join(root, "src/dist/index.html"), "test fixture");
    fs.writeFileSync(
      path.join(root, "src/dist/wayland-overlay/wayland-overlay.html"),
      "test fixture"
    );
    const executable = path.join(root, "electron-stub");
    fs.writeFileSync(
      path.join(root, "node_modules/electron/index.js"),
      `module.exports = ${JSON.stringify(executable)};`
    );
    fs.writeFileSync(
      executable,
      `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({
  pid: process.pid,
  qdrant: process.env.OPENWHISPR_QDRANT_STORAGE_DIR,
  config: process.env.XDG_CONFIG_HOME,
}));
process.on("SIGTERM", () => setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(shutdownPath)}, "cleaned up");
  process.exit(0);
}, 40));
setInterval(() => {}, 1000);
console.log("fixture-ready");
`,
      { mode: 0o755 }
    );
    const profile = path.join(root, "profile");
    launcher = spawn(process.execPath, [path.join(root, "scripts/run-wayland-test.js")], {
      env: {
        ...process.env,
        OPENWHISPR_TEST_PROFILE: profile,
        OPENWHISPR_TEST_MODELS: path.join(root, "models"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    launcher.stderr.resume();
    const exited = once(launcher, "exit");
    await new Promise((resolve, reject) => {
      let output = "";
      launcher.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("fixture-ready")) resolve();
      });
      launcher.once("error", reject);
      launcher.once("exit", () => reject(new Error("launcher exited before Electron was ready")));
    });
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.qdrant, path.join(profile, "data", "qdrant"));
    assert.equal(receipt.config, path.join(profile, "config"));
    launcher.kill("SIGTERM");
    const [code, signal] = await exited;
    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(shutdownPath, "utf8"), "cleaned up");
    assert.throws(() => process.kill(receipt.pid, 0), { code: "ESRCH" });
  }
);
