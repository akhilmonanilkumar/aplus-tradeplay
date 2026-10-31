import pg from "pg";
import type { FlowTrade } from "@aplus/engine";
import { errMsg } from "./http.js";

/**
 * Tick store on TimescaleDB (optional: without DATABASE_URL the host keeps trades in memory only).
 * Trades are buffered and written once a second; the schema lives in deploy/schema.sql.
 */
export class TickStore {
  private pool: pg.Pool | null = null;
  private buf: { venue: string; symbol: string; t: FlowTrade }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  written = 0;
  lastError: string | null = null;

  constructor(url: string) {
    if (url) this.pool = new pg.Pool({ connectionString: url, max: 4 });
  }

  get enabled() { return !!this.pool; }

  start() {
    if (!this.pool) return;
    this.timer = setInterval(() => void this.flush(), 1000);
  }

  add(venue: string, symbol: string, trades: FlowTrade[]) {
    if (!this.pool) return;
    for (const t of trades) this.buf.push({ venue, symbol, t });
    if (this.buf.length > 50_000) this.buf.splice(0, this.buf.length - 50_000); // never grow without bound if the DB is down
  }

  async flush() {
    if (!this.pool || !this.buf.length) return;
    const batch = this.buf.splice(0, 5000);
    const vals: unknown[] = [];
    const rows = batch.map((b, i) => {
      vals.push(new Date(b.t.t), b.venue, b.symbol, b.t.price, b.t.size, b.t.side === "buy" ? 1 : -1);
      const o = i * 6;
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6})`;
    });
    try {
      await this.pool.query(`insert into trades (ts, venue, symbol, price, size, side) values ${rows.join(",")}`, vals);
      this.written += batch.length;
      this.lastError = null;
    } catch (e) {
      this.lastError = errMsg(e);
      this.buf.unshift(...batch.slice(0, 20_000));
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
    await this.pool?.end();
  }

  status() { return { enabled: this.enabled, written: this.written, buffered: this.buf.length, error: this.lastError }; }
}
