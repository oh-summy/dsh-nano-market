// @oh-summy/connect-lark — Run protocol (ARCHITECTURE §10.2, §10.5).
//
// Each chat has one run slot. A run can be: idle, running, cancelling.
// When a message arrives:
//   - idle: start a new run
//   - running: queue the message (per-chat serialization — the SDK safety.chatQueue
//     already does this for message handlers; we track state for cancellation)
//
// The reply comes from event subscription, NOT from followup() return value.
// Events: agent/assistant-stream (incremental), session/event turn/start + turn/end,
//         agent/error, agent/inbox/claimed.

export type RunState = "idle" | "running" | "cancelling" | "finishing" | "done";

/** Bounded resource limits so a chat cannot exhaust memory or queue indefinitely. */
export const MAX_PENDING = 8;
/** Maximum chat slots retained before evicting the oldest idle/done ones. */
export const MAX_SLOTS = 100;
/** How long a done/idle slot stays before it is eligible for eviction. */
export const SLOT_TTL_MS = 10 * 60 * 1000;
/** How often to sweep for TTL-expired slots (independent of new messages). */
export const TTL_SWEEP_INTERVAL_MS = 60 * 1000;
export const MAX_TEXT_CHARS = 200_000;
export const MAX_THINKING_CHARS = 100_000;

function truncateTail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit) + "\n…(已截断)";
}

export interface RunSlot {
  chatId: string;
  agent: unknown;            // the Agent driving this run
  sessionId: string;         // session id for event filtering
  handle: { dispose: () => Promise<void> } | null;  // for owned-per-chat
  state: RunState;
  cancelController: AbortController | null;
  streamMessageId: string | null;
  accumulatedText: string;
  turnId: number | null;
  /** Queued messages waiting for the current run to finish. */
  pending: Array<{ content: unknown; source: { kind: string } }>;
  /** Whether the session has already been titled and attached for presentation. */
  titleSet?: boolean;
  /** Error that caused this run to fail (if any). */
  failedWith?: Error;
  /** Last time this slot was touched (for TTL eviction). */
  lastActiveAt: number;
  /** Reasoning deltas captured while the model is working. */
  thinkingText: string;
  /** Streaming card controller and completion handle, owned by apply(). */
  streamController?: { update: (next: object) => Promise<void> };
  streamDone?: () => void;
  streamPromise?: Promise<unknown>;
  streamFailed?: Error;
  streamReady?: Promise<void>;
  streamReadyResolve?: () => void;
}

export interface RunManagerOptions {
  /** Resolve or create an agent for a chat. Returns agent, sessionId, and optional handle. */
  resolveAgent: (chatId: string, title?: string) => Promise<{ agent: unknown; sessionId: string; handle: RunSlot["handle"] }>;
  /** Build a user message from content. */
  buildMessage: (content: unknown, source: { kind: string }) => unknown;
  /** Subscribe to agent events for incremental text. */
  subscribe: (agent: unknown, sessionId: string, onDelta: (delta: string, kind?: "text" | "reasoning") => void, onTurnEnd: () => void, onError: (e: Error) => void) => () => void;
  /** Start a streaming card for this run. */
  onStart?: (slot: RunSlot) => void | Promise<void>;
  /** Update the card with a normal text delta. */
  onDelta?: (slot: RunSlot, delta: string) => void;
  /** Update the card with a reasoning delta. */
  onThinking?: (slot: RunSlot, delta: string) => void;
  /** Start a turn (call agent.followup). */
  followup: (agent: unknown, message: unknown) => void;
  /** Called when a run completes (turn/end or error). */
  onComplete?: (slot: RunSlot) => void | Promise<void>;
  /** Forward cancellation to the DSH host. */
  onCancel?: (slot: RunSlot) => void | Promise<void>;
}

/**
 * Manages per-chat run slots with ordered execution and cancellation.
 */
export class RunManager {
  private slots = new Map<string, RunSlot>();
  private opts: RunManagerOptions;
  private unsubs = new Map<string, () => void>();
  private watchdogs = new Map<string, NodeJS.Timeout>();
  private starting = new Set<Promise<unknown>>();
  private ttlSweep: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(opts: RunManagerOptions) {
    this.opts = opts;
    this.ttlSweep = setInterval(() => { void this.evictOldest(false); }, TTL_SWEEP_INTERVAL_MS);
    this.ttlSweep.unref?.();
  }

  /** Get or create a run slot for a chat. */
  getOrCreate(chatId: string): RunSlot {
    if (!this.slots.has(chatId)) {
      // Always try to reclaim TTL-expired slots when a new chat arrives.
      void this.evictOldest(false, chatId);
      if (this.slots.size >= MAX_SLOTS) {
        const hasReclaimable = [...this.slots.values()].some((s) => s.state === "idle" || s.state === "done");
        if (!hasReclaimable) throw new Error("too many active chats; finish some before starting a new one");
        void this.evictOldest(true, chatId);
      }
    }
    let slot = this.slots.get(chatId);
    if (!slot) {
      slot = {
        chatId,
        agent: null,
        sessionId: "",
        handle: null,
        state: "idle",
        cancelController: null,
        streamMessageId: null,
        accumulatedText: "",
        thinkingText: "",
        turnId: null,
        pending: [],
        lastActiveAt: Date.now(),
      };
      this.slots.set(chatId, slot);
    }
    return slot;
  }

