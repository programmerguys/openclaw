import { describe, expect, it, vi } from "vitest";
import { DiscordGatewayDispatchTapListener, DiscordMessageListener } from "./listeners.js";

function createLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  };
}

function fakeEvent(channelId: string, overrides?: Record<string, unknown>) {
  return {
    channel_id: channelId,
    guild_id: "guild-1",
    author: {
      id: "author-1",
      bot: false,
    },
    message: {
      id: "message-1",
      channelId,
      content: "hello",
      mentionedUsers: [],
      mentionedRoles: [],
      mentionedEveryone: false,
      ...overrides,
    },
    ...overrides,
  } as never;
}

describe("DiscordGatewayDispatchTapListener", () => {
  it("emits grep-friendly raw ingress logs at gateway-dispatch stage", async () => {
    const debugSpy = vi.spyOn(await import("../../logger.js"), "logDebug");
    const listener = new DiscordGatewayDispatchTapListener();

    await expect(
      listener.handle(
        fakeEvent("ch-dispatch-1", {
          author: undefined,
          message: {
            id: "message-dispatch-1",
            channelId: "ch-dispatch-1",
            content: "",
            type: 0,
            webhook_id: "wh-dispatch-1",
            application_id: "app-dispatch-1",
            mentions: { users: [{ id: "bot-dispatch-1" }, { id: "bot-dispatch-2" }] },
            rawData: {
              webhook_id: "wh-dispatch-1",
              application_id: "app-dispatch-1",
              author: { id: "relay-dispatch-1", bot: true },
            },
          },
        }),
        {} as never,
      ),
    ).resolves.toBeUndefined();

    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[discord-raw] event=MESSAGE_CREATE stage=gateway-dispatch messageId=message-dispatch-1 channelId=ch-dispatch-1 guildId=guild-1 authorId=relay-dispatch-1 authorBot=true webhookId=wh-dispatch-1 applicationId=app-dispatch-1 type=0 content=empty mentions=bot-dispatch-1,bot-dispatch-2 authorPresent=no",
      ),
    );
    debugSpy.mockRestore();
  });
});

describe("DiscordMessageListener", () => {
  it("returns immediately without awaiting handler completion", async () => {
    let resolveHandler: (() => void) | undefined;
    const handlerDone = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });
    const handler = vi.fn(async () => {
      await handlerDone;
    });
    const logger = createLogger();
    const listener = new DiscordMessageListener(handler as never, logger as never);

    await expect(listener.handle(fakeEvent("ch-1"), {} as never)).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();

    resolveHandler?.();
    await handlerDone;
  });

  it("serializes queued handler runs for the same channel", async () => {
    let firstResolve: (() => void) | undefined;
    let secondResolve: (() => void) | undefined;
    const firstDone = new Promise<void>((resolve) => {
      firstResolve = resolve;
    });
    const secondDone = new Promise<void>((resolve) => {
      secondResolve = resolve;
    });
    let runCount = 0;
    const handler = vi.fn(async () => {
      runCount += 1;
      if (runCount === 1) {
        await firstDone;
        return;
      }
      await secondDone;
    });
    const listener = new DiscordMessageListener(handler as never, createLogger() as never);

    await expect(listener.handle(fakeEvent("ch-1"), {} as never)).resolves.toBeUndefined();
    await expect(listener.handle(fakeEvent("ch-1"), {} as never)).resolves.toBeUndefined();

    expect(handler).toHaveBeenCalledTimes(1);
    firstResolve?.();
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(2);
    });

    secondResolve?.();
    await secondDone;
  });

  it("runs handlers for different channels in parallel", async () => {
    let resolveA: (() => void) | undefined;
    let resolveB: (() => void) | undefined;
    const doneA = new Promise<void>((r) => {
      resolveA = r;
    });
    const doneB = new Promise<void>((r) => {
      resolveB = r;
    });
    const order: string[] = [];
    const handler = vi.fn(async (data: { channel_id: string }) => {
      order.push(`start:${data.channel_id}`);
      if (data.channel_id === "ch-a") {
        await doneA;
      } else {
        await doneB;
      }
      order.push(`end:${data.channel_id}`);
    });
    const listener = new DiscordMessageListener(handler as never, createLogger() as never);

    await listener.handle(fakeEvent("ch-a"), {} as never);
    await listener.handle(fakeEvent("ch-b"), {} as never);

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(2);
    });
    expect(order).toContain("start:ch-a");
    expect(order).toContain("start:ch-b");

    resolveB?.();
    await vi.waitFor(() => {
      expect(order).toContain("end:ch-b");
    });
    expect(order).not.toContain("end:ch-a");

    resolveA?.();
    await vi.waitFor(() => {
      expect(order).toContain("end:ch-a");
    });
  });

  it("logs async handler failures", async () => {
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    const logger = createLogger();
    const listener = new DiscordMessageListener(handler as never, logger as never);

    await expect(listener.handle(fakeEvent("ch-1"), {} as never)).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("discord handler failed: Error: boom"),
      );
    });
  });

  it("emits grep-friendly raw ingress logs before dispatch", async () => {
    const debugSpy = vi.spyOn(await import("../../logger.js"), "logDebug");
    const handler = vi.fn(async () => {});
    const listener = new DiscordMessageListener(handler as never, createLogger() as never);

    await expect(
      listener.handle(
        fakeEvent("ch-raw-1", {
          author: undefined,
          message: {
            id: "message-raw-1",
            channelId: "ch-raw-1",
            content: "",
            type: 0,
            webhook_id: "wh-1",
            application_id: "app-1",
            mentions: { users: [{ id: "bot-1" }] },
            rawData: {
              webhook_id: "wh-1",
              application_id: "app-1",
              author: { id: "relay-1", bot: true },
            },
          },
        }),
        {} as never,
      ),
    ).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[discord-raw] event=MESSAGE_CREATE messageId=message-raw-1 channelId=ch-raw-1 guildId=guild-1 authorId=relay-1 authorBot=true webhookId=wh-1 applicationId=app-1 type=0 content=empty mentions=bot-1 authorPresent=no",
        ),
      );
    });
    debugSpy.mockRestore();
  });
});
