import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  buildPendingHistoryContextFromMap,
  recordPendingHistoryEntryIfEnabled,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
} from "openclaw/plugin-sdk";
import type { FeishuConfig, FeishuMessageContext, FeishuMediaInfo } from "./types.js";
import { getFeishuRuntime } from "./runtime.js";
import { createFeishuClient } from "./client.js";
import {
  resolveFeishuGroupConfig,
  resolveFeishuReplyPolicy,
  resolveFeishuAllowlistMatch,
  isFeishuGroupAllowed,
} from "./policy.js";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { getMessageFeishu } from "./send.js";
import { downloadImageFeishu, downloadMessageResourceFeishu } from "./media.js";

// --- Sender name resolution (so the agent can distinguish who is speaking in group chats) ---
// Cache display names by open_id to avoid an API call on every message.
const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const senderNameCache = new Map<string, { name: string; expireAt: number }>();

async function resolveFeishuSenderName(params: {
  feishuCfg?: FeishuConfig;
  senderOpenId: string;
  log: (...args: any[]) => void;
}): Promise<string | undefined> {
  const { feishuCfg, senderOpenId, log } = params;
  if (!feishuCfg) return undefined;
  if (!senderOpenId) return undefined;

  const cached = senderNameCache.get(senderOpenId);
  const now = Date.now();
  if (cached && cached.expireAt > now) return cached.name;

  try {
    const client = createFeishuClient(feishuCfg);

    // contact/v3/users/:user_id?user_id_type=open_id
    const res: any = await client.contact.user.get({
      path: { user_id: senderOpenId },
      params: { user_id_type: "open_id" },
    });

    const name: string | undefined =
      res?.data?.user?.name ||
      res?.data?.user?.display_name ||
      res?.data?.user?.nickname ||
      res?.data?.user?.en_name;

    if (name && typeof name === "string") {
      senderNameCache.set(senderOpenId, { name, expireAt: now + SENDER_NAME_TTL_MS });
      return name;
    }

    return undefined;
  } catch (err) {
    // Best-effort. Don't fail message handling if name lookup fails.
    log(`feishu: failed to resolve sender name for ${senderOpenId}: ${String(err)}`);
    return undefined;
  }
}

export type FeishuMessageEvent = {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    chat_id: string;
    chat_type: "p2p" | "group";
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
  };
};

export type FeishuBotAddedEvent = {
  chat_id: string;
  operator_id: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  external: boolean;
  operator_tenant_key?: string;
};

function parseMessageContent(content: string, messageType: string): string {
  try {
    const parsed = JSON.parse(content);
    if (messageType === "text") {
      return parsed.text || "";
    }
    if (messageType === "post") {
      // Extract text content from rich text post
      const { textContent } = parsePostContent(content);
      return textContent;
    }
    if (messageType === "merge_forward") {
      return "[合并转发消息]";
    }
    return content;
  } catch {
    return content;
  }
}

/**
 * Parse a single sub-message body based on its type.
 */
function parseSubMessageText(msgType: string, content: string): string {
  switch (msgType) {
    case "text":
      try {
        return JSON.parse(content).text ?? content;
      } catch {
        return content;
      }
    case "post":
      return parsePostContent(content).textContent;
    case "image":
      return "[图片]";
    case "file":
      return "[文件]";
    case "audio":
      return "[语音]";
    case "video":
      return "[视频]";
    case "sticker":
      return "[表情]";
    case "merge_forward":
      return "[合并转发消息]";
    default:
      return `[${msgType}]`;
  }
}

/**
 * Fetch and format sub-messages from a merge_forward (合并转发) message.
 *
 * Strategy:
 *  1. im.message.get on the merge_forward message — check if items[] has sub-messages
 *  2. im.message.list with container_id_type=chat, filter by upper_message_id
 *  3. Fallback: return placeholder with guidance
 */
