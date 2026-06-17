import React, { useState, useMemo, useRef } from "react";
import { ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from "recharts";
import { MODEL as BASE_MODEL } from "./forecastModel.js";
import { runForecast } from "./engine.js";
import { parseMonthlyWorkbook, applyActualsToModel } from "./uploadParser.js";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmt0 = (v) => v == null ? "—" : Math.round(v).toLocaleString();
const fmtSign = (v) => (v >= 0 ? "+" : "") + Math.round(v).toLocaleString();
const pct = (a, b) => b ? ((a - b) / Math.abs(b) * 100) : 0;
const pctStr = (a, b) => { const p = pct(a, b); return Math.abs(p) < 0.05 ? "on budget" : (p >= 0 ? "+" : "") + p.toFixed(0) + "%"; };

// headline metrics shown on every card
const HEAD = [
  { key: "TotInc", label: "Total income" },
  { key: "Borrower", label: "Borrowers", count: true },
  { key: "GLP", label: "Portfolio (GLP)" },
];

const CONF = {
  high:   { label: "High",   color: "var(--green)" },
  medium: { label: "Medium", color: "var(--amber)" },
  low:    { label: "Low",    color: "var(--red)" },
};

// override lines and their spread defaults (for the panel hints)
const OV_LINES = [
  { key: "revenue", label: "Revenue", hint: "spread pro-rata over open months" },
  { key: "salary", label: "Salary & benefits", hint: "spread evenly over open months" },
  { key: "travel", label: "Travel & transport", hint: "spread evenly over open months" },
  { key: "other", label: "Other OpEx", hint: "spread pro-rata over open months" },
  { key: "finexp", label: "Financial expense", hint: "spread pro-rata over open months" },
  { key: "ecl", label: "ECL / loan loss", hint: "spread pro-rata over open months" },
];

function fallbackCopy(text, done) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    document.execCommand("copy"); document.body.removeChild(ta);
    if (done) done();
  } catch (e) { /* clipboard unavailable */ }
}

// ---- persistence (survive page refresh) ----
const LS_ACTUALS = "bihbv_fc_actuals_v1";
const LS_OVERRIDES = "bihbv_fc_overrides_v1";

function loadStoredOverrides() {
  try { const s = localStorage.getItem(LS_OVERRIDES); return s ? JSON.parse(s) : {}; } catch { return {}; }
}
// Rebuild a model from stored parsed-actuals; falls back to BASE_MODEL.
function loadStoredModel() {
  try {
    const s = localStorage.getItem(LS_ACTUALS);
    if (!s) return BASE_MODEL;
    const parsed = JSON.parse(s);
    if (!parsed || !parsed.cutoff) return BASE_MODEL;
    return applyActualsToModel(BASE_MODEL, parsed);
  } catch { return BASE_MODEL; }
}

