import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import type { FeishuConfig } from "./types.js";
import { createFeishuClient } from "./client.js";

// Feishu emoji types for typing indicator
// See: https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
// Full list: https://github.com/go-lark/lark/blob/main/emoji.go
const TYPING_EMOJI = "THUMBSUP"; // Typing indicator emoji
const DONE_EMOJI = "DONE"; // Completion indicator emoji

export type TypingIndicatorState = {
  messageId: string;
  reactionId: string | null;
};

/**
 * Add a typing indicator (reaction) to a message
 */
export async function addTypingIndicator(params: {
  cfg: ClawdbotConfig;
  messageId: string;
}): Promise<TypingIndicatorState> {
  const { cfg, messageId } = params;
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  if (!feishuCfg) {
    return { messageId, reactionId: null };
  }

  const client = createFeishuClient(feishuCfg);

  try {
    const response = await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: {
        reaction_type: { emoji_type: TYPING_EMOJI },
      },
    });

    const reactionId = (response as any)?.data?.reaction_id ?? null;
    return { messageId, reactionId };
  } catch (err: any) {
    const detail = err?.response?.data ? JSON.stringify(err.response.data) : String(err);
    console.log(`[feishu] failed to add typing indicator: ${detail}`);
    return { messageId, reactionId: null };
  }
}

/**
 * Remove a typing indicator (reaction) from a message
 */
export async function removeTypingIndicator(params: {
  cfg: ClawdbotConfig;
  state: TypingIndicatorState;
}): Promise<void> {
  const { cfg, state } = params;
  if (!state.reactionId) return;

  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  if (!feishuCfg) return;

  const client = createFeishuClient(feishuCfg);

  try {
    await client.im.messageReaction.delete({
      path: {
        message_id: state.messageId,
        reaction_id: state.reactionId,
      },
    });
  } catch (err) {
    // Silently fail - cleanup is not critical
    console.log(`[feishu] failed to remove typing indicator: ${err}`);
  }
}

/**
 * Add a DONE reaction to the original message after reply completes.
 */
export async function addDoneReaction(params: {
  cfg: ClawdbotConfig;
  messageId: string;
}): Promise<void> {
  const { cfg, messageId } = params;
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  if (!feishuCfg) return;

  const client = createFeishuClient(feishuCfg);
  try {
    await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: DONE_EMOJI } },
    });
  } catch {
    // Not critical
  }
}
