"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import type { CSSProperties } from "react";
import { INSTRUMENTS, type DeskId, type InstrumentId } from "@aplus/engine";
import { useApi } from "@/lib/useApi";
import { useRows } from "@/lib/useRows";
import { num } from "@/lib/fmt";
import { ICONS } from "@/components/Shell";
import { Card, Empty, Icon } from "@/components/ui";
import DeskWorkspace from "@/components/views/DeskWorkspace";
import { AlertsTab, ChallengeTab } from "@/components/arena/PropDesk";
import Journal from "@/components/views/Journal";
import Bias from "@/components/views/Bias";
import Discipline from "@/components/views/Discipline";
import LiveExecution from "@/components/LiveExecution";
import { DepthTab, OiTab, OrderFlowTab, type FlowSource } from "@/components/arena/FlowTabs";

type VenueId = "cfd" | "delta" | "coinswitch" | "fyers";
/** A market in an arena. `engine` is the instrument the analysis engine reads; null until its adapter ships. */
type Market = { id: string; label: string; desk: DeskId; engine: InstrumentId | null; flow?: FlowSource; derivs?: "BTCUSDT" | "XAUUSDT" };

const DELTA_BTC: FlowSource = { venue: "delta", symbol: "BTCUSD", tick: 10, digits: 1 };
const DELTA_XAU: FlowSource = { venue: "delta", symbol: "XAUTUSD", tick: 0.5, digits: 2 };
const FLOW_TABS: Tab[] = [{ id: "flow", l: "Order flow" }, { id: "depth", l: "Depth" }, { id: "oi", l: "OI & funding" }];
type Tab = { id: string; l: string };

const ARENAS: Record<VenueId, { name: string; sub: string; ac: string; mode: string; markets: Market[]; tabs: Tab[] }> = {
  cfd: {
    name: "CFD Arena", sub: "Prop accounts on cTrader · alerts only, you place the orders", ac: "--cfd", mode: "Alerts only",
    markets: [
      { id: "XAUUSD", label: "XAUUSD", desk: "gold", engine: "XAUUSD", flow: { ...DELTA_XAU, note: "Reference: Delta XAUT perp" }, derivs: "XAUUSDT" },
      { id: "BTCUSD", label: "BTCUSD", desk: "btc", engine: "BTCUSD", flow: { ...DELTA_BTC, note: "Reference: Delta BTC perp" }, derivs: "BTCUSDT" },
      { id: "EURUSD", label: "EURUSD", desk: "fx", engine: "EURUSD" },
      { id: "GBPUSD", label: "GBPUSD", desk: "fx", engine: "GBPUSD" },
      { id: "USDJPY", label: "USDJPY", desk: "fx", engine: "USDJPY" },
      { id: "US500", label: "US500", desk: "indices", engine: "SPX500" },
      { id: "NAS100", label: "NAS100", desk: "indices", engine: "NAS100" },
    ],
    tabs: [{ id: "trade", l: "Trade" }, { id: "alerts", l: "Alerts" }, ...FLOW_TABS, { id: "challenge", l: "Challenge" }, { id: "journal", l: "Journal" }, { id: "bias", l: "Daily bias" }, { id: "discipline", l: "Discipline" }],
  },
  delta: {
    name: "Delta Arena", sub: "Delta Exchange India · runs promoted strategies on its own", ac: "--delta", mode: "Autonomous",
    markets: [
      { id: "BTCUSD", label: "BTCUSD perp", desk: "btc", engine: "BTCUSDT.P", flow: DELTA_BTC, derivs: "BTCUSDT" },
      { id: "XAUTUSD", label: "XAUTUSD perp", desk: "gold", engine: "XAUUSDT.P", flow: DELTA_XAU, derivs: "XAUUSDT" },
      { id: "ETHUSD", label: "ETHUSD perp", desk: "btc", engine: null, flow: { venue: "delta", symbol: "ETHUSD", tick: 1, digits: 2 } },
      { id: "BTC-OPT", label: "BTC options", desk: "btc", engine: null },
    ],
    tabs: [{ id: "trade", l: "Trade" }, ...FLOW_TABS, { id: "execution", l: "Execution" }],
  },
  coinswitch: {
    name: "CoinSwitch Arena", sub: "CoinSwitch PRO · runs promoted strategies on its own", ac: "--cs", mode: "Paper",
    markets: [
      { id: "BTCUSDT", label: "BTCUSDT perp", desk: "btc", engine: "BTCUSDT.P", flow: { venue: "coinswitch", symbol: "BTCUSDT", tick: 10, digits: 1 }, derivs: "BTCUSDT" },
      { id: "XAU", label: "Gold perp", desk: "gold", engine: "XAUUSDT.P" },
      { id: "ETHUSDT", label: "ETHUSDT perp", desk: "btc", engine: null, flow: { venue: "coinswitch", symbol: "ETHUSDT", tick: 1, digits: 2 } },
      { id: "XAG", label: "Silver perp", desk: "gold", engine: null },
    ],
    tabs: [{ id: "trade", l: "Trade" }, ...FLOW_TABS, { id: "connect", l: "Connection" }],
  },
  fyers: {
    name: "Fyers Arena", sub: "NSE and BSE derivatives · runs promoted strategies on its own", ac: "--fyers", mode: "Paper",
    markets: [
      { id: "NIFTY", label: "NIFTY", desk: "indices", engine: "NIFTY", flow: { venue: "fyers", symbol: "NSE:NIFTY50-INDEX", tick: 1, digits: 2 } },
      { id: "BANKNIFTY", label: "BANKNIFTY", desk: "indices", engine: null },
      { id: "SENSEX", label: "SENSEX", desk: "indices", engine: null },
    ],
    tabs: [{ id: "trade", l: "Trade" }, { id: "depth", l: "Depth" }, { id: "connect", l: "Connection" }],
  },
};