  /** Evict the oldest idle/done slot. When force is true (capacity reached)
   * the TTL is ignored so the cap is a hard bound. excludeChatId prevents
   * the just-completed slot from evicting itself. */
  private async evictOldest(force = false, excludeChatId?: string): Promise<void> {
    const now = Date.now();
    let oldest: RunSlot | undefined;
    for (const slot of this.slots.values()) {
      if (slot.state !== "idle" && slot.state !== "done") continue;
      if (excludeChatId && slot.chatId === excludeChatId) continue;
      if (!force && slot.lastActiveAt > now - SLOT_TTL_MS) continue;
      if (!oldest || slot.lastActiveAt < oldest.lastActiveAt) oldest = slot;
    }
    if (oldest) await this.disposeSlot(oldest.chatId);
  }

  /** Get a slot by chatId (for reuse/diagnostics). */
  getSlot(chatId: string): RunSlot | undefined {
    return this.slots.get(chatId);
  }

  /** Check if a chat has an active run. */
  isRunning(chatId: string): boolean {
    const slot = this.slots.get(chatId);
    return slot?.state === "running" || slot?.state === "cancelling" || slot?.state === "finishing";
  }

  /**
   * Start a run for a chat (or resume if one is already active).
   * Returns the slot; the actual work happens via subscribe + followup.
   */
  async start(chatId: string, content: unknown, source: { kind: string }, title?: string): Promise<RunSlot> {
    if (this.disposed) throw new Error("RunManager is disposed");
    const promise = this.startInternal(chatId, content, source, title);
    this.starting.add(promise);
    try {
      return await promise;
    } finally {
      this.starting.delete(promise);
    }
  }

  private async startInternal(chatId: string, content: unknown, source: { kind: string }, title?: string): Promise<RunSlot> {
    const slot = this.getOrCreate(chatId);

    // If running, queue the message (per-chat serialization).
    if (this.isRunning(chatId)) {
      if (slot.pending.length >= MAX_PENDING) {
        throw new Error("queue is full; drop oldest message or wait for the current run");
      }
      slot.pending.push({ content, source });
      return slot;
    }

    // Set running before awaiting the agent. Another message for this chat
    // must queue, not create a second writer for the same session.
    slot.lastActiveAt = Date.now();
    slot.state = "running";
    try {
      const { agent, sessionId, handle } = await this.opts.resolveAgent(chatId, title);
      if (this.disposed) {
        if (handle) await handle.dispose();
        throw new Error("RunManager is disposed");
      }
      const busy = [...this.slots.values()].some((other) =>
        other !== slot && other.sessionId === sessionId &&
        (other.state === "running" || other.state === "cancelling"));
      if (busy) {
        if (handle) await handle.dispose();
        throw new Error("Session is already running in another chat");
      }
      slot.agent = agent;
      slot.handle = handle;
      slot.sessionId = sessionId;
      slot.failedWith = undefined;
      slot.streamController = undefined;
      slot.streamDone = undefined;
      slot.streamPromise = undefined;
      slot.streamFailed = undefined;
      slot.streamReady = undefined;
      slot.streamReadyResolve = undefined;

      const unsub = this.opts.subscribe(
        agent,
        sessionId,
        (delta, kind) => {
          if (kind === "reasoning") {
            slot.thinkingText = truncateTail(slot.thinkingText + delta, MAX_THINKING_CHARS);
            this.opts.onThinking?.(slot, delta);
          } else {
            slot.accumulatedText = truncateTail(slot.accumulatedText + delta, MAX_TEXT_CHARS);
            this.opts.onDelta?.(slot, delta);
          }
        },
        () => { void this.complete(chatId); },
        (e) => { void this.fail(chatId, e); },
      );
      this.unsubs.set(chatId, unsub);

      slot.cancelController = new AbortController();
      slot.accumulatedText = "";
      slot.thinkingText = "";
      slot.turnId = (slot.turnId ?? 0) + 1;
      await this.opts.onStart?.(slot);
      if (this.disposed) { this.cleanup(chatId); throw new Error("RunManager is disposed"); }
      this.opts.followup(agent, this.opts.buildMessage(content, source));
      return slot;
    } catch (error) {
      this.cleanup(chatId);
      slot.state = "idle";
      slot.streamDone?.();
      throw error;
    }
  }

  /** Cancel the current run for a chat (does NOT dispose the agent).
   * Adds a watchdog: if turn/end doesn't arrive within 30s after abort,
   * force-transition to done so subsequent messages aren't stuck forever.
   */
  cancel(chatId: string): void {
    const slot = this.slots.get(chatId);
    if (!slot || slot.state !== "running") return;
    slot.state = "cancelling";
    slot.cancelController?.abort();
    try { void Promise.resolve(this.opts.onCancel?.(slot)).catch(() => {}); } catch { /* best effort */ }
    // Watchdog: force-complete if turn/end never arrives.
    const watchdog = setTimeout(() => {
      this.watchdogs.delete(chatId);
      const s = this.slots.get(chatId);
      if (s && s.state === "cancelling") void this.complete(chatId);
    }, 30_000);
    watchdog.unref?.();
    this.watchdogs.set(chatId, watchdog);
  }

