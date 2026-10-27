"use client";

import { ALL_WINDOWS, OI_REGIME_TEXT, type DeskId, sessionStats, windowOnDateOf, type Candle, type OiRegime } from "@aplus/engine";
import type { Derivs } from "@/lib/server/derivs";
import type { Macro } from "@/lib/server/macro";
import type { CalEvent, Headline } from "@/lib/server/news";
import type { Liq } from "@/lib/useLive";
import { money, num, timeShort } from "@/lib/fmt";
import { Card, Chip, Empty } from "@/components/ui";
import Sparkline from "@/components/Sparkline";

const signedPct = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
const tone = (v: number | null | undefined) => (v === null || v === undefined ? "" : v > 0 ? "up" : v < 0 ? "down" : "");
const compact = (v: number | null | undefined) => (v === null || v === undefined ? "—" : Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v));
const REGIME_TONE: Record<OiRegime, "up" | "down" | "warn" | "info" | ""> = { long_build: "up", short_build: "down", short_cover: "info", long_unwind: "warn", neutral: "" };

/* ---------------- derivatives ---------------- */

export function DerivsCard({ d, error, liqs, title = "Derivatives positioning", span = 6 }: { d: Derivs | null; error: string | null; liqs?: Liq[]; title?: string; span?: 4 | 6 | 12 }) {
  if (!d) return <Card span={span} title={title}>{error ? <Empty>{error}</Empty> : <Empty>Loading funding and open interest…</Empty>}</Card>;
  const f = d.funding;
  const takerLast = d.taker.slice(-4);
  const takerRatio = takerLast.length ? takerLast.reduce((a, x) => a + x.buy, 0) / Math.max(1e-9, takerLast.reduce((a, x) => a + x.sell, 0)) : null;
  const top = d.ls.top.at(-1), glob = d.ls.global.at(-1);
  return (
    <Card span={span} title={title} right={<Chip>Binance{d.venues.length > 1 ? ` + ${d.venues.length - 1} venues` : ""} · {timeShort(d.at, "Asia/Kolkata")}</Chip>}>
      <div className="auto-s" style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 10 }}>
        <div><div className="lbl">Funding / 8h</div><div className={`kv sm ${tone(f.last)}`}>{f.last !== null ? `${(f.last * 100).toFixed(4)}%` : "—"}</div><div className="faint" style={{ fontSize: 11 }}>{f.state?.replace("_", " ") ?? ""} · {f.apr !== null ? `${f.apr.toFixed(1)}% APR` : ""}</div></div>
        <div><div className="lbl">Open interest</div><div className="kv sm">{compact(d.oi.nowUsd)}</div><div className="faint" style={{ fontSize: 11 }}>{compact(d.oi.now)} contracts</div></div>
        <div><div className="lbl">Basis (mark − index)</div><div className={`kv sm ${tone(d.basisPct)}`}>{signedPct(d.basisPct, 3)}</div><div className="faint" style={{ fontSize: 11 }}>mark {num(d.mark, 2)}</div></div>
        <div><div className="lbl">Next funding</div><div className="kv sm">{f.next ? timeShort(f.next, "Asia/Kolkata") : "—"}</div><div className="faint" style={{ fontSize: 11 }}>IST</div></div>
      </div>

      <div className="lbl-u" style={{ margin: "14px 0 4px" }}>OI change × price change</div>
      <div className="tbl-w">
        <table className="tbl">
          <thead><tr><th>Window</th><th className="r">Price</th><th className="r">OI</th><th>Read</th></tr></thead>
          <tbody>
            {d.oi.windows.map((w) => (
              <tr key={w.label}>
                <td className="mono">{w.label}</td>
                <td className={`r mono ${tone(w.priceChg)}`}>{signedPct(w.priceChg)}</td>
                <td className={`r mono ${tone(w.oiChg)}`}>{signedPct(w.oiChg)}</td>
                <td>{w.regime ? <Chip tone={REGIME_TONE[w.regime]}>{OI_REGIME_TEXT[w.regime]}</Chip> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="auto-s" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10, marginTop: 12 }}>
        <div><div className="lbl">OI 7 days</div><Sparkline values={d.oi.hist.map((x) => x.usd)} width={150} /></div>
        <div><div className="lbl">Funding history</div><Sparkline values={f.history.map((x) => x.rate)} width={150} zero tone="var(--warn)" /></div>
        <div><div className="lbl">Taker buy/sell 4h</div><div className={`kv sm ${takerRatio !== null ? (takerRatio > 1 ? "up" : "down") : ""}`}>{takerRatio !== null ? takerRatio.toFixed(2) : "—"}</div></div>
      </div>
      <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 10, marginTop: 10 }}>
        <div><div className="lbl">Top-trader long/short (positions)</div><div className="row"><b className="mono">{top ? top.ratio.toFixed(2) : "—"}</b><Sparkline values={d.ls.top.map((x) => x.ratio)} width={110} /></div></div>
        <div><div className="lbl">All accounts long/short</div><div className="row"><b className="mono">{glob ? glob.ratio.toFixed(2) : "—"}</b><span className="faint" style={{ fontSize: 11 }}>{glob ? `${(glob.long * 100).toFixed(0)}% long` : ""}</span></div></div>
      </div>
      {d.venues.length > 1 && (
        <>
          <div className="lbl-u" style={{ margin: "12px 0 4px" }}>By venue</div>
          {d.venues.map((v) => (
            <div key={v.venue} className="between" style={{ fontSize: 12.5, padding: "4px 0" }}>
              <span>{v.venue}</span>
              <span className="mono">{compact(v.oiUsd)} OI · <span className={tone(v.funding)}>{v.funding !== null ? `${(v.funding * 100).toFixed(4)}%` : "—"}</span></span>
            </div>
          ))}
        </>
      )}
      {liqs && (
        <>
          <div className="lbl-u" style={{ margin: "12px 0 4px" }}>Live liquidations</div>
          {liqs.length === 0 ? <p className="faint" style={{ fontSize: 12 }}>None since the page opened.</p> : liqs.slice(0, 6).map((l, i) => (
            <div key={i} className="between mono" style={{ fontSize: 12, padding: "2px 0" }}>
              <span className={l.side === "long" ? "down" : "up"}>{l.side === "long" ? "Longs" : "Shorts"} liquidated</span>
              <span>{money(l.usd, "USD", 0)} @ {num(l.price, 1)} <span className="faint">{timeShort(l.t, "Asia/Kolkata")}</span></span>
            </div>
          ))}
        </>
      )}
      {d.errors.length > 0 && <p className="faint" style={{ fontSize: 11, marginTop: 8 }}>Partial: {d.errors.slice(0, 3).join(" · ")}</p>}
    </Card>
  );
}

