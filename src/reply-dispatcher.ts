import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type ClawdbotConfig,
  type RuntimeEnv,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import { appendFileSync } from "node:fs";
function _dbg(msg: string) {
  try { appendFileSync("/tmp/feishu-stream-debug.log", `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}
import { getFeishuRuntime } from "./runtime.js";
import {
  sendMessageFeishu,
  sendCardFeishu,
  updateCardFeishu,
} from "./send.js";
import type { FeishuConfig } from "./types.js";
import {
  addTypingIndicator,
  removeTypingIndicator,
  type TypingIndicatorState,
} from "./typing.js";

/**
 * Detect if text contains markdown elements that benefit from card rendering.
 */
function shouldUseCard(text: string): boolean {
  if (/```[\s\S]*?```/.test(text)) return true;
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

/**
 * Detect if text contains a markdown table (header + separator row).
 */
function hasMarkdownTable(text: string): boolean {
  return /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

/**
 * Collapse \n\n between markdown table rows back to \n.
 * The SDK block coalescer inserts \n\n as joiner, which breaks tables.
 */
function repairMarkdownTables(text: string): string {
  // Between two table rows (lines starting/ending with |), collapse \n\n to \n
  return text.replace(/(\|[^\n]*\|)\n\n(?=\|)/g, "$1\n");
}

const STREAMING_CURSOR = " ▍";
const DEFAULT_PATCH_INTERVAL_MS = 500;
const DEFAULT_THINKING_UPDATE_INTERVAL_MS = 800;

// --- Tool arg extractors (same as Telegram) ---

const TOOL_ARG_EXTRACTORS: Record<string, string[]> = {
  read: ["path"],
  write: ["path"],
  edit: ["file_path"],
  exec: ["command"],
  bash: ["command"],
  search: ["pattern", "query"],
  grep: ["pattern"],
  glob: ["pattern"],
  web_search: ["query"],
  web_fetch: ["url"],
  list_directory: ["path"],
};

function extractToolArgs(
  name: string,
  args: Record<string, unknown> | undefined,
  maxLen: number,
): string {
  if (!args) return "";
  const keys = TOOL_ARG_EXTRACTORS[name.toLowerCase()];
  if (keys) {
    for (const key of keys) {
      const val = args[key];
      if (typeof val === "string" && val.trim()) {
        const trimmed = val.trim();
        return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + "…" : trimmed;
      }
    }
  }
  for (const val of Object.values(args)) {
    if (typeof val === "string" && val.trim()) {
      const trimmed = val.trim();
      return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + "…" : trimmed;
    }
  }
  return "";
}

// --- Thinking/Tool state for streaming card ---

type ToolEntry = { name: string; args?: Record<string, unknown>; startedAt: number };
type CompletedToolEntry = ToolEntry & { failed: boolean };

function buildThinkingSection(
  thinkingText: string | undefined,
  activeTools: Map<string, ToolEntry>,
  completedTools: CompletedToolEntry[],
  maxLen: number,
): string {
  const parts: string[] = [];

  if (thinkingText) {
    const trimmed =
      thinkingText.length > maxLen ? "…" + thinkingText.slice(-maxLen) : thinkingText;
    parts.push("🧠 **Thinking**");
    parts.push(`> ${trimmed.replace(/\n/g, "\n> ")}`);
  }

  if (completedTools.length > 0 || activeTools.size > 0) {
    if (parts.length > 0) parts.push("");
    for (const t of completedTools.slice(-10)) {
      const icon = t.failed ? "❌" : "✅";
      const argStr = extractToolArgs(t.name, t.args, 150);
      parts.push(argStr ? `${icon} \`${t.name}\` ${argStr}` : `${icon} \`${t.name}\``);
    }
    for (const [, t] of activeTools) {
      const argStr = extractToolArgs(t.name, t.args, 150);
      parts.push(argStr ? `⏳ \`${t.name}\` ${argStr}` : `⏳ \`${t.name}\``);
    }
  }

  return parts.join("\n");
}

function buildThinkingCollapseSummary(completedTools: CompletedToolEntry[], startedAt?: number): string {
  const n = completedTools.length;
  const failed = completedTools.filter((t) => t.failed).length;
  const ok = n - failed;
  const parts: string[] = [`🧠 Thinking complete`];
  if (startedAt) {
    const sec = ((Date.now() - startedAt) / 1000).toFixed(1);
    parts.push(`${sec}s`);
  }
  if (n > 0) {
    const toolStr = failed > 0 ? `${ok}✅ ${failed}❌` : `${n} tool${n !== 1 ? "s" : ""}`;
    parts.push(toolStr);
  }
  return parts.join(" · ");
}