async function resolveMergeForwardContent(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  chatId: string;
  rawContent: string;
  log: (...args: any[]) => void;
}): Promise<string> {
  const { cfg, messageId, chatId, rawContent, log } = params;
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  if (!feishuCfg) return "[合并转发消息]";

  log(`feishu: merge_forward raw content (${messageId}): ${rawContent.slice(0, 500)}`);

  type SubMessage = {
    msg_type?: string;
    body?: { content: string };
    sender?: { id: string; id_type: string; sender_type: string };
    create_time?: string;
    upper_message_id?: string;
  };

  const client = createFeishuClient(feishuCfg);

  // ---------- Strategy 1: im.message.get — might return sub-messages in items[] ----------
  try {
    const response: any = await client.im.message.get({
      path: { message_id: messageId },
    });

    if (response.code === 0 && response.data?.items) {
      const items: SubMessage[] = response.data.items;
      log(`feishu: merge_forward get returned ${items.length} item(s), keys: ${JSON.stringify(Object.keys(response.data))}`);

      // If items has more than 1 entry, the extra ones may be sub-messages
      const subItems = items.filter(
        (it) => it.msg_type !== "merge_forward" || it.upper_message_id === messageId,
      );
      // Also check: even the single item might carry sub-message data in body.content
      if (items.length === 1) {
        const body = items[0]?.body?.content ?? "";
        log(`feishu: merge_forward single item body (first 500): ${body.slice(0, 500)}`);
      }

      if (subItems.length > 0 && subItems.some((it) => it.msg_type !== "merge_forward")) {
        const formatted = await formatSubMessages(subItems, feishuCfg, log);
        log(`feishu: resolved merge_forward via get API with ${subItems.length} sub-message(s)`);
        return formatted;
      }
    } else {
      log(`feishu: merge_forward get returned code ${response.code}: ${response.msg}`);
    }
  } catch (err) {
    log(`feishu: merge_forward get API failed: ${String(err)}`);
  }

  // ---------- Strategy 2: list chat messages, filter by upper_message_id ----------
  try {
    const response: any = await client.im.message.list({
      params: {
        container_id_type: "chat",
        container_id: chatId,
        page_size: 50,
        sort_type: "ByCreateTimeDesc" as const,
      },
    });

    if (response.code === 0 && response.data?.items) {
      const items: SubMessage[] = response.data.items;
      const subItems = items.filter((it) => it.upper_message_id === messageId);
      log(`feishu: chat list returned ${items.length} messages, ${subItems.length} have upper_message_id matching`);

      if (subItems.length > 0) {
        const formatted = await formatSubMessages(subItems, feishuCfg, log);
        log(`feishu: resolved merge_forward via chat list with ${subItems.length} sub-message(s)`);
        return formatted;
      }
    } else {
      log(`feishu: merge_forward chat list returned code ${response.code}: ${response.msg}`);
    }
  } catch (err) {
    log(`feishu: merge_forward chat list failed: ${String(err)}`);
  }

  log(`feishu: merge_forward could not be resolved for ${messageId}`);
  return "[合并转发消息 - 无法解析子消息内容，请尝试复制粘贴或截图发送]";
}

/**
 * Format a Feishu timestamp (ms string) into "MM-DD HH:mm".
 */
