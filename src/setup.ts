import type { ProviderCapabilities } from "./adapter-contract.js";
import { CodexAdapter } from "./adapters/codex.js";
import { CursorAdapter } from "./adapters/cursor.js";
import { resolveConfiguration, writeGlobalConfig, type RelayConfig } from "./config.js";
import type { RelayPaths } from "./paths.js";
import type { RelayUi } from "./ui.js";

export async function initializeConfiguration(
  paths: RelayPaths,
  ui: RelayUi,
  cwd: string,
): Promise<RelayConfig> {
  const resolved = await resolveConfiguration(paths);
  const config = structuredClone(resolved.config);
  const codex = new CodexAdapter(config.providers.codex.executable);
  const cursor = new CursorAdapter(config.providers.cursor.executable);
  const [codexCapabilities, cursorCapabilities] = await Promise.all([
    codex.probe({ cwd, deep: true }),
    cursor.probe({ cwd, deep: true }),
  ]);
  reportAvailability(ui, "Codex", codexCapabilities, "codex login");
  reportAvailability(ui, "Cursor", cursorCapabilities, "agent login");

  config.roles.architect.model = await chooseModel(
    ui,
    "Select the Codex architect model",
    codexCapabilities,
    config.roles.architect.model,
  );
  config.roles.implementer.model = await chooseModel(
    ui,
    "Select the Cursor implementer model",
    cursorCapabilities,
    config.roles.implementer.model,
  );
  config.roles.reviewer.model = await chooseModel(
    ui,
    "Select the Codex reviewer model",
    codexCapabilities,
    config.roles.reviewer.model || config.roles.architect.model,
  );
  await writeGlobalConfig(paths, config);
  ui.success(`Configuration written to ${paths.configFile}`);
  return config;
}

async function chooseModel(
  ui: RelayUi,
  message: string,
  capabilities: ProviderCapabilities,
  current: string,
): Promise<string> {
  const models = capabilities.availableModels ?? [];
  if (models.length > 0) {
    const options = models.map((model) => ({ value: model, label: model }));
    if (current && !models.includes(current))
      options.unshift({ value: current, label: `${current} (current)` });
    return ui.select(message, options);
  }
  let answer = "";
  while (!answer) answer = await ui.input(message, current || "provider model identifier");
  return answer;
}

function reportAvailability(
  ui: RelayUi,
  name: string,
  capabilities: ProviderCapabilities,
  loginCommand: string,
): void {
  if (!capabilities.installed) {
    ui.warn(
      `${name} CLI is not installed; enter its model manually and install it before relay run.`,
    );
  } else if (!capabilities.authenticated) {
    ui.warn(`${name} CLI is not authenticated; run ${loginCommand} before relay run.`);
  }
}
