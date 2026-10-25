"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { EDGE_WINDOWS, evaluateGate, isInWindow, type GateInput } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { num, toNum } from "@/lib/fmt";
import { Badge, Card, ErrorNote, Field, PageHead, Segmented } from "@/components/ui";

type Inst = "XAUUSD" | "BTCUSDT.P";
const TF: Record<Inst, string> = { XAUUSD: "1H · 15M · 5M", "BTCUSDT.P": "4H · 15M · 5M" };

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => set(!on)} className={`flex items-center justify-between rounded-xl px-3 py-2.5 text-sm transition ${on ? "bg-up/12 text-ink ring-1 ring-up/40" : "bg-raised text-mute"}`}>
      {label}
      <span className={`grid h-5 w-5 place-items-center rounded-full text-[11px] ${on ? "bg-up text-[#0b0c0f]" : "bg-line"}`}>{on ? "✓" : ""}</span>
    </button>
  );
}

export default function Copilot() {
  const router = useRouter();
  const [inst, setInst] = useState<Inst>("XAUUSD");
  const [side, setSide] = useState<"long" | "short">("long");
  const [model, setModel] = useState<"A" | "B" | "C">("A");
  const [htf, setHtf] = useState<"up" | "down" | "">("");
  const [poiTf, setPoiTf] = useState<"up" | "down" | "">("");
  const [range, setRange] = useState({ low: "", high: "" });
  const [plan, setPlan] = useState({ entry: "", stop: "", target: "" });
  const [poi, setPoi] = useState({ inside: false, fresh: true, trendAligned: true, liquidityStory: false });
  const [swept, setSwept] = useState(false);
  const [shifted, setShifted] = useState(false);
  const [newsClear, setNewsClear] = useState(true);
  const [structural, setStructural] = useState(true);
  const [concern, setConcern] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const liveWindow = EDGE_WINDOWS.find((w) => isInWindow(now, w)) ?? null;

  const result = useMemo(() => {
    const e = toNum(plan.entry), s = toNum(plan.stop), t = toNum(plan.target);
    const lo = toNum(range.low), hi = toNum(range.high);
    const hasPlan = [e, s, t].every((x) => Number.isFinite(x) && x > 0) && e !== s;
    const hasRange = Number.isFinite(lo) && Number.isFinite(hi) && hi > lo;
    if (!hasRange) return null;
    const input: GateInput = {
      htfTrend: htf || null,
      poiTfTrend: poiTf || null,
      side,
      price: hasPlan ? e : (lo + hi) / 2,
      range: { low: lo, high: hi },
      poi: { inside: poi.inside, fresh: poi.fresh, trendAligned: poi.trendAligned, liquidityStory: poi.liquidityStory },
      swept,
      shifted,
      timing: { inWindow: !!liveWindow, newsClear },
      plan: hasPlan ? { entry: e, stop: s, target: t, targetIsStructural: structural } : undefined,
      minRR: 3,
      minStopPct: inst === "BTCUSDT.P" ? 0.4 : undefined,
      qualityConcern: concern.trim() || null,
    };
    try { return { input, out: evaluateGate(input) }; } catch (err) { return { input, err: (err as Error).message }; }
  }, [plan, range, htf, poiTf, side, poi, swept, shifted, liveWindow, newsClear, structural, inst, concern]);

  const save = async () => {
    if (!result || !("out" in result) || !result.out || !result.input.plan) return;
    setBusy(true);
    setError(null);
    const { input, out } = result;
    const { data, error } = await supabase.from("signals").insert({
      instrument: inst, side, model, session_window: liveWindow?.id ?? null,
      entry: input.plan!.entry, stop: input.plan!.stop, target: input.plan!.target,
      rr: out.rr, grade: out.grade, gate: out.boxes, state: out.verdict === "GO" ? "ARMED" : "PLANNED", edge_version: "1.0",
    }).select("id").single();
    setBusy(false);
    if (error) return setError(error.message);
    router.push(`/copy?s=${data.id}`);
  };

  const out = result && "out" in result ? result.out : null;
  const verdictTone = out?.verdict === "GO" ? "up" : out?.verdict === "NO" ? "down" : "warn";

  return (
    <div>
      <PageHead title="Copilot" right={<Segmented value={inst} onChange={setInst} options={[{ v: "XAUUSD", l: "XAUUSD" }, { v: "BTCUSDT.P", l: "BTCUSDT.P" }]} />} />
      <ErrorNote error={error} />
      <div className="grid gap-4 xl:grid-cols-[1.15fr_1fr]">
        <div className="space-y-4">
          <Card title="Structure" right={<span className="num text-xs text-mute">{TF[inst]}</span>}>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Side"><Segmented value={side} onChange={setSide} options={[{ v: "long", l: "Long" }, { v: "short", l: "Short" }]} /></Field>
              <Field label="HTF"><Segmented value={htf} onChange={setHtf} options={[{ v: "up", l: "Up" }, { v: "down", l: "Down" }, { v: "", l: "—" }]} /></Field>
              <Field label="15M"><Segmented value={poiTf} onChange={setPoiTf} options={[{ v: "up", l: "Up" }, { v: "down", l: "Down" }, { v: "", l: "—" }]} /></Field>
              <Field label="Range low"><input className="input num" inputMode="decimal" value={range.low} onChange={(e) => setRange({ ...range, low: e.target.value })} /></Field>
              <Field label="Range high"><input className="input num" inputMode="decimal" value={range.high} onChange={(e) => setRange({ ...range, high: e.target.value })} /></Field>
              <Field label="Model"><Segmented value={model} onChange={setModel} options={[{ v: "A", l: "A" }, { v: "B", l: "B" }, { v: "C", l: "C" }]} /></Field>
            </div>
          </Card>
          <Card title="POI → sweep → shift">
            <div className="grid gap-2 sm:grid-cols-2">
              <Toggle label="Price inside POI" on={poi.inside} set={(v) => setPoi({ ...poi, inside: v })} />
              <Toggle label="POI fresh" on={poi.fresh} set={(v) => setPoi({ ...poi, fresh: v })} />
              <Toggle label="POI with trend" on={poi.trendAligned} set={(v) => setPoi({ ...poi, trendAligned: v })} />
              <Toggle label="Liquidity story" on={poi.liquidityStory} set={(v) => setPoi({ ...poi, liquidityStory: v })} />
              <Toggle label="Liquidity swept" on={swept} set={setSwept} />
              <Toggle label="5M body-close shift" on={shifted} set={setShifted} />
              <Toggle label="News clear ±15m" on={newsClear} set={setNewsClear} />
              <Toggle label="Target is a real level" on={structural} set={setStructural} />
            </div>
          </Card>
          <Card title="Plan">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Entry"><input className="input num" inputMode="decimal" value={plan.entry} onChange={(e) => setPlan({ ...plan, entry: e.target.value })} /></Field>
              <Field label="Stop"><input className="input num" inputMode="decimal" value={plan.stop} onChange={(e) => setPlan({ ...plan, stop: e.target.value })} /></Field>
              <Field label="Target"><input className="input num" inputMode="decimal" value={plan.target} onChange={(e) => setPlan({ ...plan, target: e.target.value })} /></Field>
            </div>
            <Field label="Quality concern" className="mt-3"><input className="input" placeholder="e.g. obstacle before target" value={concern} onChange={(e) => setConcern(e.target.value)} /></Field>
          </Card>
        </div>

        <div className="xl:sticky xl:top-4 xl:self-start">
          <Card title="A+ gate" right={out ? <Badge tone={verdictTone}>{out.grade.replace("_", " ")}</Badge> : <Badge>{liveWindow ? liveWindow.name : "Off-window"}</Badge>}>
            {!result ? <p className="text-sm text-mute">Enter the range to start.</p> : "err" in result && result.err ? <p className="text-sm text-down">{result.err}</p> : out && (
              <>
                <div className={`mb-4 flex items-center justify-between rounded-2xl p-4 ${out.verdict === "GO" ? "bg-up/12" : out.verdict === "NO" ? "bg-down/12" : "bg-warn/10"}`}>
                  <span className={`text-3xl font-semibold tracking-tight ${out.verdict === "GO" ? "text-up" : out.verdict === "NO" ? "text-down" : "text-warn"}`}>{out.verdict}</span>
                  <span className="num text-xl">{out.rr !== null ? `${num(out.rr, 2)}R` : "—"}</span>
                </div>
                <ol className="space-y-2">
                  {out.boxes.map((b) => (
                    <li key={b.id} className="flex items-start gap-3 rounded-xl bg-raised px-3 py-2.5">
                      <span className={`num mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold ${b.status === "pass" ? "bg-up text-[#0b0c0f]" : b.status === "fail" ? "bg-down text-white" : "bg-line text-mute"}`}>{b.n}</span>
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{b.label}</div>
                        <div className="text-xs text-mute">{b.reason}</div>
                      </div>
                    </li>
                  ))}
                </ol>
                <button className="btn-accent mt-4 w-full" onClick={save} disabled={busy || !result.input.plan || out.verdict === "NO"}>
                  {busy ? "Saving…" : out.verdict === "GO" ? "Save signal → copy" : "Save as planned"}
                </button>
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
