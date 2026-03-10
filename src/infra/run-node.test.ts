import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-run-node-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("run-node script", () => {
  it.runIf(process.platform !== "win32")(
    "preserves control-ui assets by building with tsdown --no-clean",
    async () => {
      await withTempDir(async (tmp) => {
        const argsPath = path.join(tmp, ".pnpm-args.txt");
        const indexPath = path.join(tmp, "dist", "control-ui", "index.html");

        await fs.mkdir(path.dirname(indexPath), { recursive: true });
        await fs.writeFile(indexPath, "<html>sentinel</html>\n", "utf-8");

        const nodeCalls: string[][] = [];
        const spawn = (cmd: string, args: string[]) => {
          if (path.basename(cmd) === "pnpm") {
            fsSync.writeFileSync(argsPath, args.join(" "), "utf-8");
            if (!args.includes("--no-clean")) {
              fsSync.rmSync(path.join(tmp, "dist", "control-ui"), { recursive: true, force: true });
            }
          }
          if (cmd === process.execPath) {
            nodeCalls.push([cmd, ...args]);
          }
          return {
            on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
              if (event === "exit") {
                queueMicrotask(() => cb(0, null));
              }
              return undefined;
            },
          };
        };

        const { runNodeMain } = await import("../../scripts/run-node.mjs");
        const exitCode = await runNodeMain({
          cwd: tmp,
          args: ["--version"],
          env: {
            ...process.env,
            OPENCLAW_FORCE_BUILD: "1",
            OPENCLAW_RUNNER_LOG: "0",
          },
          spawn,
          execPath: process.execPath,
          platform: process.platform,
        });

        expect(exitCode).toBe(0);
        await expect(fs.readFile(argsPath, "utf-8")).resolves.toContain("exec tsdown --no-clean");
        await expect(fs.readFile(indexPath, "utf-8")).resolves.toContain("sentinel");
        expect(nodeCalls).toEqual([[process.execPath, "openclaw.mjs", "--version"]]);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "falls back to sibling npm when pnpm is unavailable",
    async () => {
      await withTempDir(async (tmp) => {
        const toolDir = path.join(tmp, "toolchain");
        const execPath = path.join(toolDir, "node");
        const npmPath = path.join(toolDir, "npm");

        await fs.mkdir(toolDir, { recursive: true });
        await fs.writeFile(execPath, "", "utf-8");
        await fs.writeFile(npmPath, "", "utf-8");

        const spawnCalls: Array<[string, string[]]> = [];
        const spawn = (cmd: string, args: string[]) => {
          spawnCalls.push([cmd, args]);
          return {
            on: (event: string, cb: (...eventArgs: unknown[]) => void) => {
              if (cmd === "pnpm" && event === "error") {
                queueMicrotask(() =>
                  cb(Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT" })),
                );
              }
              if (cmd !== "pnpm" && event === "exit") {
                queueMicrotask(() => cb(0, null));
              }
              return undefined;
            },
          };
        };

        const { runNodeMain } = await import("../../scripts/run-node.mjs");
        const exitCode = await runNodeMain({
          cwd: tmp,
          args: ["gateway"],
          env: {
            ...process.env,
            OPENCLAW_FORCE_BUILD: "1",
            OPENCLAW_RUNNER_LOG: "0",
          },
          spawn,
          execPath,
          platform: process.platform,
        });

        expect(exitCode).toBe(0);
        expect(spawnCalls).toContainEqual(["pnpm", ["exec", "tsdown", "--no-clean"]]);
        expect(spawnCalls).toContainEqual([npmPath, ["exec", "tsdown", "--", "--no-clean"]]);
        expect(spawnCalls.at(-1)).toEqual([execPath, ["openclaw.mjs", "gateway"]]);
        await expect(
          fs.readFile(path.join(tmp, "dist", ".buildstamp"), "utf-8"),
        ).resolves.toContain('"builtAt"');
      });
    },
  );
});