type Quote = { last: number; bid: number | null; ask: number | null; source: string };

function Pill({ m, on, href }: { m: Market; on: boolean; href: string }) {
  const q = useApi<Quote>(m.engine ? `/api/market/quote?i=${encodeURIComponent(m.engine)}` : null, 20_000);
  const digits = m.engine ? INSTRUMENTS[m.engine].digits : m.flow?.digits ?? 2;
  if (!m.engine && !m.flow) {
    return (
      <span className="pill" style={{ opacity: 0.55, cursor: "default" }} title="Market data for this market arrives with its venue adapter">
        <b>{m.label}</b><span className="px">—</span><span className="st">Adapter pending</span>
      </span>
    );
  }
  return (
    <Link href={href} className={`pill${on ? " on" : ""}`} aria-current={on ? "true" : undefined}>
      <b>{m.label}</b><span className="px">{q.data ? num(q.data.last, Math.min(digits, 5)) : m.engine ? "…" : "—"}</span>
      <span className="st"><span className={`led ${q.error ? "down" : q.data ? "live" : ""}`} />{!m.engine ? "Flow and depth" : q.error ? "No quote" : q.data?.source ?? "Loading"}</span>
    </Link>
  );
}

const SETUP: Record<"coinswitch" | "fyers", { what: string; steps: { t: string; d: string }[] }> = {
  coinswitch: {
    what: "CoinSwitch PRO trades through its HFT API with Ed25519-signed requests from the engine host's fixed IP.",
    steps: [
      { t: "Engine host is running", d: "DigitalOcean Bangalore droplet with a static IP" },
      { t: "API key created and IP whitelisted", d: "CoinSwitch PRO → Profile → API keys (Ed25519)" },
      { t: "Keys stored on the engine host", d: "Never in Vercel" },
      { t: "Options beta requested", d: "Email api@coinswitch.co" },
      { t: "Paper account restarted on CoinSwitch data", d: "Forward test before any live strategy" },
    ],
  },
  fyers: {
    what: "Fyers orders must come from a registered API app mapped to a static IP (SEBI retail-algo rules). Market data needs no static IP.",
    steps: [
      { t: "Engine host is running", d: "Its static IP is the one Fyers registers" },
      { t: "New Fyers API app registered with that IP", d: "Old apps are data-only" },
      { t: "Daily login and 15-day refresh token", d: "Token status shows in Integrations" },
      { t: "Symbol master synced daily", d: "Every order is checked against it" },
      { t: "Paper strategies on Nifty, Bank Nifty and Sensex", d: "Promoted to live from the Strategy League" },
    ],
  },
};