/* ---------------- macro & correlations ---------------- */

export function MacroCard({ m, error, desk, span = 6 }: { m: Macro | null; error: string | null; desk: "gold" | "btc"; span?: 4 | 6 | 12 }) {
  if (!m) return <Card span={span} title="Dollar, rates & cross-assets">{error ? <Empty>{error}</Empty> : <Empty>Loading DXY, yields and correlations…</Empty>}</Card>;
  const dxy = m.series.find((s) => s.id === "dxy"), y10 = m.series.find((s) => s.id === "us10y");
  return (
    <Card span={span} title="Dollar, rates & cross-assets" right={<Chip>1H · 30d correlation vs {desk === "gold" ? "gold" : "BTC"}</Chip>}>
      <div className="auto-s" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10, marginBottom: 10 }}>
        <div>
          <div className="lbl">US Dollar Index</div>
          <div className="row"><span className="kv sm">{num(dxy?.last, 2)}</span><span className={`mono ${tone(dxy?.chg24h)}`} style={{ fontSize: 12 }}>{signedPct(dxy?.chg24h)}</span></div>
          <Sparkline values={dxy?.spark ?? []} width={140} />
        </div>
        <div>
          <div className="lbl">US 10Y yield</div>
          <div className="row"><span className="kv sm">{num(y10?.last, 3)}%</span><span className={`mono ${tone(y10?.chgBp24h)}`} style={{ fontSize: 12 }}>{y10?.chgBp24h !== null && y10?.chgBp24h !== undefined ? `${y10.chgBp24h >= 0 ? "+" : ""}${y10.chgBp24h.toFixed(1)} bp` : ""}</span></div>
          <Sparkline values={y10?.spark ?? []} width={140} tone="var(--warn)" />
        </div>
        {desk === "gold" ? (
          <div>
            <div className="lbl">10Y real yield · COT</div>
            <div className="kv sm">{m.realYield ? `${m.realYield.value.toFixed(2)}%` : "—"}</div>
            <div className="faint" style={{ fontSize: 11 }}>{m.realYield ? `${m.realYield.chgBp5d !== null ? `${m.realYield.chgBp5d >= 0 ? "+" : ""}${m.realYield.chgBp5d.toFixed(0)} bp 5d` : ""}` : "add FRED_API_KEY"}{m.cot ? ` · MM net ${compact(m.cot.netLong)} (z ${m.cot.z?.toFixed(1) ?? "—"})` : ""}</div>
          </div>
        ) : (
          <div>
            <div className="lbl">Nasdaq-100 trend</div>
            {(() => { const nq = m.series.find((s) => s.id === "nq"); return <><div className={`kv sm ${nq?.trend === 1 ? "up" : nq?.trend === -1 ? "down" : ""}`}>{nq?.trend === 1 ? "Up" : nq?.trend === -1 ? "Down" : "Flat"}</div><div className="faint" style={{ fontSize: 11 }}>{signedPct(nq?.chg24h)} 24h</div></>; })()}
          </div>
        )}
      </div>
      <div className="tbl-w">
        <table className="tbl">
          <thead><tr><th>Asset</th><th className="r">Last</th><th className="r">24h</th><th className="r">Corr 30d</th><th className="r">Corr 7d</th><th className="r">β</th><th>48h rolling</th></tr></thead>
          <tbody>
            {m.series.map((s) => (
              <tr key={s.id}>
                <td>{s.label}</td>
                <td className="r mono">{num(s.last, s.last !== null && s.last < 10 ? 4 : 2)}</td>
                <td className={`r mono ${tone(s.chgBp24h ?? s.chg24h)}`}>{s.chgBp24h !== undefined && s.chgBp24h !== null ? `${s.chgBp24h >= 0 ? "+" : ""}${s.chgBp24h.toFixed(1)}bp` : signedPct(s.chg24h)}</td>
                <td className={`r mono ${corrTone(s.corr30d)}`}>{s.corr30d !== null ? s.corr30d.toFixed(2) : "—"}</td>
                <td className={`r mono ${corrTone(s.corr7d)}`}>{s.corr7d !== null ? s.corr7d.toFixed(2) : "—"}</td>
                <td className="r mono faint">{s.beta30d !== null ? s.beta30d.toFixed(2) : "—"}</td>
                <td><Sparkline values={s.rolling.map((p) => p.v)} width={90} height={20} zero /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="faint" style={{ fontSize: 11, marginTop: 8 }}>Correlation of hourly returns with {m.base}. |ρ| ≥ 0.5 strong (green/red), 0.25–0.5 moderate. Context only: it grades confluence, never the A+ gate.{m.errors.length ? ` Partial: ${m.errors.slice(0, 2).join(" · ")}` : ""}</p>
    </Card>
  );
}
const corrTone = (c: number | null) => (c === null ? "faint" : Math.abs(c) >= 0.5 ? (c > 0 ? "up" : "down") : Math.abs(c) >= 0.25 ? "" : "faint");

/* ---------------- sessions ---------------- */

export function SessionsPanel({ candles, now, digits = 2, span = 4 }: { candles: Candle[]; now: number; digits?: number; span?: 4 | 6 | 12 }) {
  // Today's Asia (previous NY evening) → London → NY → London close, in order.
  const asiaStart = windowOnDateOf(now - 24 * 3_600_000, ALL_WINDOWS[0]);
  const wins = [
    { id: "asia_q", name: "Asia", startUtc: asiaStart.startUtc, endUtc: asiaStart.endUtc },
    ...ALL_WINDOWS.slice(1).map((w) => { const x = windowOnDateOf(now, w); return { id: w.id, name: w.name, startUtc: x.startUtc, endUtc: x.endUtc }; }),
  ];
  const latestAsia = windowOnDateOf(now, ALL_WINDOWS[0]);
  if (latestAsia.startUtc <= now) wins.push({ id: "asia_next", name: "Asia (tonight)", startUtc: latestAsia.startUtc, endUtc: latestAsia.endUtc });
  const stats = sessionStats(candles, wins, now);
  return (
    <Card span={span} title="Session analysis" right={<Chip>NY-anchored · IST shown</Chip>}>
      {wins.map((w) => {
        const s = stats.find((x) => x.id === w.id);
        const live = now >= w.startUtc && now < w.endUtc;
        return (
          <div key={w.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
            <div className="between">
              <b style={{ fontSize: 12.5 }}>{w.name} <span className="faint mono" style={{ fontWeight: 400, fontSize: 11 }}>{timeShort(w.startUtc, "Asia/Kolkata")}–{timeShort(w.endUtc, "Asia/Kolkata")} IST</span></b>
              {live ? <Chip tone="up" dot>Live</Chip> : now < w.startUtc ? <Chip>Later</Chip> : <Chip>Done</Chip>}
            </div>
            {s ? (
              <div className="row mono" style={{ fontSize: 11.5, marginTop: 4, gap: 10 }}>
                <span>H {num(s.high, digits)}</span><span>L {num(s.low, digits)}</span>
                <span className={s.close >= s.open ? "up" : "down"}>{s.close >= s.open ? "▲" : "▼"} {s.rangePct.toFixed(2)}%</span>
                {s.sweptPrevHigh && <Chip tone="warn">took prior high</Chip>}
                {s.sweptPrevLow && <Chip tone="warn">took prior low</Chip>}
              </div>
            ) : <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>No candles yet</div>}
          </div>
        );
      })}
      <p className="faint" style={{ fontSize: 11, marginTop: 8 }}>Trade windows: London Q and NY Q. Asia builds the range that London sweeps; London close retraces.</p>
    </Card>
  );
}

/* ---------------- news & calendar ---------------- */

export function NewsCard({ items, error, ai, onAi, busy, span = 6 }: { items: Headline[] | null; error: string | null; ai: { overall?: string; score?: number; summary?: string; items?: { i: number; tone: string; why: string }[] } | null; onAi: () => void; busy: boolean; span?: 4 | 6 | 12 }) {
  const toneOf = (i: number, h: Headline) => ai?.items?.find((x) => x.i === i)?.tone ?? h.tone;
  return (
    <Card span={span} title="News" right={<><button className="btn sm" onClick={onAi} disabled={busy || !items?.length}>{busy ? "Reading…" : "AI read"}</button></>}>
      {ai?.summary && (
        <div className={`banner ${ai.overall === "bullish" ? "up" : ai.overall === "bearish" ? "down" : "info"}`} style={{ marginBottom: 10 }}>
          <span className="dot" /><span><b>{ai.overall ?? "read"}{ai.score !== undefined ? ` ${ai.score > 0 ? "+" : ""}${ai.score}` : ""}.</b> {ai.summary}</span>
        </div>
      )}
      {!items ? <Empty>{error ?? "Loading headlines…"}</Empty> : items.length === 0 ? <Empty>No headlines</Empty> : (
        <div className="col" style={{ gap: 0, maxHeight: 420, overflowY: "auto" }}>
          {items.slice(0, 25).map((h, i) => {
            const t = toneOf(i, h);
            const why = ai?.items?.find((x) => x.i === i)?.why;
            return (
              <a key={h.id} href={h.url} target="_blank" rel="noreferrer noopener" style={{ display: "grid", gridTemplateColumns: "44px minmax(0,1fr) auto", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line)", fontSize: 12.5 }}>
                <span className="mono faint" style={{ fontSize: 11 }}>{timeShort(h.at, "Asia/Kolkata")}</span>
                <span style={{ minWidth: 0 }}>{h.title}<span className="faint" style={{ fontSize: 11 }}> · {h.source}{why ? ` · ${why}` : ""}</span></span>
                <Chip tone={t === "bullish" ? "up" : t === "bearish" ? "down" : ""}>{t}</Chip>
              </a>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function CalendarCard({ events, error, desk, blockMinutes, now, span = 6 }: { events: CalEvent[] | null; error: string | null; desk: DeskId; blockMinutes: number; now: number; span?: 4 | 6 | 12 }) {
  const list = (events ?? []).filter((e) => e.desks.includes(desk) && (e.impact === "high" || e.impact === "medium") && e.at > now - 6 * 3_600_000).slice(0, 14);
  const blocked = list.find((e) => e.impact === "high" && Math.abs(e.at - now) <= blockMinutes * 60_000);
  return (
    <Card span={span} title="Economic calendar" right={blocked ? <Chip tone="down" dot>News block now</Chip> : <Chip tone="up">Clear</Chip>}>
      {!events ? <Empty>{error ?? "Loading calendar…"}</Empty> : list.length === 0 ? <Empty>No high or medium impact events this week</Empty> : (
        <div className="col" style={{ gap: 0, maxHeight: 420, overflowY: "auto" }}>
          {list.map((e) => {
            const past = e.at < now;
            return (
              <div key={e.id} style={{ display: "grid", gridTemplateColumns: "92px minmax(0,1fr) auto", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line)", fontSize: 12.5, opacity: past ? 0.55 : 1 }}>
                <span className="mono faint" style={{ fontSize: 11 }}>{new Date(e.at).toLocaleDateString("en-GB", { weekday: "short", timeZone: "Asia/Kolkata" })} {timeShort(e.at, "Asia/Kolkata")}</span>
                <span style={{ minWidth: 0 }}>
                  <b style={{ fontWeight: 500 }}>{e.currency} · {e.title}</b>
                  <span className="faint mono" style={{ fontSize: 11 }}> {e.forecast ? `f ${e.forecast}` : ""}{e.previous ? ` · p ${e.previous}` : ""}{e.impact === "high" ? ` · no-trade ${timeShort(e.at - blockMinutes * 60_000, "Asia/Kolkata")}–${timeShort(e.at + blockMinutes * 60_000, "Asia/Kolkata")}` : ""}</span>
                </span>
                <Chip tone={e.impact === "high" ? "down" : "warn"}>{e.impact}</Chip>
              </div>
            );
          })}
        </div>
      )}
      <p className="faint" style={{ fontSize: 11, marginTop: 8 }}>Times in IST. High-impact USD events block new entries ±{blockMinutes} min on both desks (Forex Factory feed).</p>
    </Card>
  );
}
