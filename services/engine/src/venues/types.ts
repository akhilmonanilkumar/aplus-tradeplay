import { ClockSync } from "@aplus/engine";

export type StreamState = "off" | "connecting" | "open" | "polling" | "closed";

export interface VenueStatus {
  id: string; name: string; env: string;
  keys: boolean; execution: boolean;
  clock: { offsetMs: number | null; rttP95Ms: number | null; lastSyncAt: number | null; healthy: boolean; budgetMs: number; samples: number };
  stream: { state: StreamState; lastMessageAt: number | null; messages: number; reconnects: number; error: string | null };
  symbols: string[];
  note?: string;
}

/** Shared bookkeeping for every venue adapter. */
export abstract class VenueBase {
  readonly clock = new ClockSync();
  protected stream: VenueStatus["stream"] = { state: "off", lastMessageAt: null, messages: 0, reconnects: 0, error: null };
  protected timers: ReturnType<typeof setInterval>[] = [];
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly budgetMs: number;

  abstract start(): void;
  abstract syncClock(): Promise<void>;
  abstract status(): VenueStatus;

  stop() { for (const t of this.timers) clearInterval(t); this.timers = []; }

  protected every(ms: number, fn: () => unknown) {
    const run = async () => { try { await fn(); } catch (e) { this.stream.error = (e as Error).message; } };
    void run();
    this.timers.push(setInterval(run, ms));
  }

  protected baseStatus(extra: Omit<VenueStatus, "id" | "name" | "clock" | "stream">): VenueStatus {
    return {
      id: this.id, name: this.name,
      clock: { offsetMs: this.clock.offset(), rttP95Ms: this.clock.rttP95(), lastSyncAt: this.clock.lastAt(), healthy: this.clock.healthy(this.budgetMs), budgetMs: this.budgetMs, samples: this.clock.count },
      stream: { ...this.stream },
      ...extra,
    };
  }

  protected seen() { this.stream.lastMessageAt = Date.now(); this.stream.messages++; }
}
