"use client";

import { ENTRY_MODELS, MODEL_IDS, SESSION_STRATEGIES, SESSION_VARIANTS, strategyName, type EntryModel } from "@aplus/engine";
import PlaybookChart from "@/components/PlaybookChart";
import { Chip } from "@/components/ui";
import { MODEL_SKETCH, STRATEGY_RULES, STRATEGY_SKETCH } from "@/lib/playbook";

/**
 * Playbook: every entry model and session strategy the engine trades, with a schematic chart and
 * the criteria as the detector applies them. Long versions are drawn; shorts are the mirror image.
 */

function Rule({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "56px minmax(0,1fr)", gap: 8, fontSize: 12.5, padding: "3px 0" }}>
      <span className="lbl" style={{ margin: 0 }}>{k}</span><span>{v}</span>
    </div>
  );
}

function tags(m: EntryModel) {
  const out: { l: string; tone: "up" | "warn" | "info" | "down" | "" }[] = [];
  out.push(m.aPlusEligible ? { l: "A+ eligible", tone: "up" } : { l: "grade A at most", tone: "warn" });
  if (m.counterTrend) out.push({ l: "counter-trend", tone: "down" });
  if (m.advanced) out.push({ l: "advanced", tone: "info" });
  if (m.shift === "optional_if_aggressive") out.push({ l: "shift optional (aggressive)", tone: "warn" });
  if (m.instruments) out.push({ l: `${m.instruments.join(", ")} only`, tone: "" });
  if (m.window) out.push({ l: m.window === "london_q" ? "London Q only" : "NY Q only", tone: "" });
  return out;
}

export default function Playbook() {
  return (
    <>
      <section className="card" style={{ padding: 14 }}>
        <p style={{ fontSize: 13, margin: 0 }}>
          Every entry model needs the A+ checklist first: HTF and 15M trend agree, price in the right half of the range, a quality POI,
          a sweep, a market shift (except where noted), the session window and no news, and a real target paying at least 2R.
          The model is the trigger, never the reason. Charts show longs; shorts are the mirror image.
        </p>
      </section>

      <h2 className="lbl-u" style={{ margin: "6px 0 -4px" }}>Entry models</h2>
      <div className="g12">
        {MODEL_IDS.map((id) => {
          const m = ENTRY_MODELS[id];
          return (
            <section key={id} className="card s4 col" style={{ gap: 10 }}>
              <PlaybookChart s={MODEL_SKETCH[id]} title={`${m.short}: ${m.name}`} />
              <div className="between">
                <h3 style={{ margin: 0, fontSize: 16 }}>{m.short}</h3>
                <span className="faint mono" style={{ fontSize: 11 }}>model {id}</span>
              </div>
              <span className="muted" style={{ fontSize: 12, marginTop: -6 }}>{m.name}</span>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>{tags(m).map((t) => <Chip key={t.l} tone={t.tone}>{t.l}</Chip>)}</div>
              <div>
                <div className="lbl-u" style={{ marginBottom: 4 }}>Sequence</div>
                <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.5 }}>{m.sequence.map((s) => <li key={s}>{s}</li>)}</ol>
              </div>
              <div>
                <div className="lbl-u" style={{ marginBottom: 4 }}>What the engine checks</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.5 }}>{m.detect.map((s) => <li key={s}>{s}</li>)}</ul>
              </div>
              <div className="divider" />
              <div>
                <Rule k="Entry" v={m.entry} />
                <Rule k="Stop" v={m.stop} />
                <Rule k="Target" v={m.target} />
              </div>
              {m.checks.length > 0 && <p className="faint" style={{ fontSize: 11.5, margin: 0 }}>Model check: {m.checks.map((c) => c.label).join(" · ")}</p>}
            </section>
          );
        })}
      </div>

      <h2 className="lbl-u" style={{ margin: "6px 0 -4px" }}>Session strategies</h2>
      <section className="card" style={{ padding: 14 }}>
        <p style={{ fontSize: 13, margin: 0 }}>
          Research strategies outside the A+ checklist: the range one session builds, traded in the next window. Each runs in four
          variants (with or without the HTF trend filter, with or without half off at 1R) and is logged and paper traded separately.
        </p>
      </section>
      <div className="g12">
        {SESSION_STRATEGIES.map((st) => {
          const r = STRATEGY_RULES[st.id]!;
          const variants = SESSION_VARIANTS.filter((v) => v.id === st.id || v.id.startsWith(`${st.id}-`));
          return (
            <section key={st.id} className="card s6 col" style={{ gap: 10 }}>
              <PlaybookChart s={STRATEGY_SKETCH[st.id]!} title={st.name} />
              <div className="between">
                <h3 style={{ margin: 0, fontSize: 16 }}>{st.name}</h3>
                <div className="row" style={{ gap: 6 }}><Chip tone={st.kind === "fade" ? "info" : "warn"}>{st.kind}</Chip><Chip>{st.range} range → {st.trade}</Chip></div>
              </div>
              <span className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>{st.summary}</span>
              <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.5 }}>{r.steps.map((s) => <li key={s}>{s}</li>)}</ol>
              <div>
                <Rule k="Entry" v={r.entry} />
                <Rule k="Stop" v={r.stop} />
                <Rule k="Target" v={r.target} />
              </div>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>{variants.map((v) => <Chip key={v.id}>{strategyName(v.id)}</Chip>)}</div>
            </section>
          );
        })}
      </div>
    </>
  );
}
