import { ChannelType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { debugLogs, logDebugMock } = vi.hoisted(() => ({
  debugLogs: [] as string[],
  logDebugMock: vi.fn((message: string) => {
    debugLogs.push(String(message));
  }),
}));
const transcribeFirstAudioMock = vi.hoisted(() => vi.fn());

vi.mock("../../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logger.js")>();
  return {
    ...actual,
    logDebug: (message: string) => logDebugMock(message),
  };
});

vi.mock("../../media-understanding/audio-preflight.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
}));
import {
  __testing as sessionBindingTesting,
  registerSessionBindingAdapter,
} from "../../infra/outbound/session-binding-service.js";
import {
  preflightDiscordMessage,
  resolvePreflightMentionRequirement,
  shouldIgnoreBoundThreadWebhookMessage,
} from "./message-handler.preflight.js";
import {
  __testing as threadBindingTesting,
  createNoopThreadBindingManager,
  createThreadBindingManager,
} from "./thread-bindings.js";

function createThreadBinding(
  overrides?: Partial<
    import("../../infra/outbound/session-binding-service.js").SessionBindingRecord
  >,
) {
  return {
    bindingId: "default:thread-1",
    targetSessionKey: "agent:main:subagent:child-1",
    targetKind: "subagent",
    conversation: {
      channel: "discord",
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "parent-1",
    },
    status: "active",
    boundAt: 1,
    metadata: {
      agentId: "main",
      boundBy: "test",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    },
    ...overrides,
  } satisfies import("../../infra/outbound/session-binding-service.js").SessionBindingRecord;
}

describe("resolvePreflightMentionRequirement", () => {
  it("requires mention when config requires mention and thread is not bound", () => {
    expect(
      resolvePreflightMentionRequirement({
        shouldRequireMention: true,
        isBoundThreadSession: false,
      }),
    ).toBe(true);
  });

  it("disables mention requirement for bound thread sessions", () => {
    expect(
      resolvePreflightMentionRequirement({
        shouldRequireMention: true,
        isBoundThreadSession: true,
      }),
    ).toBe(false);
  });

  it("keeps mention requirement disabled when config already disables it", () => {
    expect(
      resolvePreflightMentionRequirement({
        shouldRequireMention: false,
        isBoundThreadSession: false,
      }),
    ).toBe(false);
  });
});

