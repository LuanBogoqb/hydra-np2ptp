// Dev launcher for the np2ptp fork.
//
// Lives outside package.json on purpose: the fork does not touch package.json,
// and keeping it that way means one less file to reconcile on the next port to
// an upstream release. Run it with `node scripts/dev-np2ptp.mjs`.
//
// PythonRPC resolves its interpreter from process.env.HYDRA_PYTHON_BIN
// (src/main/services/python-rpc.ts). electron-vite only injects MAIN_VITE_* and
// RENDERER_VITE_* from .env, so the venv has to be exported here instead — and
// exporting it from the shell rather than the user environment keeps the
// installed production Hydra pointed at its own bundled interpreter.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const venvPython =
  process.platform === "win32"
    ? join(repoRoot, ".venv312", "Scripts", "python.exe")
    : join(repoRoot, ".venv312", "bin", "python");

const env = { ...process.env };

if (!env.HYDRA_PYTHON_BIN && existsSync(venvPython)) {
  env.HYDRA_PYTHON_BIN = venvPython;
  console.log(`[dev-np2ptp] HYDRA_PYTHON_BIN -> ${venvPython}`);
} else if (!env.HYDRA_PYTHON_BIN) {
  console.warn(
    `[dev-np2ptp] venv not found at ${venvPython}; falling back to python3/python on PATH. ` +
      `Torrent downloads need libtorrent, so recreate it with: python -m venv .venv312 && .venv312/Scripts/pip install -r requirements.txt`
  );
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const child = spawn(npx, ["electron-vite", "dev"], {
  cwd: repoRoot,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