  /** Mark a run as complete and process the next queued message. */
  private async complete(chatId: string): Promise<void> {
    const slot = this.slots.get(chatId);
    if (!slot || (slot.state !== "running" && slot.state !== "cancelling")) return;
    slot.state = "finishing";
    this.cleanup(chatId);
    try { await this.opts.onComplete?.(slot); } catch { /* reply fallback owns its errors */ }
    slot.state = "done";
    await this.evictOldest(false, chatId);
    slot.streamController = undefined;
    slot.streamPromise = undefined;
    slot.streamFailed = undefined;
    slot.streamReady = undefined;
    slot.streamReadyResolve = undefined;
    if (slot.pending.length > 0 && !this.disposed) {
      const next = slot.pending.shift()!;
      try { await this.start(chatId, next.content, next.source); }
      catch (error) { await this.fail(chatId, error as Error); }
    }
  }

  /** Mark a run as failed and reset state. */
  private async fail(chatId: string, error: Error): Promise<void> {
    const slot = this.slots.get(chatId);
    if (!slot || slot.state === "done" || slot.state === "finishing") return; // already completed
    slot.state = "finishing";
    slot.failedWith = error;
    this.cleanup(chatId);
    try { await this.opts.onComplete?.(slot); } catch { /* reply fallback owns its errors */ }
    slot.state = "done";
    await this.evictOldest(false, chatId);
    slot.streamController = undefined;
    slot.streamPromise = undefined;
    slot.streamFailed = undefined;
    slot.streamReady = undefined;
    slot.streamReadyResolve = undefined;
    if (slot.pending.length > 0 && !this.disposed) {
      const next = slot.pending.shift()!;
      try { await this.start(chatId, next.content, next.source); }
      catch (nextError) { await this.fail(chatId, nextError as Error); }
    }
  }

  /** Dispose a single slot: unsubscribe, dispose handle, drop it. */
  private async disposeSlot(chatId: string): Promise<void> {
    const slot = this.slots.get(chatId);
    if (!slot) return;
    this.cleanup(chatId);
    if (slot.handle) { await Promise.resolve(slot.handle.dispose()).catch(() => {}); }
    this.slots.delete(chatId);
  }

  /** Wait for in-flight runs to settle before teardown.
   * Used by config-save cleanup so a turn is not cancelled mid-reply.
   * Returns early if the deadline passes; callers then dispose what remains.
   */
  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ([...this.slots.values()].some((s) => s.state === "running" || s.state === "cancelling" || s.state === "finishing")) {
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Dispose all owned agents and clear all slots. */
  private cleanup(chatId: string): void {
    const unsub = this.unsubs.get(chatId);
    if (unsub) { try { unsub(); } catch { /* gone */ } }
    this.unsubs.delete(chatId);
    const watchdog = this.watchdogs.get(chatId);
    if (watchdog) clearTimeout(watchdog);
    this.watchdogs.delete(chatId);
  }

  async disposeAll(): Promise<void> {
    this.disposed = true;
    if (this.ttlSweep) { clearInterval(this.ttlSweep); this.ttlSweep = null; }
    const failures: Error[] = [];
    // Abandon in-flight starts at their next await boundary: start() checks
    // disposed after resolveAgent and after onStart, so no new followup fires.
    // We intentionally do not await them — a start may be blocked on resolveAgent
    // (e.g. the owner is typing the prompt) and must not deadlock disposeAll.
    for (const slot of this.slots.values()) {
      try { slot.streamReadyResolve?.(); } catch { /* already resolved */ }
    }
    // Abort all controllers before disposing.
    for (const slot of this.slots.values()) {
      try { slot.cancelController?.abort(); } catch { /* gone */ }
      try { slot.streamDone?.(); } catch { /* already finished */ }
      // Only abandon an owned run; idle/done slots and a shared attach-gui
      // session must not be cancelled by plugin teardown or config saves.
      if (slot.state === "running" || slot.state === "cancelling") {
        try { await this.opts.onCancel?.(slot); } catch { /* best effort */ }
      }
    }
    // Clean up subscriptions for all slots.
    for (const chatId of this.slots.keys()) this.cleanup(chatId);
    for (const slot of this.slots.values()) {
      try {
        if (slot.handle) await slot.handle.dispose();
      } catch (e) {
        failures.push(e as Error);
      }
      slot.state = "idle";
      slot.handle = null;
      slot.cancelController = null;
    }
    this.slots.clear();
    if (failures.length > 0) {
      throw new Error("RunManager disposal failed: " + failures.map((e) => e.message).join("; "));
    }
  }

  /** Get all active slots (for diagnostics/tests). */
  list(): RunSlot[] {
    return [...this.slots.values()];
  }
}