/**
 * Build a unified card with optional collapsible thinking panel + reply markdown.
 */
function buildUnifiedCard(opts: {
  thinkingMarkdown?: string;
  thinkingExpanded: boolean;
  thinkingTitle: string;
  replyMarkdown?: string;
}): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  if (opts.thinkingMarkdown) {
    elements.push({
      tag: "collapsible_panel",
      expanded: opts.thinkingExpanded,
      header: {
        title: {
          tag: "plain_text",
          content: opts.thinkingTitle,
        },
      },
      elements: [
        {
          tag: "markdown",
          content: opts.thinkingMarkdown,
        },
      ],
    });
  }

  if (opts.replyMarkdown) {
    elements.push({
      tag: "markdown",
      content: opts.replyMarkdown,
    });
  }

  // Card JSON v2 structure required for collapsible_panel
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

// --- Main exports ---

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const { cfg, agentId, chatId, replyToMessageId } = params;

  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  let typingState: TypingIndicatorState | null = null;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      _dbg(`typing start: replyToMessageId=${replyToMessageId}`);
      if (!replyToMessageId) return;
      typingState = await addTypingIndicator({ cfg, messageId: replyToMessageId });
      _dbg(`typing started: reactionId=${typingState.reactionId}`);
    },
    stop: async () => {
      if (!typingState) return;
      await removeTypingIndicator({ cfg, state: typingState });
      typingState = null;
    },
    onStartError: (err) => {
      logTypingFailure({ log: (m) => params.runtime.log?.(m), channel: "feishu", action: "start", error: err });
    },
    onStopError: (err) => {
      logTypingFailure({ log: (m) => params.runtime.log?.(m), channel: "feishu", action: "stop", error: err });
    },
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit({ cfg, channel: "feishu", defaultLimit: 4000 });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: "feishu" });

  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  const streamingEnabled = feishuCfg?.streaming?.enabled !== false;
  const patchIntervalMs = feishuCfg?.streaming?.patchIntervalMs ?? DEFAULT_PATCH_INTERVAL_MS;
  const showCursor = feishuCfg?.streaming?.cursor !== false;
  const renderMode = feishuCfg?.renderMode ?? "auto";

  // --- Unified card state ---
  let cardMessageId: string | null = null;
  let accumulatedText = "";
  let lastPatchTime = 0;
  let pendingPatchTimer: ReturnType<typeof setTimeout> | null = null;
  let streamingFailed = false;
  let cardCreationPromise: Promise<void> | null = null;

  // --- Thinking/tool state ---
  let thinkingText: string | undefined;
  const activeTools = new Map<string, ToolEntry>();
  const completedTools: CompletedToolEntry[] = [];
  let thinkingStopped = false;
  let hasThinkingContent = false;
  let thinkingStartedAt: number | undefined;

  // --- Unified card helpers ---

  function buildCurrentCard(isFinal: boolean): Record<string, unknown> {
    const cursor = isFinal || !showCursor ? "" : STREAMING_CURSOR;
    const replyMd = accumulatedText ? repairMarkdownTables(accumulatedText) + cursor : undefined;

    const thinkingMd = buildThinkingSection(thinkingText, activeTools, completedTools, 3000);
    const hasThinking = hasThinkingContent || !!thinkingMd;

    const collapseSummary = buildThinkingCollapseSummary(completedTools, thinkingStartedAt);

    return buildUnifiedCard({
      thinkingMarkdown: hasThinking ? (thinkingMd || "🧠 Thinking…") : undefined,
      thinkingExpanded: !thinkingStopped,
      thinkingTitle: thinkingStopped ? collapseSummary : "🧠 Thinking…",
      replyMarkdown: replyMd || (!hasThinking ? "🧠 **Thinking…**" : undefined),
    });
  }

  async function patchCard(isFinal: boolean) {
    if (streamingFailed) return;
    // If reply text contains a table, skip intermediate patches to avoid broken rendering
    if (!isFinal && accumulatedText && hasMarkdownTable(accumulatedText)) {
      _dbg(`patchCard: skipping intermediate patch (table detected)`);
      return;
    }
    // Wait for any in-flight card creation to finish first
    if (cardCreationPromise) {
      _dbg(`patchCard(final=${isFinal}): waiting for in-flight creation`);
      await cardCreationPromise;
    }
    const card = buildCurrentCard(isFinal);
    try {
      if (!cardMessageId) {
        _dbg(`patchCard(final=${isFinal}): CREATING new card`);
        const p = sendCardFeishu({ cfg, to: chatId, card, replyToMessageId }).then((result) => {
          cardMessageId = result.messageId;
          lastPatchTime = Date.now();
          cardCreationPromise = null;
          _dbg(`patchCard: card created id=${result.messageId}`);
        });
        cardCreationPromise = p;
        await p;
      } else {
        _dbg(`patchCard(final=${isFinal}): UPDATING existing card=${cardMessageId}`);
        await updateCardFeishu({ cfg, messageId: cardMessageId, card });
        lastPatchTime = Date.now();
      }
    } catch (err) {
      _dbg(`patchCard: FAILED ${String(err)}`);
      params.runtime.log?.(`feishu: card patch failed: ${String(err)}`);
      cardCreationPromise = null;
      // Only mark failed if card creation itself failed (not a transient patch 400)
      if (!cardMessageId) streamingFailed = true;
    }
  }

  function schedulePatch() {
    if (pendingPatchTimer) return;
    const delay = Math.max(0, patchIntervalMs - (Date.now() - lastPatchTime));
    pendingPatchTimer = setTimeout(async () => {
      pendingPatchTimer = null;
      if (!streamingFailed) {
        await patchCard(false);
      }
    }, delay);
  }

  function clearPendingPatch() {
    if (pendingPatchTimer) { clearTimeout(pendingPatchTimer); pendingPatchTimer = null; }
  }

  function triggerThinkingUpdate() {
    if (thinkingStopped) return;
    hasThinkingContent = true;
    if (!thinkingStartedAt) thinkingStartedAt = Date.now();
    _dbg(`triggerThinkingUpdate: cardId=${cardMessageId} creationPending=${!!cardCreationPromise} tools=${activeTools.size}/${completedTools.length}`);
    if (Date.now() - lastPatchTime >= DEFAULT_THINKING_UPDATE_INTERVAL_MS) {
      void patchCard(false);
    } else {
      schedulePatch();
    }
  }

  async function collapseThinking() {
    _dbg(`collapseThinking: cardId=${cardMessageId} hasThinking=${hasThinkingContent}`);
    thinkingStopped = true;
    clearPendingPatch();
    if (!cardMessageId || !hasThinkingContent) return;
    await patchCard(false);
  }

  // --- Non-streaming fallback ---

  async function deliverStandalone(text: string) {
    // Always use card v2 for consistent markdown rendering
    const card = buildUnifiedCard({
      thinkingMarkdown: undefined,
      thinkingExpanded: false,
      thinkingTitle: "",
      replyMarkdown: text,
    });
    try {
      const result = await sendCardFeishu({ cfg, to: chatId, card, replyToMessageId });
      _dbg(`deliverStandalone: sent card v2 id=${result.messageId}`);
    } catch (err) {
      _dbg(`deliverStandalone: card v2 failed, fallback text: ${String(err)}`);
      // Last resort: plain text
      const converted = core.channel.text.convertMarkdownTables(text, tableMode);
      const chunks = core.channel.text.chunkTextWithMode(converted, textChunkLimit, chunkMode);
      for (const chunk of chunks) {
        await sendMessageFeishu({ cfg, to: chatId, text: chunk, replyToMessageId });
      }
    }
  }

  /**
   * Deliver the final accumulated reply: patch the existing thinking card
   * (adding reply below collapsed thinking), or send a new card if none exists.
   */
  let standaloneDelivered = false;

  /** Deliver all accumulated reply text — patches card with full text (idempotent). */
  async function doDeliverFinalReply() {
    const fullText = accumulatedText;
    if (!fullText.trim()) return;

    _dbg(`doDeliverFinalReply: len=${fullText.length} cardId=${cardMessageId}`);

    if (cardMessageId) {
      thinkingStopped = true;
      const card = buildUnifiedCard({
        thinkingMarkdown: hasThinkingContent
          ? (buildThinkingSection(thinkingText, activeTools, completedTools, 3000) || "🧠 Thinking…")
          : undefined,
        thinkingExpanded: false,
        thinkingTitle: buildThinkingCollapseSummary(completedTools, thinkingStartedAt),
        replyMarkdown: fullText,
      });
      try {
        await updateCardFeishu({ cfg, messageId: cardMessageId, card });
        _dbg(`doDeliverFinalReply: patch success`);
      } catch (err) {
        _dbg(`doDeliverFinalReply: patch failed, fallback standalone: ${String(err)}`);
        if (!standaloneDelivered) {
          standaloneDelivered = true;
          await deliverStandalone(fullText);
        }
      }
    } else if (!standaloneDelivered) {
      standaloneDelivered = true;
      await deliverStandalone(fullText);
    }
  }

  // --- Build dispatcher options (for dispatchReplyWithBufferedBlockDispatcher) ---

  const dispatcherOptions = {
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    deliver: async (payload: ReplyPayload, info: { kind: string }) => {
      const kind = info.kind ?? "final";
      _dbg(`deliver kind=${kind} cardId=${cardMessageId} text=${(payload.text ?? "").slice(0, 80)}`);
      const text = payload.text ?? "";
      if (!text.trim()) return;

      // Collapse thinking on first reply content
      if (!thinkingStopped) {
        thinkingStopped = true;
        clearPendingPatch();
      }

      // Accumulate all blocks — don't deliver yet
      // Blocks may lack trailing newlines; ensure separation
      if (accumulatedText && !accumulatedText.endsWith("\n") && !text.startsWith("\n")) {
        accumulatedText += "\n";
      }
      accumulatedText += text;
      _dbg(`deliver: accumulated len=${accumulatedText.length}`);

      // Every deliver with kind=final triggers a card patch (idempotent full replace)
      if (kind === "final") {
        await doDeliverFinalReply();
      }
    },
    onSkip: (_payload: ReplyPayload, info: { reason?: string }) => {
      params.runtime.log?.(`feishu: skipped reply (reason=${info.reason})`);
    },
    onError: (err: unknown, info: { kind: string }) => {
      params.runtime.error?.(`feishu ${info.kind} reply failed: ${String(err)}`);
      clearPendingPatch();
      typingCallbacks.onIdle?.();
    },
    onReplyStart: typingCallbacks.onReplyStart,
    onIdle: () => {
      _dbg(`onIdle: accumulated=${accumulatedText.length}`);
      clearPendingPatch();
      thinkingStopped = true;
      // Fallback: deliver any remaining accumulated text
      if (accumulatedText.trim()) {
        doDeliverFinalReply().catch((err) => {
          params.runtime.log?.(`feishu: idle deliver failed: ${String(err)}`);
        });
      }
      typingCallbacks.onIdle?.();
    },
  };

  // --- Build reply options (onReasoningStream, onAgentEvent, etc.) ---

  const replyOptions = {
    onModelSelected: prefixContext.onModelSelected,
    onReasoningStream: (payload: { text?: string }) => {
      if (payload.text) {
        thinkingText = payload.text;
        triggerThinkingUpdate();
      }
    },
    onAgentEvent: (evt: { stream?: string; data?: Record<string, unknown> }) => {
      if (evt.stream === "tool") {
        const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
        const toolCallId = typeof evt.data?.toolCallId === "string" ? evt.data.toolCallId : "";
        const name = typeof evt.data?.name === "string" ? evt.data.name : "";
        if (phase === "start" && toolCallId) {
          const args = evt.data?.args && typeof evt.data.args === "object"
            ? (evt.data.args as Record<string, unknown>)
            : undefined;
          activeTools.set(toolCallId, { name, args, startedAt: Date.now() });
          triggerThinkingUpdate();
        } else if (phase === "result" && toolCallId) {
          const entry = activeTools.get(toolCallId);
          if (entry) {
            activeTools.delete(toolCallId);
            completedTools.push({ ...entry, failed: Boolean(evt.data?.isError) });
          }
          triggerThinkingUpdate();
        }
      }
    },
  };

  return {
    dispatcherOptions,
    replyOptions,
    markDispatchIdle: () => {
      clearPendingPatch();
      if (!thinkingStopped) {
        thinkingStopped = true;
        if (cardMessageId && hasThinkingContent) {
          patchCard(false).catch(() => {});
        }
      }
      typingCallbacks.onIdle?.();
    },
  };
}
