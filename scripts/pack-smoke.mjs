import { mkdtemp, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const temporary = await mkdtemp(path.join(os.tmpdir(), "relay-pack-smoke-"));
try {
  run("pnpm", ["pack", "--pack-destination", temporary], process.cwd());
  const tarball = (await readdir(temporary)).find((file) => file.endsWith(".tgz"));
  if (!tarball) throw new Error("pnpm pack did not create a tarball");
  run("npm", ["install", "--no-audit", "--no-fund", path.join(temporary, tarball)], temporary);
  const binary = path.join(
    temporary,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "relay.cmd" : "relay",
  );
  const result = run(binary, ["--version"], temporary);
  if (!result.stdout.includes("0.1.0-alpha.1")) {
    throw new Error("packed relay binary reported the wrong version");
  }
  process.stdout.write("Packed install smoke test passed.\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}