export default function App() {
  const [model, setModel] = useState(loadStoredModel);
  const [overrides, setOverrides] = useState(loadStoredOverrides);
  const [expanded, setExpanded] = useState(null);   // entity name or "Consolidated"
  const [uploadMsg, setUploadMsg] = useState(null);
  const [exportMsg, setExportMsg] = useState(null);
  const fileRef = useRef();

  const fc = useMemo(() => runForecast(null, model, overrides), [model, overrides]);
  const cutoff = fc.cutoff;
  const closedThru = cutoff > 0 ? MONTHS[cutoff - 1] : "—";

  // persist overrides whenever they change
  React.useEffect(() => {
    try { localStorage.setItem(LS_OVERRIDES, JSON.stringify(overrides)); } catch {}
  }, [overrides]);

  // Build the dashboard export: Entity, Metric, Forecast (post-override).
  // Metrics match the dashboard's projection section: Borrowers, GLP,
  // Disbursement, Net Profit (from engine, incl. overrides) + PAR (latest actual
  // less a small write-off assumption, as the dashboard does).
  function buildExportRows() {
    const PAR_WO = { Tanzania:0.009, Uganda:0.0177, Myanmar:0.013, Liberia:0.006, "Sierra Leone":0.0242, Rwanda:0.0167, Ghana:0.02, Kenya:0.0 };
    const rows = [["Entity", "Borrowers", "GLP", "Disbursement", "NetProfit", "PAR", "AsOfMonths", "AsOf"]];
    let cB=0, cG=0, cD=0, cNP=0;
    for (const e of fc.entities) {
      const b = e.metrics.Borrower ? e.metrics.Borrower.fy : 0;
      const g = e.metrics.GLP ? e.metrics.GLP.fy : 0;
      const d = e.metrics.Disb ? e.metrics.Disb.fy : 0;
      const np = e.derivedNP || 0;
      const parAct = (model.parActual && model.parActual[e.entity]) || null;
      const par = parAct != null ? Math.max(0, parAct - (PAR_WO[e.entity] || 0)) : "";
      rows.push([e.entity, Math.round(b), Math.round(g), Math.round(d), Math.round(np), par === "" ? "" : par.toFixed(4), cutoff, closedThru + " 2026"]);
      cB += b; cG += g; cD += d; cNP += np;
    }
    // Consolidated = bottom-up sums (NP already includes eliminations via engine)
    rows.push(["Consolidated", Math.round(fc.consol.Borrower.fy), Math.round(fc.consol.GLP.fy), Math.round(fc.consol.Disb.fy), Math.round(fc.consolNP), (model.parActual && model.parActual.Consolidated ? (model.parActual.Consolidated - 0.0124).toFixed(4) : ""), cutoff, closedThru + " 2026"]);
    return rows;
  }

  function exportForDashboard() {
    const rows = buildExportRows();
    const tsv = rows.map(r => r.join("\t")).join("\n");
    const done = () => { setExportMsg("Copied ✓"); setTimeout(() => setExportMsg(null), 2000); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(tsv).then(done, () => fallbackCopy(tsv, done));
      } else { fallbackCopy(tsv, done); }
    } catch (e) { fallbackCopy(tsv, done); }
  }

  // entity list incl consolidated (consolidated rendered specially)
  const entityRows = fc.entities;

  function handleFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = parseMonthlyWorkbook(e.target.result);
        if (!parsed.cutoff) { setUploadMsg({ ok: false, text: "Could not detect actual months. Check the file is a BIHBV monthly summary." }); return; }
        const next = applyActualsToModel(BASE_MODEL, parsed);
        setModel(next);
        try { localStorage.setItem(LS_ACTUALS, JSON.stringify(parsed)); } catch {}
        const warn = parsed.warnings.length ? ` (${parsed.warnings.length} sheet warning${parsed.warnings.length>1?"s":""})` : "";
        setUploadMsg({ ok: true, text: `Loaded actuals through ${MONTHS[parsed.cutoff-1]}${warn}. Saved — will persist on refresh.` });
      } catch (err) {
        setUploadMsg({ ok: false, text: "Failed to read file: " + err.message });
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function setOv(entity, key, value) {
    setOverrides((prev) => {
      const next = { ...prev, [entity]: { ...(prev[entity] || {}) } };
      if (value === "" || value == null || isNaN(parseFloat(value))) delete next[entity][key];
      else next[entity][key] = parseFloat(value);
      if (Object.keys(next[entity]).length === 0) delete next[entity];
      return next;
    });
  }

  const anyOverride = Object.keys(overrides).length > 0;

  return (
    <div style={S.root}>
      <style>{CSS}</style>

      <header style={S.header}>
        <div>
          <div style={S.eyebrow}>BIHBV · Group Finance · Rolling Forecast 2026</div>
          <h1 style={S.h1}>Rolling Forecast</h1>
        </div>
        <div style={S.headRight}>
          <div style={S.cutoffBox}>
            <span style={S.cutoffLabel}>Actuals through</span>
            <span style={S.cutoffVal}>{closedThru} 2026</span>
            <span style={S.cutoffSub}>{cutoff} of 12 months closed</span>
          </div>
          <button style={S.uploadBtn} onClick={() => fileRef.current?.click()}>Upload monthly file</button>
          <button style={S.exportBtn} onClick={() => exportForDashboard()}>{exportMsg || "Copy for dashboard"}</button>
          <button style={S.exportBtn} title="Clear saved actuals and overrides, revert to baseline"
            onClick={() => { if (confirm("Clear saved uploaded data and all overrides? This reverts to the built-in April baseline.")) { try { localStorage.removeItem(LS_ACTUALS); localStorage.removeItem(LS_OVERRIDES); } catch {} setModel(BASE_MODEL); setOverrides({}); setUploadMsg({ ok: true, text: "Cleared. Reverted to built-in baseline." }); } }}>Reset</button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }}
            onChange={(e) => handleFile(e.target.files?.[0])} />
        </div>
      </header>

      {uploadMsg && (
        <div style={{ ...S.uploadMsg, borderColor: uploadMsg.ok ? "var(--green)" : "var(--red)" }}>
          {uploadMsg.text}
          <button style={S.msgClose} onClick={() => setUploadMsg(null)}>×</button>
        </div>
      )}

      {/* consolidated banner */}
      <ConsolBanner fc={fc} expanded={expanded === "Consolidated"} onToggle={() => setExpanded(expanded === "Consolidated" ? null : "Consolidated")} cutoff={cutoff} />

      <div style={S.sectionLabel}>
        <span>Entities</span>
        <span style={S.sectionSub}>full-year reforecast vs budget · click to expand</span>
      </div>

      <div style={S.cardGrid}>
        {entityRows.map((e) => (
          <EntityCard key={e.entity} e={e}
            expanded={expanded === e.entity}
            onToggle={() => setExpanded(expanded === e.entity ? null : e.entity)}
            overrides={overrides[e.entity] || {}}
            setOv={(k, v) => setOv(e.entity, k, v)}
            cutoff={cutoff} />
        ))}
      </div>

      {anyOverride && (
        <div style={S.ovFootnote}>
          Management overrides active on: {Object.keys(overrides).join(", ")}. These adjust the forecast (open months only); actuals are never changed.
        </div>
      )}

      <footer style={S.footer}>
        Seasonality from 2024–2025 monthly actuals. Income & portfolio seasonally forecast; OpEx held at budget through June, run-rate from July; provisions scale with PAR&gt;30; tax at entity effective rate. Consolidated is the bottom-up sum of all entities plus eliminations.
      </footer>
    </div>
  );
}

