import { isTruthyEnvValue } from "../infra/env.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";
import { getCommandPathWithRootOptions, hasFlag, hasHelpOrVersion } from "./argv.js";
import { emitCliBanner } from "./banner.js";
import { ensurePluginRegistryLoaded } from "./plugin-registry.js";
import { ensureConfigReady } from "./program/config-guard.js";
import { findRoutedCommand } from "./program/routes.js";

async function prepareRoutedCommand(params: {
  argv: string[];
  commandPath: string[];
  loadPlugins?: boolean | ((argv: string[]) => boolean);
}) {
  const suppressDoctorStdout = hasFlag(params.argv, "--json");
  emitCliBanner(VERSION, { argv: params.argv });
  await ensureConfigReady({
    runtime: defaultRuntime,
    commandPath: params.commandPath,
    ...(suppressDoctorStdout ? { suppressDoctorStdout: true } : {}),
  });
  const shouldLoadPlugins =
    typeof params.loadPlugins === "function" ? params.loadPlugins(params.argv) : params.loadPlugins;
  if (shouldLoadPlugins) {
    ensurePluginRegistryLoaded();
  }
}

export async function tryRouteCli(argv: string[]): Promise<boolean> {
  const profile = process.env.OPENCLAW_STATUS_JSON_PROFILE === "1";
  const routeStartedAt = profile ? Date.now() : 0;
  if (isTruthyEnvValue(process.env.OPENCLAW_DISABLE_ROUTE_FIRST)) {
    return false;
  }
  if (hasHelpOrVersion(argv)) {
    return false;
  }

  const path = getCommandPathWithRootOptions(argv, 2);
  if (!path[0]) {
    return false;
  }
  const route = findRoutedCommand(path);
  if (!route) {
    return false;
  }
  const prepareStartedAt = profile ? Date.now() : 0;
  await prepareRoutedCommand({ argv, commandPath: path, loadPlugins: route.loadPlugins });
  if (profile) {
    console.error(`[status-json-profile] route.prepare=${Date.now() - prepareStartedAt}ms`);
  }
  const runStartedAt = profile ? Date.now() : 0;
  const result = await route.run(argv);
  if (profile) {
    console.error(
      `[status-json-profile] route.run=${Date.now() - runStartedAt}ms total=${Date.now() - routeStartedAt}ms`,
    );
  }
  return result;
}
