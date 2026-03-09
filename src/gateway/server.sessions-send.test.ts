import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, type Mock, vi } from "vitest";
import { resolveSessionTranscriptPath } from "../config/sessions.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { captureEnv } from "../test-utils/env.js";
import {
  agentCommand,
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
  testState,
} from "./test-helpers.js";

const { createOpenClawTools } = await import("../agents/openclaw-tools.js");

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startGatewayServer>>;
let gatewayPort: number;
const gatewayToken = "test-token";
let envSnapshot: ReturnType<typeof captureEnv>;

type SessionSendTool = ReturnType<typeof createOpenClawTools>[number];
const SESSION_SEND_E2E_TIMEOUT_MS = 10_000;
let cachedSessionsSendTool: SessionSendTool | null = null;

function getSessionsSendTool(): SessionSendTool {
  if (cachedSessionsSendTool) {
    return cachedSessionsSendTool;
  }
  const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_send");
  if (!tool) {
    throw new Error("missing sessions_send tool");
  }
  cachedSessionsSendTool = tool;
  return cachedSessionsSendTool;
}

async function emitLifecycleAssistantReply(params: {
  opts: unknown;
  defaultSessionId: string;
  includeTimestamp?: boolean;
  resolveText: (extraSystemPrompt?: string) => string;
}) {
  const commandParams = params.opts as {
    sessionId?: string;
    runId?: string;
    extraSystemPrompt?: string;
  };
  const sessionId = commandParams.sessionId ?? params.defaultSessionId;
  const runId = commandParams.runId ?? sessionId;
  const sessionFile = resolveSessionTranscriptPath(sessionId);
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });

  const startedAt = Date.now();
  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: { phase: "start", startedAt },
  });

  const text = params.resolveText(commandParams.extraSystemPrompt);
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    ...(params.includeTimestamp ? { timestamp: Date.now() } : {}),
  };
  await fs.appendFile(sessionFile, `${JSON.stringify({ message })}\n`, "utf8");

  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: { phase: "end", startedAt, endedAt: Date.now() },
  });
}

beforeAll(async () => {
  envSnapshot = captureEnv(["OPENCLAW_GATEWAY_PORT", "OPENCLAW_GATEWAY_TOKEN"]);
  gatewayPort = await getFreePort();
  testState.gatewayAuth = { mode: "token", token: gatewayToken };
  process.env.OPENCLAW_GATEWAY_PORT = String(gatewayPort);
  process.env.OPENCLAW_GATEWAY_TOKEN = gatewayToken;
  const { approveDevicePairing, requestDevicePairing } = await import("../infra/device-pairing.js");
  const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } =
    await import("../infra/device-identity.js");
  const identity = loadOrCreateDeviceIdentity();
  const pending = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    clientId: "openclaw-cli",
    clientMode: "cli",
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
    silent: false,
  });
  await approveDevicePairing(pending.request.requestId);
  server = await startGatewayServer(gatewayPort);
});

afterAll(async () => {
  await server.close();
  envSnapshot.restore();
});

describe("sessions_send gateway loopback", () => {
  it("returns reply when lifecycle ends before agent.wait", async () => {
    const tool = getSessionsSendTool();
    const callGatewayModule = await import("../gateway/call.js");
    const gatewaySpy = vi.spyOn(callGatewayModule, "callGateway");
    const spy = agentCommand as unknown as Mock<(opts: unknown) => Promise<void>>;
    spy.mockImplementation(async (opts: unknown) =>
      emitLifecycleAssistantReply({
        opts,
        defaultSessionId: "main",
        includeTimestamp: true,
        resolveText: (extraSystemPrompt) => {
          if (extraSystemPrompt?.includes("Agent-to-agent reply step")) {
            return "REPLY_SKIP";
          }
          if (extraSystemPrompt?.includes("Agent-to-agent announce step")) {
            return "ANNOUNCE_SKIP";
          }
          return "pong";
        },
      }),
    );

    gatewaySpy.mockImplementation(async (opts: Record<string, unknown>) => {
      const method = opts.method;
      if (method === "agent") {
        return { runId: "run-loopback-1" };
      }
      if (method === "agent.wait") {
        await emitLifecycleAssistantReply({
          opts: { sessionId: "main", runId: "run-loopback-1", extraSystemPrompt: "" },
          defaultSessionId: "main",
          includeTimestamp: true,
          resolveText: () => "pong",
        });
        return { status: "ok" };
      }
      if (method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "pong" }],
              timestamp: Date.now(),
            },
          ],
        };
      }
      throw new Error(`unexpected method: ${String(method)}`);
    });

    const result = await tool.execute("call-loopback", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 5,
    });
    const details = result.details as {
      status?: string;
      reply?: string;
      sessionKey?: string;
    };
    expect(details.status).toBe("ok");
    expect(details.reply).toBe("pong");
    expect(details.sessionKey).toBe("main");

    const agentCall = gatewaySpy.mock.calls.find(
      ([opts]) => (opts as { method?: string }).method === "agent",
    )?.[0] as
      | { params?: { lane?: string; inputProvenance?: { kind?: string; sourceTool?: string } } }
      | undefined;
    expect(agentCall?.params?.lane).toBe("nested");
    expect(agentCall?.params?.inputProvenance).toMatchObject({
      kind: "inter_session",
      sourceTool: "sessions_send",
    });
    gatewaySpy.mockRestore();
  });
});

describe("sessions_send label lookup", () => {
  it(
    "finds session by label and sends message",
    { timeout: SESSION_SEND_E2E_TIMEOUT_MS },
    async () => {
      process.env.OPENCLAW_GATEWAY_TOKEN = gatewayToken;
      // This is an operator feature; enable broader session tool targeting for this test.
      const configPath = process.env.OPENCLAW_CONFIG_PATH;
      if (!configPath) {
        throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
      }
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ tools: { sessions: { visibility: "all" } } }, null, 2) + "\n",
        "utf-8",
      );

      // Some gateway suites temporarily clear the auth env while spinning up isolated
      // websocket harnesses. Reassert the loopback token before this direct callGateway
      // setup step so the shared gateway server remains reachable when this file runs in
      // broader batches.
      process.env.OPENCLAW_GATEWAY_TOKEN = gatewayToken;

      const tool = getSessionsSendTool();
      const callGatewayMock = await import("../gateway/call.js");
      const gatewaySpy = vi.spyOn(callGatewayMock, "callGateway");

      gatewaySpy.mockImplementation(async (opts: Record<string, unknown>) => {
        const method = opts.method;
        if (method === "sessions.resolve") {
          return { key: "agent:main:test-labeled-session" };
        }
        if (method === "agent") {
          return { runId: "run-labeled-1" };
        }
        if (method === "agent.wait") {
          return { status: "ok" };
        }
        if (method === "chat.history") {
          return {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "labeled response" }],
                timestamp: Date.now(),
              },
            ],
          };
        }
        throw new Error(`unexpected method: ${String(method)}`);
      });

      // Send using label instead of sessionKey
      const result = await tool.execute("call-by-label", {
        label: "my-test-worker",
        message: "hello labeled session",
        timeoutSeconds: 5,
      });
      const details = result.details as {
        status?: string;
        reply?: string;
        sessionKey?: string;
      };
      expect(details.status).toBe("ok");
      expect(details.reply).toBe("labeled response");
      expect(details.sessionKey).toBe("agent:main:test-labeled-session");
      gatewaySpy.mockRestore();
    },
  );
});
