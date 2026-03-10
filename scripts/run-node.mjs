#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const compiler = "tsdown";
const compilerArgs = ["exec", compiler, "--no-clean"];

export const runNodeWatchedPaths = ["src", "tsconfig.json", "package.json"];

const statMtime = (filePath, fsImpl = fs) => {
  try {
    return fsImpl.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

const isExcludedSource = (filePath, srcRoot) => {
  const relativePath = path.relative(srcRoot, filePath);
  if (relativePath.startsWith("..")) {
    return false;
  }
  return (
    relativePath.endsWith(".test.ts") ||
    relativePath.endsWith(".test.tsx") ||
    relativePath.endsWith(`test-helpers.ts`)
  );
};

const findLatestMtime = (dirPath, shouldSkip, deps) => {
  let latest = null;
  const queue = [dirPath];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    let entries = [];
    try {
      entries = deps.fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (shouldSkip?.(fullPath)) {
        continue;
      }
      const mtime = statMtime(fullPath, deps.fs);
      if (mtime == null) {
        continue;
      }
      if (latest == null || mtime > latest) {
        latest = mtime;
      }
    }
  }
  return latest;
};

const runGit = (gitArgs, deps) => {
  try {
    const result = deps.spawnSync("git", gitArgs, {
      cwd: deps.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) {
      return null;
    }
    return (result.stdout ?? "").trim();
  } catch {
    return null;
  }
};

const resolveGitHead = (deps) => {
  const head = runGit(["rev-parse", "HEAD"], deps);
  return head || null;
};

const hasDirtySourceTree = (deps) => {
  const output = runGit(
    ["status", "--porcelain", "--untracked-files=normal", "--", ...runNodeWatchedPaths],
    deps,
  );
  if (output === null) {
    return null;
  }
  return output.length > 0;
};

const readBuildStamp = (deps) => {
  const mtime = statMtime(deps.buildStampPath, deps.fs);
  if (mtime == null) {
    return { mtime: null, head: null };
  }
  try {
    const raw = deps.fs.readFileSync(deps.buildStampPath, "utf8").trim();
    if (!raw.startsWith("{")) {
      return { mtime, head: null };
    }
    const parsed = JSON.parse(raw);
    const head = typeof parsed?.head === "string" && parsed.head.trim() ? parsed.head.trim() : null;
    return { mtime, head };
  } catch {
    return { mtime, head: null };
  }
};

const hasSourceMtimeChanged = (stampMtime, deps) => {
  const srcMtime = findLatestMtime(
    deps.srcRoot,
    (candidate) => isExcludedSource(candidate, deps.srcRoot),
    deps,
  );
  return srcMtime != null && srcMtime > stampMtime;
};

const shouldBuild = (deps) => {
  if (deps.env.OPENCLAW_FORCE_BUILD === "1") {
    return true;
  }
  const stamp = readBuildStamp(deps);
  if (stamp.mtime == null) {
    return true;
  }
  if (statMtime(deps.distEntry, deps.fs) == null) {
    return true;
  }

  for (const filePath of deps.configFiles) {
    const mtime = statMtime(filePath, deps.fs);
    if (mtime != null && mtime > stamp.mtime) {
      return true;
    }
  }

  const currentHead = resolveGitHead(deps);
  if (currentHead && !stamp.head) {
    return hasSourceMtimeChanged(stamp.mtime, deps);
  }
  if (currentHead && stamp.head && currentHead !== stamp.head) {
    return hasSourceMtimeChanged(stamp.mtime, deps);
  }
  if (currentHead) {
    const dirty = hasDirtySourceTree(deps);
    if (dirty === true) {
      return true;
    }
    if (dirty === false) {
      return false;
    }
  }

  if (hasSourceMtimeChanged(stamp.mtime, deps)) {
    return true;
  }
  return false;
};

const logRunner = (message, deps) => {
  if (deps.env.OPENCLAW_RUNNER_LOG === "0") {
    return;
  }
  deps.stderr.write(`[openclaw] ${message}\n`);
};

const waitForChildResult = async (child) =>
  await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    child.on?.("error", (error) => finish({ exitCode: null, exitSignal: null, error }));
    child.on?.("exit", (exitCode, exitSignal) => finish({ exitCode, exitSignal, error: null }));
  });

const spawnWithResult = async (command, args, options, deps) => {
  try {
    const child = deps.spawn(command, args, options);
    return await waitForChildResult(child);
  } catch (error) {
    return { exitCode: null, exitSignal: null, error };
  }
};