describe("preflightDiscordMessage", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    transcribeFirstAudioMock.mockReset();
    debugLogs.length = 0;
    logDebugMock.mockClear();
  });

  it("bypasses mention gating in bound threads for allowed bot senders", async () => {
    const threadBinding = createThreadBinding();
    const threadId = "thread-bot-focus";
    const parentId = "channel-parent-focus";
    const client = {
      fetchChannel: async (channelId: string) => {
        if (channelId === threadId) {
          return {
            id: threadId,
            type: ChannelType.PublicThread,
            name: "focus",
            parentId,
            ownerId: "owner-1",
          };
        }
        if (channelId === parentId) {
          return {
            id: parentId,
            type: ChannelType.GuildText,
            name: "general",
          };
        }
        return null;
      },
    } as unknown as import("@buape/carbon").Client;
    const message = {
      id: "m-bot-1",
      content: "relay message without mention",
      timestamp: new Date().toISOString(),
      channelId: threadId,
      attachments: [],
      mentionedUsers: [],
      mentionedRoles: [],
      mentionedEveryone: false,
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "Relay",
      },
    } as unknown as import("@buape/carbon").Message;

    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) => (ref.conversationId === threadId ? threadBinding : null),
    });

    const result = await preflightDiscordMessage({
      cfg: {
        session: {
          mainKey: "main",
          scope: "per-sender",
        },
      } as import("../../config/config.js").OpenClawConfig,
      discordConfig: {
        allowBots: true,
      } as NonNullable<import("../../config/config.js").OpenClawConfig["channels"]>["discord"],
      accountId: "default",
      token: "token",
      runtime: {} as import("../../runtime.js").RuntimeEnv,
      botUserId: "openclaw-bot",
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 1_000_000,
      textLimit: 2_000,
      replyToMode: "all",
      dmEnabled: true,
      groupDmEnabled: true,
      ackReactionScope: "direct",
      groupPolicy: "open",
      threadBindings: createNoopThreadBindingManager("default"),
      data: {
        channel_id: threadId,
        guild_id: "guild-1",
        guild: {
          id: "guild-1",
          name: "Guild One",
        },
        author: message.author,
        message,
      } as unknown as import("./listeners.js").DiscordMessageEvent,
      client,
    });

    expect(result).not.toBeNull();
    expect(result?.boundSessionKey).toBe(threadBinding.targetSessionKey);
    expect(result?.shouldRequireMention).toBe(false);
  });

  it("accepts bot-authored guild mentions from raw mentions payload when allowBots is enabled", async () => {
    const channelId = "channel-bot-mention-1";
    const client = {
      fetchChannel: async (id: string) => {
        if (id === channelId) {
          return {
            id: channelId,
            type: ChannelType.GuildText,
            name: "general",
          };
        }
        return null;
      },
    } as unknown as import("@buape/carbon").Client;

    const message = {
      id: "m-bot-mention-1",
      content: "<@openclaw-bot> status?",
      timestamp: new Date().toISOString(),
      channelId,
      attachments: [],
      mentions: {
        users: [{ id: "openclaw-bot" }],
      },
      mentionedUsers: undefined,
      mentionedRoles: [],
      mentionedEveryone: false,
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "Relay",
      },
    } as unknown as import("@buape/carbon").Message;

    const result = await preflightDiscordMessage({
      cfg: {
        session: {
          mainKey: "main",
          scope: "per-sender",
        },
      } as import("../../config/config.js").OpenClawConfig,
      discordConfig: {
        allowBots: true,
      } as NonNullable<import("../../config/config.js").OpenClawConfig["channels"]>["discord"],
      accountId: "default",
      token: "token",
      runtime: {} as import("../../runtime.js").RuntimeEnv,
      botUserId: "openclaw-bot",
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 1_000_000,
      textLimit: 2_000,
      replyToMode: "all",
      dmEnabled: true,
      groupDmEnabled: true,
      ackReactionScope: "direct",
      groupPolicy: "open",
      threadBindings: createNoopThreadBindingManager("default"),
      data: {
        channel_id: channelId,
        guild_id: "guild-1",
        guild: {
          id: "guild-1",
          name: "Guild One",
        },
        author: message.author,
        message,
      } as unknown as import("./listeners.js").DiscordMessageEvent,
      client,
    });

    expect(result).not.toBeNull();
    expect(result?.wasMentioned).toBe(true);
    expect(result?.effectiveWasMentioned).toBe(true);
  });

  it("emits grep-friendly bot preflight logs for allow/drop decisions", async () => {
    const channelId = "channel-bot-log-1";
    const client = {
      fetchChannel: async (id: string) => {
        if (id === channelId) {
          return {
            id: channelId,
            type: ChannelType.GuildText,
            name: "general",
          };
        }
        return null;
      },
    } as unknown as import("@buape/carbon").Client;

    const mentionedMessage = {
      id: "m-bot-log-allow",
      content: "<@openclaw-bot> status?",
      timestamp: new Date().toISOString(),
      channelId,
      attachments: [],
      mentions: {
        users: [{ id: "openclaw-bot" }],
      },
      mentionedUsers: undefined,
      mentionedRoles: [],
      mentionedEveryone: false,
      author: {
        id: "relay-bot-logs",
        bot: true,
        username: "Relay",
      },
    } as unknown as import("@buape/carbon").Message;

    const droppedMessage = {
      id: "m-bot-log-drop",
      content: "status?",
      timestamp: new Date().toISOString(),
      channelId,
      attachments: [],
      mentions: {
        users: [],
      },
      mentionedUsers: undefined,
      mentionedRoles: [],
      mentionedEveryone: false,
      author: {
        id: "relay-bot-logs",
        bot: true,
        username: "Relay",
      },
    } as unknown as import("@buape/carbon").Message;

    await preflightDiscordMessage({
      cfg: {
        session: {
          mainKey: "main",
          scope: "per-sender",
        },
      } as import("../../config/config.js").OpenClawConfig,
      discordConfig: {
        allowBots: true,
      } as NonNullable<import("../../config/config.js").OpenClawConfig["channels"]>["discord"],
      accountId: "default",
      token: "token",
      runtime: {} as import("../../runtime.js").RuntimeEnv,
      botUserId: "openclaw-bot",
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 1_000_000,
      textLimit: 2_000,
      replyToMode: "all",
      dmEnabled: true,
      groupDmEnabled: true,
      ackReactionScope: "direct",
      groupPolicy: "open",
      threadBindings: createNoopThreadBindingManager("default"),
      data: {
        channel_id: channelId,
        guild_id: "guild-1",
        guild: {
          id: "guild-1",
          name: "Guild One",
        },
        author: mentionedMessage.author,
        message: mentionedMessage,
      } as unknown as import("./listeners.js").DiscordMessageEvent,
      client,
    });

    await preflightDiscordMessage({
      cfg: {
        session: {
          mainKey: "main",
          scope: "per-sender",
        },
      } as import("../../config/config.js").OpenClawConfig,
      discordConfig: {
        allowBots: true,
      } as NonNullable<import("../../config/config.js").OpenClawConfig["channels"]>["discord"],
      accountId: "default",
      token: "token",
      runtime: {} as import("../../runtime.js").RuntimeEnv,
      botUserId: "openclaw-bot",
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 1_000_000,
      textLimit: 2_000,
      replyToMode: "all",
      dmEnabled: true,
      groupDmEnabled: true,
      ackReactionScope: "direct",
      groupPolicy: "open",
      threadBindings: createNoopThreadBindingManager("default"),
      data: {
        channel_id: channelId,
        guild_id: "guild-1",
        guild: {
          id: "guild-1",
          name: "Guild One",
        },
        author: droppedMessage.author,
        message: droppedMessage,
      } as unknown as import("./listeners.js").DiscordMessageEvent,
      client,
    });

    expect(debugLogs).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "[discord-preflight-bot] stage=received messageId=m-bot-log-allow authorId=relay-bot-logs authorBot=true channelId=channel-bot-log-1 guildId=guild-1 botUserId=openclaw-bot allowBots=true requireMention=unknown mentionedUsersSource=none mentionedUsers=none explicitlyMentioned=unknown hasAnyMention=unknown",
        ),
        expect.stringContaining(
          "[discord-preflight-bot] stage=decision messageId=m-bot-log-allow authorId=relay-bot-logs authorBot=true channelId=channel-bot-log-1 guildId=guild-1 botUserId=openclaw-bot allowBots=true requireMention=true mentionedUsersSource=message.mentions.users mentionedUsers=openclaw-bot explicitlyMentioned=true hasAnyMention=true decision=allow dropReason=none",
        ),
        expect.stringContaining(
          "[discord-preflight-bot] stage=decision messageId=m-bot-log-drop authorId=relay-bot-logs authorBot=true channelId=channel-bot-log-1 guildId=guild-1 botUserId=openclaw-bot allowBots=true requireMention=true mentionedUsersSource=message.mentions.users mentionedUsers=none explicitlyMentioned=false hasAnyMention=false decision=drop dropReason=no-mention",
        ),
      ]),
    );
  });

  it("still drops bot-authored guild messages without mentions when allowBots is enabled", async () => {
    const channelId = "channel-bot-no-mention-1";
    const client = {
      fetchChannel: async (id: string) => {
        if (id === channelId) {
          return {
            id: channelId,
            type: ChannelType.GuildText,
            name: "general",
          };
        }
        return null;
      },
    } as unknown as import("@buape/carbon").Client;

    const message = {
      id: "m-bot-no-mention-1",
      content: "status?",
      timestamp: new Date().toISOString(),
      channelId,
      attachments: [],
      mentions: {
        users: [],
      },
      mentionedUsers: undefined,
      mentionedRoles: [],
      mentionedEveryone: false,
      author: {
        id: "relay-bot-2",
        bot: true,
        username: "Relay",
      },
    } as unknown as import("@buape/carbon").Message;

    const result = await preflightDiscordMessage({
      cfg: {
        session: {
          mainKey: "main",
          scope: "per-sender",
        },
      } as import("../../config/config.js").OpenClawConfig,
      discordConfig: {
        allowBots: true,
      } as NonNullable<import("../../config/config.js").OpenClawConfig["channels"]>["discord"],
      accountId: "default",
      token: "token",
      runtime: {} as import("../../runtime.js").RuntimeEnv,
      botUserId: "openclaw-bot",
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 1_000_000,
      textLimit: 2_000,
      replyToMode: "all",
      dmEnabled: true,
      groupDmEnabled: true,
      ackReactionScope: "direct",
      groupPolicy: "open",
      threadBindings: createNoopThreadBindingManager("default"),
      data: {
        channel_id: channelId,
        guild_id: "guild-1",
        guild: {
          id: "guild-1",
          name: "Guild One",
        },
        author: message.author,
        message,
      } as unknown as import("./listeners.js").DiscordMessageEvent,
      client,
    });

    expect(result).toBeNull();
  });

  it("still drops self-authored bot messages even when allowBots is enabled", async () => {
    const channelId = "channel-self-bot-1";
    const client = {
      fetchChannel: async (id: string) => {
        if (id === channelId) {
          return {
            id: channelId,
            type: ChannelType.GuildText,
            name: "general",
          };
        }
        return null;
      },
    } as unknown as import("@buape/carbon").Client;

    const message = {
      id: "m-self-bot-1",
      content: "<@openclaw-bot> echo",
      timestamp: new Date().toISOString(),
      channelId,
      attachments: [],
      mentions: {
        users: [{ id: "openclaw-bot" }],
      },
      mentionedUsers: undefined,
      mentionedRoles: [],
      mentionedEveryone: false,
      author: {
        id: "openclaw-bot",
        bot: true,
        username: "OpenClaw",
      },
    } as unknown as import("@buape/carbon").Message;

    const result = await preflightDiscordMessage({
      cfg: {
        session: {
          mainKey: "main",
          scope: "per-sender",
        },
      } as import("../../config/config.js").OpenClawConfig,
      discordConfig: {
        allowBots: true,
      } as NonNullable<import("../../config/config.js").OpenClawConfig["channels"]>["discord"],
      accountId: "default",
      token: "token",
      runtime: {} as import("../../runtime.js").RuntimeEnv,
      botUserId: "openclaw-bot",
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 1_000_000,
      textLimit: 2_000,
      replyToMode: "all",
      dmEnabled: true,
      groupDmEnabled: true,
      ackReactionScope: "direct",
      groupPolicy: "open",
      threadBindings: createNoopThreadBindingManager("default"),
      data: {
        channel_id: channelId,
        guild_id: "guild-1",
        guild: {
          id: "guild-1",
          name: "Guild One",
        },
        author: message.author,
        message,
      } as unknown as import("./listeners.js").DiscordMessageEvent,
      client,
    });

    expect(result).toBeNull();
  });

  it("uses attachment content_type for guild audio preflight mention detection", async () => {
    transcribeFirstAudioMock.mockResolvedValue("hey openclaw");

    const channelId = "channel-audio-1";
    const client = {
      fetchChannel: async (id: string) => {
        if (id === channelId) {
          return {
            id: channelId,
            type: ChannelType.GuildText,
            name: "general",
          };
        }
        return null;
      },
    } as unknown as import("@buape/carbon").Client;

    const message = {
      id: "m-audio-1",
      content: "",
      timestamp: new Date().toISOString(),
      channelId,
      attachments: [
        {
          id: "att-1",
          url: "https://cdn.discordapp.com/attachments/voice.ogg",
          content_type: "audio/ogg",
          filename: "voice.ogg",
        },
      ],
      mentionedUsers: [],
      mentionedRoles: [],
      mentionedEveryone: false,
      author: {
        id: "user-1",
        bot: false,
        username: "Alice",
      },
    } as unknown as import("@buape/carbon").Message;

    const result = await preflightDiscordMessage({
      cfg: {
        session: {
          mainKey: "main",
          scope: "per-sender",
        },
        messages: {
          groupChat: {
            mentionPatterns: ["openclaw"],
          },
        },
      } as import("../../config/config.js").OpenClawConfig,
      discordConfig: {} as NonNullable<
        import("../../config/config.js").OpenClawConfig["channels"]
      >["discord"],
      accountId: "default",
      token: "token",
      runtime: {} as import("../../runtime.js").RuntimeEnv,
      botUserId: "openclaw-bot",
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 1_000_000,
      textLimit: 2_000,
      replyToMode: "all",
      dmEnabled: true,
      groupDmEnabled: true,
      ackReactionScope: "direct",
      groupPolicy: "open",
      threadBindings: createNoopThreadBindingManager("default"),
      data: {
        channel_id: channelId,
        guild_id: "guild-1",
        guild: {
          id: "guild-1",
          name: "Guild One",
        },
        author: message.author,
        message,
      } as unknown as import("./listeners.js").DiscordMessageEvent,
      client,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(transcribeFirstAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          MediaUrls: ["https://cdn.discordapp.com/attachments/voice.ogg"],
          MediaTypes: ["audio/ogg"],
        }),
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.wasMentioned).toBe(true);
  });

  it("logs raw ingress before preflight for app/webhook-shaped payloads", async () => {
    const channelId = "channel-raw-log-1";
    const client = {
      fetchChannel: async (id: string) => {
        if (id === channelId) {
          return {
            id: channelId,
            type: ChannelType.GuildText,
            name: "general",
          };
        }
        return null;
      },
    } as unknown as import("@buape/carbon").Client;

    const message = {
      id: "m-raw-log-1",
      content: "",
      timestamp: new Date().toISOString(),
      channelId,
      attachments: [],
      mentions: {
        users: [{ id: "openclaw-bot" }],
      },
      mentionedUsers: undefined,
      mentionedRoles: [],
      mentionedEveryone: false,
      webhook_id: "wh-raw-1",
      application_id: "app-raw-1",
      type: 0,
      author: {
        id: "relay-app-1",
        bot: true,
        username: "Relay",
      },
      rawData: {
        webhook_id: "wh-raw-1",
        application_id: "app-raw-1",
        author: {
          id: "relay-app-1",
          bot: true,
        },
      },
    } as unknown as import("@buape/carbon").Message;

    const result = await preflightDiscordMessage({
      cfg: {
        session: {
          mainKey: "main",
          scope: "per-sender",
        },
      } as import("../../config/config.js").OpenClawConfig,
      discordConfig: {
        allowBots: true,
      } as NonNullable<import("../../config/config.js").OpenClawConfig["channels"]>["discord"],
      accountId: "default",
      token: "token",
      runtime: {} as import("../../runtime.js").RuntimeEnv,
      botUserId: "openclaw-bot",
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 1_000_000,
      textLimit: 2_000,
      replyToMode: "all",
      dmEnabled: true,
      groupDmEnabled: true,
      ackReactionScope: "direct",
      groupPolicy: "open",
      threadBindings: createNoopThreadBindingManager("default"),
      data: {
        channel_id: channelId,
        guild_id: "guild-1",
        guild: {
          id: "guild-1",
          name: "Guild One",
        },
        author: undefined,
        message,
      } as unknown as import("./listeners.js").DiscordMessageEvent,
      client,
    });

    expect(result).toBeNull();
    expect(debugLogs).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "[discord-raw] event=MESSAGE_CREATE stage=preflight-received messageId=m-raw-log-1 channelId=channel-raw-log-1 guildId=guild-1 authorId=relay-app-1 authorBot=true webhookId=wh-raw-1 applicationId=app-raw-1 type=0 content=empty mentions=openclaw-bot authorPresent=yes",
        ),
      ]),
    );
    expect(
      debugLogs.some(
        (line) => line.includes("stage=preflight-drop") && line.includes("m-raw-log-1"),
      ),
    ).toBe(false);
  });

  it("falls back to message.author when event author is missing", async () => {
    const channelId = "channel-author-fallback-1";
    const client = {
      fetchChannel: async (id: string) => {
        if (id === channelId) {
          return {
            id: channelId,
            type: ChannelType.GuildText,
            name: "general",
          };
        }
        return null;
      },
    } as unknown as import("@buape/carbon").Client;

    const message = {
      id: "m-author-fallback-1",
      content: "<@openclaw-bot> status?",
      timestamp: new Date().toISOString(),
      channelId,
      attachments: [],
      mentions: {
        users: [{ id: "openclaw-bot" }],
      },
      mentionedUsers: undefined,
      mentionedRoles: [],
      mentionedEveryone: false,
      author: {
        id: "relay-app-2",
        bot: true,
        username: "Relay",
      },
      webhook_id: "wh-app-2",
      application_id: "app-2",
      rawData: {
        webhook_id: "wh-app-2",
        application_id: "app-2",
      },
    } as unknown as import("@buape/carbon").Message;

    const result = await preflightDiscordMessage({
      cfg: {
        session: {
          mainKey: "main",
          scope: "per-sender",
        },
      } as import("../../config/config.js").OpenClawConfig,
      discordConfig: {
        allowBots: true,
      } as NonNullable<import("../../config/config.js").OpenClawConfig["channels"]>["discord"],
      accountId: "default",
      token: "token",
      runtime: {} as import("../../runtime.js").RuntimeEnv,
      botUserId: "openclaw-bot",
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 1_000_000,
      textLimit: 2_000,
      replyToMode: "all",
      dmEnabled: true,
      groupDmEnabled: true,
      ackReactionScope: "direct",
      groupPolicy: "open",
      threadBindings: createNoopThreadBindingManager("default"),
      data: {
        channel_id: channelId,
        guild_id: "guild-1",
        guild: {
          id: "guild-1",
          name: "Guild One",
        },
        author: undefined,
        message,
      } as unknown as import("./listeners.js").DiscordMessageEvent,
      client,
    });

    expect(result).not.toBeNull();
    expect(result?.author.id).toBe("relay-app-2");
  });
});

describe("shouldIgnoreBoundThreadWebhookMessage", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    threadBindingTesting.resetThreadBindingsForTests();
  });

  it("returns true when inbound webhook id matches the bound thread webhook", () => {
    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        webhookId: "wh-1",
        threadBinding: createThreadBinding(),
      }),
    ).toBe(true);
  });

  it("returns false when webhook ids differ", () => {
    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        webhookId: "wh-other",
        threadBinding: createThreadBinding(),
      }),
    ).toBe(false);
  });

  it("returns false when there is no bound thread webhook", () => {
    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        webhookId: "wh-1",
        threadBinding: createThreadBinding({
          metadata: {
            webhookId: undefined,
          },
        }),
      }),
    ).toBe(false);
  });

  it("returns true for recently unbound thread webhook echoes", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });
    const binding = await manager.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child-1",
      agentId: "main",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });
    expect(binding).not.toBeNull();

    manager.unbindThread({
      threadId: "thread-1",
      sendFarewell: false,
    });

    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        accountId: "default",
        threadId: "thread-1",
        webhookId: "wh-1",
      }),
    ).toBe(true);
  });
});