function Connect({ venue }: { venue: "coinswitch" | "fyers" }) {
  const s = SETUP[venue];
  return (
    <div className="g12">
      <Card span={7} title="Getting this arena live">
        <p className="muted" style={{ marginBottom: 6 }}>{s.what}</p>
        <div className="steps">
          {s.steps.map((x, i) => (
            <div key={x.t}><span className="n">{i + 1}</span><div><b style={{ fontWeight: 500 }}>{x.t}</b><div className="faint" style={{ fontSize: 12.5 }}>{x.d}</div></div><span className="chip">To do</span></div>
          ))}
        </div>
      </Card>
      <Card span={5} title="Until then">
        <p className="muted">The Trade tab runs the same analysis engine on reference market data, and strategies for this arena paper-trade in the Strategy League. Nothing is sent to {venue === "fyers" ? "Fyers" : "CoinSwitch"}.</p>
        <div className="row" style={{ marginTop: 14 }}><Link className="btn sm" href="/integrations">Open Integrations</Link><Link className="btn ghost sm" href="/league">Strategy League</Link></div>
      </Card>
    </div>
  );
}

function Engine({ venue }: { venue: VenueId }) {
  const sig = useRows<{ instrument: string; created_at: string }>({ table: "signals", select: "instrument,created_at", eq: ["state", "ARMED"], order: "created_at", limit: 20 });
  const armed = (sig.rows ?? []).filter((s) => Date.parse(s.created_at) > Date.now() - 18 * 3_600_000).length;
  return (
    <span className="engine"><span className={`led ${sig.error ? "down" : "live"}`} />
      {venue === "cfd" ? (armed ? `${armed} setup${armed > 1 ? "s" : ""} armed` : "Scanning 7 markets") : venue === "delta" ? "Running promoted strategies" : "Paper only"}
    </span>
  );
}

export default function ArenaPage() {
  const params = useParams<{ venue: string }>();
  const search = useSearchParams();
  const venue = (Object.keys(ARENAS) as VenueId[]).find((v) => v === params.venue) ?? "cfd";
  const a = ARENAS[venue];
  const tab = a.tabs.find((t) => t.id === search.get("tab"))?.id ?? "trade";
  const market = a.markets.find((m) => m.id === search.get("m") && (m.engine || m.flow)) ?? a.markets[0];
  const href = (p: { tab?: string; m?: string }) => {
    const q = new URLSearchParams();
    const m = p.m ?? market.id, t = p.tab ?? tab;
    if (m !== a.markets[0].id) q.set("m", m);
    if (t !== "trade") q.set("tab", t);
    const qs = q.toString();
    return `/arena/${venue}${qs ? `?${qs}` : ""}`;
  };
  const style = { "--ac": `var(${a.ac})` } as CSSProperties;

  return (
    <div className="col" style={{ ...style, gap: 14 }}>
      <div className="a-head">
        <span className="a-mark"><Icon d={ICONS[venue]} /></span>
        <div><h1>{a.name}</h1><p>{a.sub}</p></div>
        <div style={{ flex: 1 }} />
        <Engine venue={venue} />
        <span className={`chip ${venue === "cfd" ? "warn" : venue === "delta" ? "up" : ""}`}>{a.mode}</span>
      </div>

      <div className="inst" role="list">
        {a.markets.map((m) => <Pill key={m.id} m={m} on={m.id === market.id} href={href({ m: m.id })} />)}
      </div>

      <nav className="tabs" aria-label={`${a.name} sections`}>
        {a.tabs.map((t) => <Link key={t.id} href={href({ tab: t.id })} className={t.id === tab ? "on" : ""} aria-current={t.id === tab ? "page" : undefined}>{t.l}</Link>)}
      </nav>

      {tab === "trade" && (market.engine ? <DeskWorkspace key={market.engine} deskId={market.desk} inst={market.engine} /> : <Empty>The setup engine does not cover {market.label} yet. Its order flow, depth and open interest are in the other tabs.</Empty>)}
      {(tab === "flow" || tab === "depth" || tab === "oi") && !market.flow && <Empty>{market.label} is a CFD with no central order book. Order flow and depth need a futures feed (CME); gold and BTC use their perpetual markets instead.</Empty>}
      {tab === "flow" && market.flow && <OrderFlowTab key={market.id} src={market.flow} />}
      {tab === "depth" && market.flow && <DepthTab key={market.id} src={market.flow} />}
      {tab === "oi" && market.flow && <OiTab key={market.id} src={market.flow} derivs={market.derivs ?? null} />}
      {tab === "alerts" && <AlertsTab />}
      {tab === "challenge" && <ChallengeTab />}
      {tab === "journal" && <Journal />}
      {tab === "bias" && <Bias />}
      {tab === "discipline" && <Discipline />}
      {tab === "execution" && <LiveExecution />}
      {tab === "connect" && (venue === "coinswitch" || venue === "fyers") && <Connect venue={venue} />}
    </div>
  );
}