const resolveBuildInvocations = (deps) => {
  if (deps.platform === "win32") {
    return [
      { command: "cmd.exe", args: ["/d", "/s", "/c", "pnpm", ...compilerArgs], label: "pnpm" },
    ];
  }

  const candidates = [];
  const execDir = path.dirname(deps.execPath);
  const siblingPnpm = path.join(execDir, "pnpm");
  const siblingNpm = path.join(execDir, "npm");

  if (statMtime(siblingPnpm, deps.fs) != null) {
    candidates.push({ command: siblingPnpm, args: compilerArgs, label: siblingPnpm });
  }
  candidates.push({ command: "pnpm", args: compilerArgs, label: "pnpm" });

  if (statMtime(siblingNpm, deps.fs) != null) {
    candidates.push({
      command: siblingNpm,
      args: ["exec", compiler, "--", "--no-clean"],
      label: siblingNpm,
    });
  }
  candidates.push({ command: "npm", args: ["exec", compiler, "--", "--no-clean"], label: "npm" });

  return candidates;
};

const runBuild = async (deps) => {
  let lastError = null;
  for (const invocation of resolveBuildInvocations(deps)) {
    const result = await spawnWithResult(
      invocation.command,
      invocation.args,
      {
        cwd: deps.cwd,
        env: deps.env,
        stdio: "inherit",
      },
      deps,
    );

    if (!result.error) {
      return result;
    }

    lastError = { ...result, invocation };
    if (result.error?.code === "ENOENT") {
      logRunner(`Build command not found: ${invocation.label}`, deps);
      continue;
    }
    return lastError;
  }

  return (
    lastError ?? {
      exitCode: null,
      exitSignal: null,
      error: new Error("No build command available."),
    }
  );
};

const runOpenClaw = async (deps) => {
  const res = await spawnWithResult(
    deps.execPath,
    ["openclaw.mjs", ...deps.args],
    {
      cwd: deps.cwd,
      env: deps.env,
      stdio: "inherit",
    },
    deps,
  );
  if (res.error) {
    logRunner(`Failed to start OpenClaw: ${res.error?.message ?? "unknown error"}`, deps);
    return 1;
  }
  if (res.exitSignal) {
    return 1;
  }
  return res.exitCode ?? 1;
};

const writeBuildStamp = (deps) => {
  try {
    deps.fs.mkdirSync(deps.distRoot, { recursive: true });
    const stamp = {
      builtAt: Date.now(),
      head: resolveGitHead(deps),
    };
    deps.fs.writeFileSync(deps.buildStampPath, `${JSON.stringify(stamp)}\n`);
  } catch (error) {
    // Best-effort stamp; still allow the runner to start.
    logRunner(`Failed to write build stamp: ${error?.message ?? "unknown error"}`, deps);
  }
};

export async function runNodeMain(params = {}) {
  const deps = {
    spawn: params.spawn ?? spawn,
    spawnSync: params.spawnSync ?? spawnSync,
    fs: params.fs ?? fs,
    stderr: params.stderr ?? process.stderr,
    execPath: params.execPath ?? process.execPath,
    cwd: params.cwd ?? process.cwd(),
    args: params.args ?? process.argv.slice(2),
    env: params.env ? { ...params.env } : { ...process.env },
    platform: params.platform ?? process.platform,
  };

  deps.distRoot = path.join(deps.cwd, "dist");
  deps.distEntry = path.join(deps.distRoot, "/entry.js");
  deps.buildStampPath = path.join(deps.distRoot, ".buildstamp");
  deps.srcRoot = path.join(deps.cwd, "src");
  deps.configFiles = [path.join(deps.cwd, "tsconfig.json"), path.join(deps.cwd, "package.json")];

  if (!shouldBuild(deps)) {
    return await runOpenClaw(deps);
  }

  logRunner("Building TypeScript (dist is stale).", deps);
  const buildRes = await runBuild(deps);
  if (buildRes.error) {
    logRunner(`Failed to start build: ${buildRes.error?.message ?? "unknown error"}`, deps);
    return 1;
  }
  if (buildRes.exitSignal) {
    return 1;
  }
  if (buildRes.exitCode !== 0 && buildRes.exitCode !== null) {
    return buildRes.exitCode;
  }
  writeBuildStamp(deps);
  return await runOpenClaw(deps);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runNodeMain()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