function formatFeishuTime(createTime?: string): string {
  if (!createTime) return "";
  const ms = parseInt(createTime, 10);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

/**
 * Format an array of sub-messages into readable text with sender names and timestamps.
 */
async function formatSubMessages(
  items: Array<{
    msg_type?: string;
    body?: { content: string };
    sender?: { id: string; id_type: string; sender_type: string };
    create_time?: string;
  }>,
  feishuCfg: FeishuConfig,
  log: (...args: any[]) => void,
): Promise<string> {
  // Resolve sender names (best-effort, deduplicated)
  const senderNames = new Map<string, string>();
  const uniqueOpenIds = new Set<string>();
  for (const item of items) {
    if (item.sender?.id_type === "open_id" && item.sender.id) {
      uniqueOpenIds.add(item.sender.id);
    }
  }
  await Promise.all(
    [...uniqueOpenIds].map(async (openId) => {
      const name = await resolveFeishuSenderName({ feishuCfg, senderOpenId: openId, log });
      if (name) senderNames.set(openId, name);
    }),
  );

  const lines: string[] = ["[合并转发消息]"];
  for (const item of items) {
    const msgType = item.msg_type ?? "text";
    const content = item.body?.content ?? "";
    const senderId = item.sender?.id ?? "unknown";
    const speaker =
      (item.sender?.id_type === "open_id" && senderNames.get(senderId)) || senderId;
    const text = parseSubMessageText(msgType, content);
    const time = formatFeishuTime(item.create_time);
    lines.push(time ? `- [${time}] ${speaker}: ${text}` : `- ${speaker}: ${text}`);
  }

  return lines.join("\n");
}

function checkBotMentioned(event: FeishuMessageEvent, botOpenId?: string): boolean {
  const mentions = event.message.mentions ?? [];
  if (mentions.length === 0) return false;
  if (!botOpenId) return mentions.length > 0;
  return mentions.some((m) => m.id.open_id === botOpenId);
}

function stripBotMention(text: string, mentions?: FeishuMessageEvent["message"]["mentions"]): string {
  if (!mentions || mentions.length === 0) return text;
  let result = text;
  for (const mention of mentions) {
    result = result.replace(new RegExp(`@${mention.name}\\s*`, "g"), "").trim();
    result = result.replace(new RegExp(mention.key, "g"), "").trim();
  }
  return result;
}

/**
 * Parse media keys from message content based on message type.
 */
function parseMediaKeys(
  content: string,
  messageType: string,
): {
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
} {
  try {
    const parsed = JSON.parse(content);
    switch (messageType) {
      case "image":
        return { imageKey: parsed.image_key };
      case "file":
        return { fileKey: parsed.file_key, fileName: parsed.file_name };
      case "audio":
        return { fileKey: parsed.file_key };
      case "video":
        // Video has both file_key (video) and image_key (thumbnail)
        return { fileKey: parsed.file_key, imageKey: parsed.image_key };
      case "sticker":
        return { fileKey: parsed.file_key };
      default:
        return {};
    }
  } catch {
    return {};
  }
}

/**
 * Parse post (rich text) content and extract embedded image keys.
 * Post structure: { title?: string, content: [[{ tag, text?, image_key?, ... }]] }
 */
function parsePostContent(content: string): {
  textContent: string;
  imageKeys: string[];
} {
  try {
    const parsed = JSON.parse(content);
    const title = parsed.title || "";
    const contentBlocks = parsed.content || [];
    let textContent = title ? `${title}\n\n` : "";
    const imageKeys: string[] = [];

    for (const paragraph of contentBlocks) {
      if (Array.isArray(paragraph)) {
        for (const element of paragraph) {
          if (element.tag === "text") {
            textContent += element.text || "";
          } else if (element.tag === "a") {
            // Link: show text or href
            textContent += element.text || element.href || "";
          } else if (element.tag === "at") {
            // Mention: @username
            textContent += `@${element.user_name || element.user_id || ""}`;
          } else if (element.tag === "img" && element.image_key) {
            // Embedded image
            imageKeys.push(element.image_key);
          }
        }
        textContent += "\n";
      }
    }

    return {
      textContent: textContent.trim() || "[富文本消息]",
      imageKeys,
    };
  } catch {
    return { textContent: "[富文本消息]", imageKeys: [] };
  }
}

/**
 * Infer placeholder text based on message type.
 */
function inferPlaceholder(messageType: string): string {
  switch (messageType) {
    case "image":
      return "<media:image>";
    case "file":
      return "<media:document>";
    case "audio":
      return "<media:audio>";
    case "video":
      return "<media:video>";
    case "sticker":
      return "<media:sticker>";
    default:
      return "<media:document>";
  }
}

/**
 * Resolve media from a Feishu message, downloading and saving to disk.
 * Similar to Discord's resolveMediaList().
 */
async function resolveFeishuMediaList(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  messageType: string;
  content: string;
  maxBytes: number;
  log?: (msg: string) => void;
}): Promise<FeishuMediaInfo[]> {
  const { cfg, messageId, messageType, content, maxBytes, log } = params;

  // Only process media message types (including post for embedded images)
  const mediaTypes = ["image", "file", "audio", "video", "sticker", "post"];
  if (!mediaTypes.includes(messageType)) {
    return [];
  }

  const out: FeishuMediaInfo[] = [];
  const core = getFeishuRuntime();

  // Handle post (rich text) messages with embedded images
  if (messageType === "post") {
    const { imageKeys } = parsePostContent(content);
    if (imageKeys.length === 0) {
      return [];
    }

    log?.(`feishu: post message contains ${imageKeys.length} embedded image(s)`);

    for (const imageKey of imageKeys) {
      try {
        // Embedded images in post use messageResource API with image_key as file_key
        const result = await downloadMessageResourceFeishu({
          cfg,
          messageId,
          fileKey: imageKey,
          type: "image",
        });

        let contentType = result.contentType;
        if (!contentType) {
          contentType = await core.media.detectMime({ buffer: result.buffer });
        }

        const saved = await core.channel.media.saveMediaBuffer(
          result.buffer,
          contentType,
          "inbound",
          maxBytes,
        );

        out.push({
          path: saved.path,
          contentType: saved.contentType,
          placeholder: "<media:image>",
        });

        log?.(`feishu: downloaded embedded image ${imageKey}, saved to ${saved.path}`);
      } catch (err) {
        log?.(`feishu: failed to download embedded image ${imageKey}: ${String(err)}`);
      }
    }

    return out;
  }

  // Handle other media types
  const mediaKeys = parseMediaKeys(content, messageType);
  if (!mediaKeys.imageKey && !mediaKeys.fileKey) {
    return [];
  }

  try {
    let buffer: Buffer;
    let contentType: string | undefined;
    let fileName: string | undefined;

    // For message media, always use messageResource API
    // The image.get API is only for images uploaded via im/v1/images, not for message attachments
    const fileKey = mediaKeys.imageKey || mediaKeys.fileKey;
    if (!fileKey) {
      return [];
    }

    const resourceType = messageType === "image" ? "image" : "file";
    const result = await downloadMessageResourceFeishu({
      cfg,
      messageId,
      fileKey,
      type: resourceType,
    });
    buffer = result.buffer;
    contentType = result.contentType;
    fileName = result.fileName || mediaKeys.fileName;

    // Detect mime type if not provided
    if (!contentType) {
      contentType = await core.media.detectMime({ buffer });
    }

    // Save to disk using core's saveMediaBuffer
    const saved = await core.channel.media.saveMediaBuffer(
      buffer,
      contentType,
      "inbound",
      maxBytes,
      fileName,
    );

    out.push({
      path: saved.path,
      contentType: saved.contentType,
      placeholder: inferPlaceholder(messageType),
    });

    log?.(`feishu: downloaded ${messageType} media, saved to ${saved.path}`);
  } catch (err) {
    log?.(`feishu: failed to download ${messageType} media: ${String(err)}`);
  }

  return out;
}

