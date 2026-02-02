import * as Lark from "@larksuiteoapi/node-sdk";
import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "openclaw/plugin-sdk";
import type { FeishuConfig } from "./types.js";
import { createFeishuWSClient, createEventDispatcher } from "./client.js";
import { resolveFeishuCredentials } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent, type FeishuBotAddedEvent } from "./bot.js";
import { probeFeishu } from "./probe.js";

export type MonitorFeishuOpts = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
};

let currentWsClient: Lark.WSClient | null = null;
let botOpenId: string | undefined;

// Module-level dedup state: survives WSClient reconnections and monitor restarts
const DEDUP_TTL_MS = 60 * 60 * 1000; // 60 minutes
const processedMessages = new Map<string, number>();
let activeSessionId = 0;

function pruneProcessedMessages(now: number): void {
  for (const [id, ts] of processedMessages) {
    if (now - ts > DEDUP_TTL_MS) processedMessages.delete(id);
  }
}

/**
 * Force-kill a WSClient by clearing its internal timers and terminating the
 * underlying WebSocket.  The SDK exposes no public stop() method, so we reach
 * into private fields.  Wrapped in try/catch so a SDK update won't break us.
 */
function forceStopWSClient(client: Lark.WSClient, log: (...args: any[]) => void): void {
  try {
    const c = client as any;
    if (c.pingInterval) { clearTimeout(c.pingInterval); c.pingInterval = undefined; }
    if (c.reconnectInterval) { clearTimeout(c.reconnectInterval); c.reconnectInterval = undefined; }
    // Disable auto-reconnect BEFORE terminating, otherwise the SDK's
    // on('close') handler calls reConnect() immediately.
    if (c.wsConfig) {
      try { c.wsConfig.updateWs({ autoReconnect: false }); } catch {}
    }
    // terminate underlying WebSocket
    const ws = c.wsConfig?.getWSInstance?.();
    if (ws && typeof ws.terminate === "function") ws.terminate();
    else if (ws && typeof ws.close === "function") ws.close();
    log("feishu: previous WSClient force-stopped");
  } catch (err) {
    log(`feishu: best-effort WSClient cleanup failed: ${String(err)}`);
  }
}

async function fetchBotOpenId(cfg: FeishuConfig): Promise<string | undefined> {
  try {
    const result = await probeFeishu(cfg);
    return result.ok ? result.botOpenId : undefined;
  } catch {
    return undefined;
  }
}

export async function monitorFeishuProvider(opts: MonitorFeishuOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for Feishu monitor");
  }

  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  const creds = resolveFeishuCredentials(feishuCfg);
  if (!creds) {
    throw new Error("Feishu credentials not configured (appId, appSecret required)");
  }

  const log = opts.runtime?.log ?? console.log;
  const error = opts.runtime?.error ?? console.error;

  if (feishuCfg) {
    botOpenId = await fetchBotOpenId(feishuCfg);
    log(`feishu: bot open_id resolved: ${botOpenId ?? "unknown"}`);
  }

  const connectionMode = feishuCfg?.connectionMode ?? "websocket";

  if (connectionMode === "websocket") {
    return monitorWebSocket({ cfg, feishuCfg: feishuCfg!, runtime: opts.runtime, abortSignal: opts.abortSignal });
  }

  log("feishu: webhook mode not implemented in monitor, use HTTP server directly");
}

async function monitorWebSocket(params: {
  cfg: ClawdbotConfig;
  feishuCfg: FeishuConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { cfg, feishuCfg, runtime, abortSignal } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // Invalidate any previous WSClient session so its handlers become no-ops
  activeSessionId++;
  const mySessionId = activeSessionId;

  if (currentWsClient) {
    log("feishu: stopping previous WebSocket client before starting new one");
    forceStopWSClient(currentWsClient, log);
    currentWsClient = null;
  }

  log("feishu: starting WebSocket connection...");

  const wsClient = createFeishuWSClient(feishuCfg);
  currentWsClient = wsClient;

  const chatHistories = new Map<string, HistoryEntry[]>();

  const eventDispatcher = createEventDispatcher(feishuCfg);

  eventDispatcher.register({
    "im.message.receive_v1": async (data) => {
      try {
        // Stale session guard: skip if a newer monitor has started
        if (mySessionId !== activeSessionId) return;

        const event = data as unknown as FeishuMessageEvent;
        const msgId = event.message?.message_id;
        if (msgId) {
          const now = Date.now();
          if (processedMessages.has(msgId)) {
            log(`feishu: ignoring duplicate message ${msgId}`);
            return;
          }
          processedMessages.set(msgId, now);
          if (processedMessages.size > 200) pruneProcessedMessages(now);
        }
        await handleFeishuMessage({
          cfg,
          event,
          botOpenId,
          runtime,
          chatHistories,
        });
      } catch (err) {
        error(`feishu: error handling message event: ${String(err)}`);
      }
    },
    "im.message.message_read_v1": async () => {
      // Ignore read receipts
    },
    "im.chat.member.bot.added_v1": async (data) => {
      try {
        const event = data as unknown as FeishuBotAddedEvent;
        log(`feishu: bot added to chat ${event.chat_id}`);
      } catch (err) {
        error(`feishu: error handling bot added event: ${String(err)}`);
      }
    },
    "im.chat.member.bot.deleted_v1": async (data) => {
      try {
        const event = data as unknown as { chat_id: string };
        log(`feishu: bot removed from chat ${event.chat_id}`);
      } catch (err) {
        error(`feishu: error handling bot removed event: ${String(err)}`);
      }
    },
  });

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (currentWsClient === wsClient) {
        forceStopWSClient(wsClient, log);
        currentWsClient = null;
      }
    };

    const handleAbort = () => {
      log("feishu: abort signal received, stopping WebSocket client");
      cleanup();
      resolve();
    };

    if (abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    try {
      wsClient.start({
        eventDispatcher,
      });

      log("feishu: WebSocket client started");
    } catch (err) {
      cleanup();
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    }
  });
}

export function stopFeishuMonitor(log?: (...args: any[]) => void): void {
  activeSessionId++; // invalidate all running handlers
  if (currentWsClient) {
    forceStopWSClient(currentWsClient, log ?? console.log);
    currentWsClient = null;
  }
}
