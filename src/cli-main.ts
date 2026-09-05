import { runCli } from "./cli.js";

void runCli().then((code) => {
  process.exitCode = code;
});