/**
 * Build media payload for inbound context.
 * Similar to Discord's buildDiscordMediaPayload().
 */
function buildFeishuMediaPayload(
  mediaList: FeishuMediaInfo[],
): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
} {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const mediaTypes = mediaList.map((media) => media.contentType).filter(Boolean) as string[];
  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}

export function parseFeishuMessageEvent(
  event: FeishuMessageEvent,
  botOpenId?: string,
): FeishuMessageContext {
  const rawContent = parseMessageContent(event.message.content, event.message.message_type);
  const mentionedBot = checkBotMentioned(event, botOpenId);
  const content = stripBotMention(rawContent, event.message.mentions);

  return {
    chatId: event.message.chat_id,
    messageId: event.message.message_id,
    senderId: event.sender.sender_id.user_id || event.sender.sender_id.open_id || "",
    senderOpenId: event.sender.sender_id.open_id || "",
    chatType: event.message.chat_type,
    mentionedBot,
    rootId: event.message.root_id || undefined,
    parentId: event.message.parent_id || undefined,
    content,
    contentType: event.message.message_type,
  };
}

export async function handleFeishuMessage(params: {
  cfg: ClawdbotConfig;
  event: FeishuMessageEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  chatHistories?: Map<string, HistoryEntry[]>;
}): Promise<void> {
  const { cfg, event, botOpenId, runtime, chatHistories } = params;
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  let ctx = parseFeishuMessageEvent(event, botOpenId);
  const isGroup = ctx.chatType === "group";

  // Resolve sender display name (best-effort) so the agent can attribute messages correctly.
  const senderName = await resolveFeishuSenderName({
    feishuCfg,
    senderOpenId: ctx.senderOpenId,
    log,
  });
  if (senderName) ctx = { ...ctx, senderName };

  // Resolve merge_forward sub-messages before policy checks
  if (event.message.message_type === "merge_forward") {
    const mergeContent = await resolveMergeForwardContent({
      cfg,
      messageId: ctx.messageId,
      chatId: ctx.chatId,
      rawContent: event.message.content,
      log,
    });
    ctx = { ...ctx, content: mergeContent };
  }

  log(`feishu: received message from ${ctx.senderOpenId} in ${ctx.chatId} (${ctx.chatType})`);

  const historyLimit = Math.max(
    0,
    feishuCfg?.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );

  if (isGroup) {
    const groupPolicy = feishuCfg?.groupPolicy ?? "open";
    const groupAllowFrom = feishuCfg?.groupAllowFrom ?? [];
    const groupConfig = resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: ctx.chatId });

    const senderAllowFrom = groupConfig?.allowFrom ?? groupAllowFrom;
    const allowed = isFeishuGroupAllowed({
      groupPolicy,
      allowFrom: senderAllowFrom,
      senderId: ctx.senderOpenId,
      senderName: ctx.senderName,
    });

    if (!allowed) {
      log(`feishu: sender ${ctx.senderOpenId} not in group allowlist`);
      return;
    }

    const { requireMention } = resolveFeishuReplyPolicy({
      isDirectMessage: false,
      globalConfig: feishuCfg,
      groupConfig,
    });

    if (requireMention && !ctx.mentionedBot) {
      log(`feishu: message in group ${ctx.chatId} did not mention bot, recording to history`);
      if (chatHistories) {
        recordPendingHistoryEntryIfEnabled({
          historyMap: chatHistories,
          historyKey: ctx.chatId,
          limit: historyLimit,
          entry: {
            sender: ctx.senderOpenId,
            body: `${ctx.senderName ?? ctx.senderOpenId}: ${ctx.content}`,
            timestamp: Date.now(),
            messageId: ctx.messageId,
          },
        });
      }
      return;
    }
  } else {
    const dmPolicy = feishuCfg?.dmPolicy ?? "pairing";
    const allowFrom = feishuCfg?.allowFrom ?? [];

    if (dmPolicy === "allowlist") {
      const match = resolveFeishuAllowlistMatch({
        allowFrom,
        senderId: ctx.senderOpenId,
      });
      if (!match.allowed) {
        log(`feishu: sender ${ctx.senderOpenId} not in DM allowlist`);
        return;
      }
    }
  }

  try {
    const core = getFeishuRuntime();

    // In group chats, the session is scoped to the group, but the *speaker* is the sender.
    // Using a group-scoped From causes the agent to treat different users as the same person.
    const feishuFrom = `feishu:${ctx.senderOpenId}`;
    const feishuTo = isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "feishu",
      peer: {
        kind: isGroup ? "group" : "dm",
        id: isGroup ? ctx.chatId : ctx.senderOpenId,
      },
    });

    const preview = ctx.content.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isGroup
      ? `Feishu message in group ${ctx.chatId}`
      : `Feishu DM from ${ctx.senderOpenId}`;

    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey: route.sessionKey,
      contextKey: `feishu:message:${ctx.chatId}:${ctx.messageId}`,
    });

    // Resolve media from message
    const mediaMaxBytes = (feishuCfg?.mediaMaxMb ?? 30) * 1024 * 1024; // 30MB default
    const mediaList = await resolveFeishuMediaList({
      cfg,
      messageId: ctx.messageId,
      messageType: event.message.message_type,
      content: event.message.content,
      maxBytes: mediaMaxBytes,
      log,
    });
    const mediaPayload = buildFeishuMediaPayload(mediaList);

    // Fetch quoted/replied message content if parentId exists
    let quotedContent: string | undefined;
    if (ctx.parentId) {
      try {
        const quotedMsg = await getMessageFeishu({ cfg, messageId: ctx.parentId });
        if (quotedMsg) {
          quotedContent = quotedMsg.content;
          log(`feishu: fetched quoted message: ${quotedContent?.slice(0, 100)}`);
        }
      } catch (err) {
        log(`feishu: failed to fetch quoted message: ${String(err)}`);
      }
    }

    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);

    // Build message body with quoted content if available
    let messageBody = ctx.content;
    if (quotedContent) {
      messageBody = `[Replying to: "${quotedContent}"]\n\n${ctx.content}`;
    }

    // Include a readable speaker label so the model can attribute instructions.
    // (DMs already have per-sender sessions, but the prefix is still useful for clarity.)
    const speaker = ctx.senderName ?? ctx.senderOpenId;
    messageBody = `${speaker}: ${messageBody}`;

    const envelopeFrom = isGroup ? `${ctx.chatId}:${ctx.senderOpenId}` : ctx.senderOpenId;

    const body = core.channel.reply.formatAgentEnvelope({
      channel: "Feishu",
      from: envelopeFrom,
      timestamp: new Date(),
      envelope: envelopeOptions,
      body: messageBody,
    });

    let combinedBody = body;
    const historyKey = isGroup ? ctx.chatId : undefined;

    if (isGroup && historyKey && chatHistories) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: chatHistories,
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          core.channel.reply.formatAgentEnvelope({
            channel: "Feishu",
            // Preserve speaker identity in group history as well.
            from: `${ctx.chatId}:${entry.sender}`,
            timestamp: entry.timestamp,
            body: entry.body,
            envelope: envelopeOptions,
          }),
      });
    }

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: combinedBody,
      RawBody: ctx.content,
      CommandBody: ctx.content,
      From: feishuFrom,
      To: feishuTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      GroupSubject: isGroup ? ctx.chatId : undefined,
      SenderName: ctx.senderName ?? ctx.senderOpenId,
      SenderId: ctx.senderOpenId,
      Provider: "feishu" as const,
      Surface: "feishu" as const,
      MessageSid: ctx.messageId,
      Timestamp: Date.now(),
      WasMentioned: ctx.mentionedBot,
      CommandAuthorized: true,
      OriginatingChannel: "feishu" as const,
      OriginatingTo: feishuTo,
      ...mediaPayload,
    });

    const { dispatcherOptions, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
      cfg,
      agentId: route.agentId,
      runtime: runtime as RuntimeEnv,
      chatId: ctx.chatId,
      replyToMessageId: ctx.messageId,
    });

    log(`feishu: dispatching to agent (session=${route.sessionKey})`);

    const { queuedFinal } = await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions,
      replyOptions,
    });

    markDispatchIdle();

    if (isGroup && historyKey && chatHistories) {
      clearHistoryEntriesIfEnabled({
        historyMap: chatHistories,
        historyKey,
        limit: historyLimit,
      });
    }

    log(`feishu: dispatch complete (queuedFinal=${queuedFinal})`);
  } catch (err) {
    error(`feishu: failed to dispatch message: ${String(err)}`);
  }
}
