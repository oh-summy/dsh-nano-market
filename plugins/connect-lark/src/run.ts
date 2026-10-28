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

export type RunState = "idle" | "running" | "cancelling" | "done";

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
  /** Error that caused this run to fail (if any). */
  failedWith?: Error;
}

export interface RunManagerOptions {
  /** Resolve or create an agent for a chat. Returns agent, sessionId, and optional handle. */
  resolveAgent: (chatId: string) => Promise<{ agent: unknown; sessionId: string; handle: RunSlot["handle"] }>;
  /** Build a user message from content. */
  buildMessage: (content: unknown, source: { kind: string }) => unknown;
  /** Subscribe to agent events for incremental text. */
  subscribe: (agent: unknown, sessionId: string, onDelta: (delta: string) => void, onTurnEnd: () => void, onError: (e: Error) => void) => () => void;
  /** Start a turn (call agent.followup). */
  followup: (agent: unknown, message: unknown) => void;
  /** Called when a run completes (turn/end or error). */
  onComplete?: (slot: RunSlot) => void;
}

/**
 * Manages per-chat run slots with ordered execution and cancellation.
 */
export class RunManager {
  private slots = new Map<string, RunSlot>();
  private opts: RunManagerOptions;
  private unsubs = new Map<string, () => void>();

  constructor(opts: RunManagerOptions) {
    this.opts = opts;
  }

  /** Get or create a run slot for a chat. */
  getOrCreate(chatId: string): RunSlot {
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
        turnId: null,
        pending: [],
      };
      this.slots.set(chatId, slot);
    }
    return slot;
  }

  /** Get a slot by chatId (for reuse/diagnostics). */
  getSlot(chatId: string): RunSlot | undefined {
    return this.slots.get(chatId);
  }

  /** Check if a chat has an active run. */
  isRunning(chatId: string): boolean {
    const slot = this.slots.get(chatId);
    return slot?.state === "running" || slot?.state === "cancelling";
  }

  /**
   * Start a run for a chat (or resume if one is already active).
   * Returns the slot; the actual work happens via subscribe + followup.
   */
  async start(chatId: string, content: unknown, source: { kind: string }): Promise<RunSlot> {
    const slot = this.getOrCreate(chatId);

    // If running, queue the message (per-chat serialization).
    if (this.isRunning(chatId)) {
      slot.pending.push({ content, source });
      return slot;
    }

    // Resolve agent.
    const { agent, sessionId, handle } = await this.opts.resolveAgent(chatId);
    slot.agent = agent;
    slot.handle = handle;
    slot.sessionId = sessionId;

    // Subscribe to events.
    const unsub = this.opts.subscribe(
      agent,
      sessionId,
      (delta) => { slot.accumulatedText += delta; },
      () => { this.complete(chatId); },
      (e) => { this.fail(chatId, e); },
    );
    this.unsubs.set(chatId, unsub);

    // Start the turn.
    slot.state = "running";
    slot.cancelController = new AbortController();
    slot.accumulatedText = "";
    slot.turnId = (slot.turnId ?? 0) + 1;
    this.opts.followup(agent, this.opts.buildMessage(content, source));

    return slot;
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
    // Watchdog: force-complete if turn/end never arrives.
    setTimeout(() => {
      const s = this.slots.get(chatId);
      if (s && s.state === "cancelling") this.complete(chatId);
    }, 30_000).unref?.();
  }

  /** Mark a run as complete and process the next queued message. */
  private complete(chatId: string): void {
    const slot = this.slots.get(chatId);
    if (!slot || (slot.state !== "running" && slot.state !== "cancelling")) return;
    slot.state = "done";
    this.cleanup(chatId);
    this.opts.onComplete?.(slot);
    // Process next queued message.
    if (slot.pending.length > 0) {
      const next = slot.pending.shift()!;
      void this.start(chatId, next.content, next.source);
    }
  }

  /** Mark a run as failed and reset state. */
  private fail(chatId: string, error: Error): void {
    const slot = this.slots.get(chatId);
    if (!slot || slot.state === "done") return; // already completed
    slot.state = "done";
    slot.failedWith = error;
    this.cleanup(chatId);
    this.opts.onComplete?.(slot);
    // Process next queued message even on failure.
    if (slot.pending.length > 0) {
      const next = slot.pending.shift()!;
      void this.start(chatId, next.content, next.source);
    }
  }

  /** Dispose all owned agents and clear all slots. */
  private cleanup(chatId: string): void {
    const unsub = this.unsubs.get(chatId);
    if (unsub) { try { unsub(); } catch { /* gone */ } }
    this.unsubs.delete(chatId);
  }

  async disposeAll(): Promise<void> {
    const failures: Error[] = [];
    // Abort all controllers before disposing.
    for (const slot of this.slots.values()) {
      try { slot.cancelController?.abort(); } catch { /* gone */ }
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