// ---------- consolidated banner ----------
function ConsolBanner({ fc, expanded, onToggle, cutoff }) {
  const c = fc.consol;
  const npFc = fc.consolNP, npBud = fc.consolBudNP;
  const items = [
    { label: "Total income", fc: c.TotInc.fy, bud: c.TotInc.budFy },
    { label: "Borrowers", fc: c.Borrower.fy, bud: c.Borrower.budFy, count: true },
    { label: "Portfolio", fc: c.GLP.fy, bud: c.GLP.budFy },
    { label: "Net profit", fc: npFc, bud: npBud, np: true },
  ];
  return (
    <div style={S.consolWrap}>
      <div style={S.consolHead} onClick={onToggle}>
        <div style={S.consolTitle}>
          <span style={S.consolDot} />
          Consolidated BIHBV
          <span style={S.consolExpand}>{expanded ? "− collapse months" : "+ monthly detail"}</span>
        </div>
      </div>
      <div style={S.consolMetrics}>
        {items.map((it) => {
          const p = pct(it.fc, it.bud);
          const neg = it.np && it.fc < 0;
          const col = it.np ? (neg ? "var(--red)" : "var(--ink)") : "var(--ink)";
          const dcol = Math.abs(p) < 0.05 ? "var(--ink-dim)" : p >= 0 ? "var(--green)" : "var(--red)";
          return (
            <div key={it.label} style={S.consolMetric}>
              <div style={S.cmLabel}>{it.label}</div>
              <div style={{ ...S.cmVal, color: col }}>{fmt0(it.fc)}{!it.count && <span style={S.cmUnit}> k</span>}</div>
              <div style={S.cmBud}>budget {fmt0(it.bud)}</div>
              <div style={{ ...S.cmDelta, color: dcol }}>{pctStr(it.fc, it.bud)}</div>
            </div>
          );
        })}
      </div>
      {expanded && <ConsolMonthly fc={fc} cutoff={cutoff} />}
    </div>
  );
}

function ConsolMonthly({ fc, cutoff }) {
  // build consolidated monthly by summing entity monthly for income, opex, GLP
  const sumMonthly = (metric) => {
    const out = new Array(12).fill(0);
    for (const ent of [...fc.entities, fc.elim]) {
      const m = ent.metrics[metric];
      if (m) for (let i = 0; i < 12; i++) out[i] += m.monthly[i];
    }
    return out;
  };
  const sumBudMonthly = (metric) => {
    const out = new Array(12).fill(0);
    for (const ent of [...fc.entities, fc.elim]) {
      const m = ent.metrics[metric];
      if (m && m.budMonthly) for (let i = 0; i < 12; i++) out[i] += m.budMonthly[i];
    }
    return out;
  };
  const [metric, setMetric] = useState("TotInc");
  const METS = [{ k: "TotInc", l: "Income" }, { k: "TotOpEx", l: "OpEx" }, { k: "GLP", l: "Portfolio" }];
  const monthly = sumMonthly(metric);
  const budM = sumBudMonthly(metric);
  const data = MONTHS.map((mn, i) => ({ month: mn, actual: i < cutoff ? monthly[i] : null, forecast: i >= cutoff ? monthly[i] : null, budget: budM[i] }));
  return (
    <div style={S.monthlyBox}>
      <div style={S.metricTabs}>
        {METS.map((m) => (
          <button key={m.k} onClick={() => setMetric(m.k)} style={{ ...S.mtab, ...(metric === m.k ? S.mtabOn : {}) }}>{m.l}</button>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={210}>
        <ComposedChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: 4 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="month" stroke="var(--ink-dim)" tick={{ fontSize: 10, fontFamily: "var(--mono)" }} />
          <YAxis stroke="var(--ink-dim)" tick={{ fontSize: 9, fontFamily: "var(--mono)" }} width={42}
            tickFormatter={(v) => Math.abs(v) >= 1000 ? (v/1000).toFixed(0)+"k" : v.toFixed(0)} />
          <Tooltip content={<MTip />} />
          <Bar dataKey="actual" name="actual" fill="var(--ink-dim)" radius={[2,2,0,0]} maxBarSize={26} />
          <Bar dataKey="forecast" name="forecast" fill="var(--amber)" radius={[2,2,0,0]} maxBarSize={26} fillOpacity={0.85} />
          <Line dataKey="budget" name="budget" stroke="var(--ghost)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <div style={S.mLegend}><span style={{color:"var(--ink-dim)"}}>▬ actual</span><span style={{color:"var(--amber)"}}>▬ forecast</span><span style={{color:"var(--ghost)"}}>┄ budget</span></div>
    </div>
  );
}

// ---------- entity card ----------
function EntityCard({ e, expanded, onToggle, overrides, setOv, cutoff }) {
  const conf = CONF[e.confidence] || CONF.high;
  const np = e.derivedNP, npBud = e.budNP;
  const npNeg = np < 0;
  return (
    <div style={{ ...S.card, ...(expanded ? S.cardExpanded : {}) }}>
      <div style={S.cardTop} onClick={onToggle}>
        <div style={S.cardName}>
          {e.entity}
          {e.hasOverride && <span style={S.ovBadge}>adj</span>}
        </div>
        <div style={S.confTag} title={`Forecast confidence: ${conf.label}`}>
          <span style={{ ...S.confDot, background: conf.color }} />
          <span style={{ color: conf.color }}>{conf.label}</span>
        </div>
      </div>

      <div style={S.cardNP}>
        <div style={S.cardNPLabel}>Net profit (reforecast)</div>
        <div style={{ ...S.cardNPVal, color: npNeg ? "var(--red)" : "var(--ink)" }}>{fmt0(np)}<span style={S.cardNPUnit}> k</span></div>
        <div style={S.cardNPBud}>budget {fmt0(npBud)} · <span style={{ color: pct(np,npBud)>=0?"var(--green)":"var(--red)" }}>{pctStr(np, npBud)}</span></div>
        {e.oneOff ? <div style={S.cardOneOff}>incl. one-off tax −{fmt0(e.oneOff)}k</div> : null}
      </div>

      <div style={S.cardMetrics}>
        {HEAD.map((h) => {
          const m = e.metrics[h.key];
          if (!m) return null;
          return (
            <div key={h.key} style={S.cardMetric}>
              <span style={S.cmiLabel}>{h.label}</span>
              <span style={S.cmiVal}>{fmt0(m.fy)}{!h.count && <span style={S.cmiUnit}>k</span>}</span>
              <span style={{ ...S.cmiDelta, color: pct(m.fy,m.budFy)>=0?"var(--green)":"var(--red)" }}>{pctStr(m.fy, m.budFy)}</span>
            </div>
          );
        })}
      </div>

      {e.ytdVariancePct != null && Math.abs(e.ytdVariancePct) > 1 && (
        <div style={S.ytdNote}>
          Running <b style={{ color: e.ytdVariancePct>=0?"var(--green)":"var(--red)" }}>{e.ytdVariancePct>=0?"+":""}{e.ytdVariancePct.toFixed(0)}%</b> vs budget YTD (income)
          {e.confidence === "low" && <span style={S.lowWarn}> · back-loaded entity, forecast firms up in H2</span>}
        </div>
      )}

      <button style={S.expandBtn} onClick={onToggle}>{expanded ? "− Hide detail" : "+ Monthly detail & adjust"}</button>

      {expanded && <EntityDetail e={e} overrides={overrides} setOv={setOv} cutoff={cutoff} />}
    </div>
  );
}

// ---------- entity expanded detail ----------
function EntityDetail({ e, overrides, setOv, cutoff }) {
  const [tab, setTab] = useState("income");
  return (
    <div style={S.detail}>
      <div style={S.detailTabs}>
        <button style={{ ...S.dtab, ...(tab==="income"?S.dtabOn:{}) }} onClick={() => setTab("income")}>Income &amp; profit</button>
        <button style={{ ...S.dtab, ...(tab==="bridge"?S.dtabOn:{}) }} onClick={() => setTab("bridge")}>P&amp;L bridge</button>
        <button style={{ ...S.dtab, ...(tab==="opex"?S.dtabOn:{}) }} onClick={() => setTab("opex")}>OpEx breakdown</button>
        <button style={{ ...S.dtab, ...(tab==="adjust"?S.dtabOn:{}) }} onClick={() => setTab("adjust")}>Adjust ⚙</button>
      </div>

      {tab === "income" && <MonthlyMetric e={e} metricKey="TotInc" label="Total income" cutoff={cutoff} />}
      {tab === "bridge" && <PLBridge e={e} />}
      {tab === "opex" && <OpexBreakdown e={e} cutoff={cutoff} />}
      {tab === "adjust" && <OverridePanel e={e} overrides={overrides} setOv={setOv} />}
    </div>
  );
}

function PLBridge({ e }) {
  const inc = e.metrics.TotInc;
  const opex = e.metrics.TotOpEx;
  const rows = [
    { label: "Total income", fc: inc.fy, bud: inc.budFy, kind: "pos" },
    { label: "Operating expense", fc: opex.fy, bud: opex.budFy, kind: "neg" },
    { label: "Financial expense", fc: e.fcFinExp, bud: e.budFinExp, kind: "neg" },
    { label: "ECL (loan loss)", fc: e.fcECL, bud: e.budECL, kind: "neg", ecl: true },
    { label: "Profit before tax", fc: e.fcPBT, bud: (e.budNP != null && e.fcTax != null) ? null : null, kind: "sub" },
    { label: "Tax" + (e.oneOff ? " (incl. one-off " + fmt0(e.oneOff) + "k)" : ""), fc: e.fcTax, bud: null, kind: "neg" },
    { label: "Net profit", fc: e.derivedNP, bud: e.budNP, kind: "total" },
  ];
  return (
    <div style={S.mmBox}>
      <div style={S.mmTitle}>Profit &amp; loss bridge — full year (USD'000)</div>
      <div style={S.bridgeTable}>
        {rows.map((r, i) => {
          const isTotal = r.kind === "total", isSub = r.kind === "sub";
          const sign = (r.kind === "neg") ? "−" : "";
          const dv = (r.bud != null && Math.abs(r.bud) > 0.01) ? pct(r.fc, r.bud) : null;
          const dvCol = dv == null ? "var(--ink-faint)" : (r.kind === "neg" ? (dv > 0 ? "var(--red)" : "var(--green)") : (dv >= 0 ? "var(--green)" : "var(--red)"));
          return (
            <div key={i} style={{ ...S.bridgeRow, ...(isTotal ? S.bridgeTotal : {}), ...(isSub ? S.bridgeSub : {}) }}>
              <span style={S.bridgeLabel}>{r.label}</span>
              <span style={{ ...S.bridgeFc, color: (isTotal && r.fc < 0) ? "var(--red)" : "var(--ink)" }}>{sign}{fmt0(Math.abs(r.fc))}</span>
              <span style={S.bridgeBud}>{r.bud != null ? (sign + fmt0(Math.abs(r.bud))) : ""}</span>
              <span style={{ ...S.bridgeDelta, color: dvCol }}>{dv == null ? "" : (dv >= 0 ? "+" : "") + dv.toFixed(0) + "%"}</span>
            </div>
          );
        })}
      </div>
      <div style={S.bridgeHdr}>
        <span style={S.bridgeLabel}></span><span style={S.bridgeFc}>forecast</span><span style={S.bridgeBud}>budget</span><span style={S.bridgeDelta}>vs bud</span>
      </div>
      {e.parScale && e.parScale !== 1 && (
        <div style={S.bridgeNote}>ECL reflects PAR&gt;30 running at {(e.parScale).toFixed(2)}× budget — the charge is scaled up accordingly. Adjust it directly in the Adjust tab if coverage differs.</div>
      )}
      <div style={S.bridgeNote}>Financial expense is the full charge (borrowings, savings, loan security fund, other), not borrowing interest alone.</div>
    </div>
  );
}

function MonthlyMetric({ e, metricKey, label, cutoff }) {
  const m = e.metrics[metricKey];
  const data = MONTHS.map((mn, i) => ({
    month: mn,
    actual: i < cutoff ? m.monthly[i] : null,
    forecast: i >= cutoff ? m.monthly[i] : null,
    budget: m.budMonthly ? m.budMonthly[i] : null,
  }));
  const ov = e.overrideDetail && e.overrideDetail[metricKey];
  return (
    <div style={S.mmBox}>
      <div style={S.mmTitle}>{label} — monthly (USD'000)</div>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 2 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="month" stroke="var(--ink-dim)" tick={{ fontSize: 9, fontFamily: "var(--mono)" }} />
          <YAxis stroke="var(--ink-dim)" tick={{ fontSize: 9, fontFamily: "var(--mono)" }} width={40}
            tickFormatter={(v) => Math.abs(v)>=1000?(v/1000).toFixed(0)+"k":v.toFixed(0)} />
          <Tooltip content={<MTip />} />
          <Bar dataKey="actual" name="actual" fill="var(--ink-dim)" radius={[2,2,0,0]} maxBarSize={22} />
          <Bar dataKey="forecast" name="forecast" fill="var(--amber)" radius={[2,2,0,0]} maxBarSize={22} fillOpacity={0.85} />
          <Line dataKey="budget" name="budget" stroke="var(--ghost)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <div style={S.mLegend}>
        <span style={{color:"var(--ink-dim)"}}>▬ actual ({cutoff}mo)</span>
        <span style={{color:"var(--amber)"}}>▬ forecast</span>
        <span style={{color:"var(--ghost)"}}>┄ budget</span>
        {ov && <span style={{color:"var(--amber)"}}>· adjusted {fmtSign(ov.amount)}</span>}
      </div>
      <div style={S.mmFy}>Full year: <b>{fmt0(m.fy)}</b> &nbsp;vs budget {fmt0(m.budFy)} ({pctStr(m.fy, m.budFy)})</div>
    </div>
  );
}

function OpexBreakdown({ e, cutoff }) {
  const comps = [
    { k: "Salary", l: "Salary & benefits", c: "var(--amber)" },
    { k: "Travel", l: "Travel & transport", c: "var(--blue)" },
    { k: "OtherOpEx", l: "Other OpEx", c: "var(--ink-dim)" },
  ];
  const data = MONTHS.map((mn, i) => {
    const row = { month: mn };
    for (const c of comps) row[c.k] = e.metrics[c.k] ? e.metrics[c.k].monthly[i] : 0;
    return row;
  });
  const tot = e.metrics.TotOpEx;
  return (
    <div style={S.mmBox}>
      <div style={S.mmTitle}>Operating cost composition — monthly (USD'000)</div>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 2 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="month" stroke="var(--ink-dim)" tick={{ fontSize: 9, fontFamily: "var(--mono)" }} />
          <YAxis stroke="var(--ink-dim)" tick={{ fontSize: 9, fontFamily: "var(--mono)" }} width={40}
            tickFormatter={(v) => Math.abs(v)>=1000?(v/1000).toFixed(0)+"k":v.toFixed(0)} />
          <Tooltip content={<MTip />} />
          {comps.map((c) => <Bar key={c.k} dataKey={c.k} stackId="opex" fill={c.c} maxBarSize={22} />)}
          <ReferenceLine x={MONTHS[cutoff-1]} stroke="var(--ink-faint)" strokeDasharray="3 3" />
        </ComposedChart>
      </ResponsiveContainer>
      <div style={S.compRows}>
        {comps.map((c) => {
          const m = e.metrics[c.k];
          if (!m) return null;
          const share = tot.fy ? (m.fy / tot.fy * 100) : 0;
          return (
            <div key={c.k} style={S.compRow}>
              <span style={S.compSwatch(c.c)} />
              <span style={S.compName}>{c.l}</span>
              <span style={S.compFy}>{fmt0(m.fy)}k</span>
              <span style={S.compShare}>{share.toFixed(0)}%</span>
              <span style={{ ...S.compDelta, color: pct(m.fy,m.budFy)>=0?"var(--red)":"var(--green)" }}>{pctStr(m.fy, m.budFy)}</span>
            </div>
          );
        })}
        <div style={{ ...S.compRow, borderTop: "1px solid var(--line)", paddingTop: 6, marginTop: 2 }}>
          <span style={S.compSwatch("transparent")} />
          <span style={{ ...S.compName, fontWeight: 600 }}>Total OpEx</span>
          <span style={{ ...S.compFy, fontWeight: 600 }}>{fmt0(tot.fy)}k</span>
          <span style={S.compShare}></span>
          <span style={{ ...S.compDelta, color: pct(tot.fy,tot.budFy)>=0?"var(--red)":"var(--green)" }}>{pctStr(tot.fy, tot.budFy)}</span>
        </div>
      </div>
      <div style={S.opexNote}>OpEx holds at budget through June; the run-rate raises or lowers it only from July ({cutoff < 7 ? "currently budget-held" : "run-rate active"}).</div>
    </div>
  );
}

function OverridePanel({ e, overrides, setOv }) {
  const baseOneOff = e.baseOneOff || 0;
  const showOneOff = baseOneOff !== 0 || (typeof overrides.oneOff === "number");
  return (
    <div style={S.ovPanel}>
      <div style={S.ovIntro}>
        Enter a full-year adjustment per line (USD'000, +/−). The tool spreads it across the remaining forecast months and re-derives tax, provisions and net profit. Actuals are never changed.
      </div>
      {OV_LINES.map((l) => (
        <div key={l.key} style={S.ovRow}>
          <div style={S.ovLabel}>
            {l.label}
            <span style={S.ovHint}>{l.hint}</span>
          </div>
          <input type="number" placeholder={l.abs ? "set" : "± amount"} value={overrides[l.key] ?? ""}
            onChange={(ev) => setOv(l.key, ev.target.value)} style={S.ovInput} />
        </div>
      ))}
      {showOneOff && (
        <div style={{ ...S.ovRow, paddingTop: 8, borderTop: "1px solid var(--grid)" }}>
          <div style={S.ovLabel}>
            One-off tax adjustment
            <span style={S.ovHint}>additional tax charge (e.g. Tanzania 2,500); reduces net profit</span>
          </div>
          <input type="number" placeholder={String(baseOneOff)} value={overrides.oneOff ?? ""}
            onChange={(ev) => setOv("oneOff", ev.target.value)} style={S.ovInput} />
        </div>
      )}
      <div style={S.ovResult}>
        {showOneOff && (
          <div style={S.ovOneOffNote}>
            One-off tax in this forecast: <b>{fmt0(e.oneOff)}k</b>{(overrides.oneOff == null && baseOneOff !== 0) && <span style={{ color: "var(--ink-faint)" }}> (model default; type in the field above to change)</span>}
          </div>
        )}
        Reforecast net profit: <b style={{ color: e.derivedNP<0?"var(--red)":"var(--ink)" }}>{fmt0(e.derivedNP)}k</b>
        {e.hasOverride && <span style={S.ovActive}> · override applied</span>}
      </div>
    </div>
  );
}

function MTip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const rows = payload.filter(p => p.value != null);
  if (!rows.length) return null;
  return (
    <div style={S.tip}>
      <div style={S.tipM}>{label}</div>
      {rows.map((r, i) => (
        <div key={i} style={S.tipRow}><span style={{ color: r.color || r.fill }}>{r.name}</span><b>{fmt0(r.value)}</b></div>
      ))}
    </div>
  );
}

// ---------------- styles ----------------
const S = {
  root: { fontFamily: "var(--body)", background: "var(--bg)", color: "var(--ink)", minHeight: "100%", paddingBottom: 40 },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", padding: "22px 28px 18px", borderBottom: "1px solid var(--line)" },
  eyebrow: { fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--ink-dim)", marginBottom: 6 },
  h1: { fontFamily: "var(--display)", fontSize: 28, fontWeight: 600, margin: 0, letterSpacing: "-0.01em" },
  headRight: { display: "flex", alignItems: "center", gap: 14 },
  cutoffBox: { display: "flex", flexDirection: "column", alignItems: "flex-end" },
  cutoffLabel: { fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-dim)" },
  cutoffVal: { fontFamily: "var(--mono)", fontSize: 15, fontWeight: 600, color: "var(--amber)" },
  cutoffSub: { fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-faint)" },
  uploadBtn: { background: "var(--amber-dim)", border: "1px solid var(--amber)", color: "var(--amber)", fontFamily: "var(--mono)", fontSize: 11, padding: "9px 14px", borderRadius: 3, cursor: "pointer", letterSpacing: "0.03em" },
  exportBtn: { background: "none", border: "1px solid var(--line)", color: "var(--ink-dim)", fontFamily: "var(--mono)", fontSize: 11, padding: "9px 14px", borderRadius: 3, cursor: "pointer", letterSpacing: "0.03em" },
  uploadMsg: { margin: "12px 28px 0", padding: "9px 14px", border: "1px solid", borderLeftWidth: 2, borderRadius: 3, background: "var(--panel)", fontFamily: "var(--mono)", fontSize: 12, display: "flex", justifyContent: "space-between", alignItems: "center" },
  msgClose: { background: "none", border: "none", color: "var(--ink-dim)", cursor: "pointer", fontSize: 16 },

  consolWrap: { margin: "18px 28px 0", background: "var(--panel)", border: "1px solid var(--line)", borderLeft: "2px solid var(--amber)", borderRadius: 4 },
  consolHead: { padding: "14px 18px 0", cursor: "pointer" },
  consolTitle: { fontFamily: "var(--display)", fontSize: 18, fontWeight: 600, display: "flex", alignItems: "center", gap: 9 },
  consolDot: { width: 8, height: 8, borderRadius: "50%", background: "var(--amber)" },
  consolExpand: { marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-dim)", fontWeight: 400 },
  consolMetrics: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 1, padding: "14px 18px 16px" },
  consolMetric: { padding: "0 12px", borderLeft: "1px solid var(--grid)" },
  cmLabel: { fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-dim)", marginBottom: 6 },
  cmVal: { fontFamily: "var(--mono)", fontSize: 24, fontWeight: 600, letterSpacing: "-0.01em" },
  cmUnit: { fontSize: 13, color: "var(--ink-dim)" },
  cmBud: { fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-faint)", marginTop: 3 },
  cmDelta: { fontFamily: "var(--mono)", fontSize: 12, fontWeight: 600, marginTop: 4 },

  sectionLabel: { display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "26px 28px 12px", fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--ink-dim)" },
  sectionSub: { fontSize: 9.5, letterSpacing: "0.04em", textTransform: "none", color: "var(--ink-faint)" },
  cardGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14, padding: "0 28px" },

  card: { background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 4, padding: "14px 16px", display: "flex", flexDirection: "column" },
  cardExpanded: { gridColumn: "1 / -1" },
  cardTop: { display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", marginBottom: 12 },
  cardName: { fontFamily: "var(--display)", fontSize: 16, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 },
  ovBadge: { fontFamily: "var(--mono)", fontSize: 8.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--amber)", border: "1px solid var(--amber)", borderRadius: 2, padding: "1px 4px" },
  confTag: { display: "flex", alignItems: "center", gap: 5, fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase" },
  confDot: { width: 7, height: 7, borderRadius: "50%" },

  cardNP: { marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid var(--grid)" },
  cardNPLabel: { fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-dim)", marginBottom: 4 },
  cardNPVal: { fontFamily: "var(--mono)", fontSize: 26, fontWeight: 600, letterSpacing: "-0.01em" },
  cardNPUnit: { fontSize: 13, color: "var(--ink-dim)" },
  cardNPBud: { fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-faint)", marginTop: 3 },
  cardOneOff: { fontFamily: "var(--mono)", fontSize: 10, color: "var(--amber)", marginTop: 3 },

  cardMetrics: { display: "flex", flexDirection: "column", gap: 7 },
  cardMetric: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
  cmiLabel: { fontSize: 11.5, color: "var(--ink-dim)" },
  cmiVal: { fontFamily: "var(--mono)", fontSize: 13, fontWeight: 600, marginLeft: "auto" },
  cmiUnit: { fontSize: 10, color: "var(--ink-dim)" },
  cmiDelta: { fontFamily: "var(--mono)", fontSize: 11, fontWeight: 600, minWidth: 58, textAlign: "right" },

  ytdNote: { marginTop: 11, fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-dim)", lineHeight: 1.5 },
  lowWarn: { color: "var(--red)" },

  expandBtn: { marginTop: 12, background: "none", border: "1px solid var(--line)", color: "var(--ink-dim)", fontFamily: "var(--mono)", fontSize: 10.5, padding: "7px", borderRadius: 3, cursor: "pointer", letterSpacing: "0.04em" },

  detail: { marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--grid)" },
  detailTabs: { display: "flex", gap: 6, marginBottom: 14 },
  dtab: { background: "var(--bg)", border: "1px solid var(--line)", color: "var(--ink-dim)", fontFamily: "var(--body)", fontSize: 12, padding: "7px 13px", borderRadius: 3, cursor: "pointer" },
  dtabOn: { background: "var(--amber-dim)", borderColor: "var(--amber)", color: "var(--amber)" },

  mmBox: {},
  bridgeTable: { display: "flex", flexDirection: "column", gap: 0, marginTop: 4 },
  bridgeHdr: { display: "flex", alignItems: "center", padding: "4px 0 0", fontFamily: "var(--mono)", fontSize: 8.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-faint)", borderTop: "1px solid var(--grid)", marginTop: 2 },
  bridgeRow: { display: "flex", alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--grid)", fontFamily: "var(--mono)", fontSize: 12 },
  bridgeSub: { borderBottom: "1px solid var(--line)", color: "var(--ink-dim)" },
  bridgeTotal: { borderBottom: "none", borderTop: "1.5px solid var(--amber)", marginTop: 2, paddingTop: 9, fontWeight: 600, fontSize: 13.5 },
  bridgeLabel: { flex: 1, color: "var(--ink)" },
  bridgeFc: { width: 78, textAlign: "right", fontWeight: 600 },
  bridgeBud: { width: 72, textAlign: "right", color: "var(--ink-faint)", fontSize: 11 },
  bridgeDelta: { width: 56, textAlign: "right", fontWeight: 600, fontSize: 11 },
  bridgeNote: { fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginTop: 10, lineHeight: 1.5 },
  mmTitle: { fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-dim)", marginBottom: 10 },
  mmFy: { fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-dim)", marginTop: 8 },
  mLegend: { display: "flex", gap: 16, fontFamily: "var(--mono)", fontSize: 10, marginTop: 6, paddingLeft: 4 },

  compRows: { marginTop: 14, display: "flex", flexDirection: "column", gap: 7 },
  compRow: { display: "flex", alignItems: "center", gap: 10, fontFamily: "var(--mono)", fontSize: 12 },
  compSwatch: (c) => ({ width: 10, height: 10, borderRadius: 2, background: c, flexShrink: 0 }),
  compName: { color: "var(--ink)", minWidth: 130 },
  compFy: { marginLeft: "auto", fontWeight: 600 },
  compShare: { color: "var(--ink-dim)", minWidth: 40, textAlign: "right" },
  compDelta: { minWidth: 62, textAlign: "right", fontWeight: 600 },
  opexNote: { fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginTop: 12, lineHeight: 1.5 },

  ovPanel: {},
  ovIntro: { fontSize: 11.5, lineHeight: 1.5, color: "var(--ink-dim)", marginBottom: 16 },
  ovRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 },
  ovLabel: { display: "flex", flexDirection: "column" },
  ovHint: { fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-faint)", marginTop: 2 },
  ovInput: { width: 110, background: "var(--bg)", border: "1px solid var(--line)", color: "var(--ink)", fontFamily: "var(--mono)", fontSize: 13, padding: "7px 9px", borderRadius: 3, textAlign: "right" },
  ovResult: { marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)", fontFamily: "var(--mono)", fontSize: 13 },
  ovActive: { color: "var(--amber)", fontSize: 11 },
  ovOneOffNote: { fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-dim)", marginBottom: 6 },

  ovFootnote: { margin: "18px 28px 0", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--amber)", lineHeight: 1.5 },
  footer: { margin: "28px 28px 0", paddingTop: 16, borderTop: "1px solid var(--line)", fontSize: 10.5, lineHeight: 1.55, color: "var(--ink-faint)" },

  monthlyBox: { padding: "0 18px 16px" },
  metricTabs: { display: "flex", gap: 6, marginBottom: 10 },
  mtab: { background: "var(--bg)", border: "1px solid var(--line)", color: "var(--ink-dim)", fontFamily: "var(--mono)", fontSize: 11, padding: "5px 11px", borderRadius: 3, cursor: "pointer" },
  mtabOn: { background: "var(--amber-dim)", borderColor: "var(--amber)", color: "var(--amber)" },

  tip: { background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 3, padding: "7px 10px", fontFamily: "var(--mono)", fontSize: 11 },
  tipM: { fontWeight: 600, marginBottom: 4 },
  tipRow: { display: "flex", justifyContent: "space-between", gap: 14, padding: "1px 0", color: "var(--ink-dim)" },
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Spectral:wght@500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
:root{
  --bg:#13171c; --panel:#1a1f26; --line:#2a313b; --grid:#222932;
  --ink:#e8eaed; --ink-dim:#8b95a3; --ink-faint:#5a6472;
  --amber:#f0a830; --amber-dim:#2a2316; --blue:#5a9fd4; --ghost:#7e8a9c;
  --green:#5cc98a; --red:#e8705f;
  --display:'Spectral',Georgia,serif;
  --body:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --mono:'IBM Plex Mono','SF Mono',Menlo,monospace;
}
*{box-sizing:border-box;}
input[type=number]:focus,button:focus{outline:1px solid var(--amber);}
input[type=number]::-webkit-inner-spin-button{opacity:0.4;}
`;
