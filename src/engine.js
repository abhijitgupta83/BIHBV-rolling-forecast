import { MODEL } from './forecastModel.js';


// ---- core forecast engine -------------------------------------------
// Determine reporting cutoff: count closed months using a line that is
// never legitimately zero in a closed month (Consolidated Total Income).
export function detectCutoff(model = MODEL) {
  const con = model.budget['Consolidated'];
  const act = con.TotInc.act;
  let k = 0;
  for (let i = 0; i < 12; i++) {
    if (typeof act[i] === 'number' && act[i] !== 0) k = i + 1; else break;
  }
  return k; // number of closed months (e.g. 4 = through April)
}

// adaptive weight: how much to trust the seasonal-actuals forecast vs budget
// budget-heavy early, actuals-heavy late. At k=4 -> 0.33, k=8 -> 0.67, k=12 -> 1.
function seasonalWeight(k) { return Math.max(0, Math.min(1, k / 12)); }

// forecast one flow metric for one entity, returns 12-month array (actuals
// for closed months, forecast for open) plus FY total.
function forecastFlow(entity, metric, k, model = MODEL) {
  const rec = model.budget[entity] && model.budget[entity][metric];
  if (!rec) return null;
  const bud = rec.bud.map(x => (typeof x === 'number' ? x : 0));
  const act = rec.act.map(x => (typeof x === 'number' ? x : 0));
  const cls = model.classification[entity];
  const out = new Array(12);
  for (let i = 0; i < k; i++) out[i] = act[i];

  // budget reforecast (variance-carry): scale remaining budget so YTD ties to actual YTD
  const budYTD = bud.slice(0, k).reduce((a, b) => a + b, 0);
  const actYTD = act.slice(0, k).reduce((a, b) => a + b, 0);
  const vcScale = budYTD !== 0 ? actYTD / budYTD : 1;

  // seasonal forecast (only for seasonal entities with a usable index)
  let seas = null;
  const ix = (cls === 'seasonal') ? (model.seasonalIndices[entity] || {})[metric] : null;
  if (ix && ix.length === 12) {
    // anchor level L from closed months: average of act[i]/ix[i]
    const lv = [];
    for (let i = 0; i < k; i++) if (ix[i]) lv.push(act[i] / ix[i]);
    const L = lv.length ? lv.reduce((a, b) => a + b, 0) / lv.length : 0;
    seas = ix.map(v => L * v);
  }

  const w = seasonalWeight(k);
  const closedSum = act.slice(0, k).reduce((a, b) => a + b, 0);
  // OpEx rule: hold at budget through June (conservative); only let the run-rate
  // raise or lower OpEx once there are >=7 months of actuals (from July close).
  const opexHoldMonth = model.opexRunRateFromMonth || 7;
  const isOpexLine = (metric === 'TotOpEx' || metric === 'Salary' || metric === 'Travel' || metric === 'OtherOpEx');
  const isFinanceLine = (metric === 'TotFinExp' || metric === 'ECL');
  if ((isOpexLine || isFinanceLine) && k < opexHoldMonth) {
    for (let i = k; i < 12; i++) out[i] = bud[i];
    const fyO = out.reduce((a, b) => a + b, 0);
    return { monthly: out, fy: fyO, budFy: bud.reduce((a, b) => a + b, 0), budMonthly: bud.slice() };
  }
  if (cls === 'seasonal' && seas && ix) {
    // LEVEL: blend seasonal-implied FY with variance-carry FY (no cap - report
    // what the data says; uncertainty is surfaced via a confidence flag instead).
    const seasFY = ix.reduce((a, b) => a + b, 0) * (seas[0] / (ix[0] || 1));
    const vcFY = closedSum + bud.slice(k).reduce((a, b) => a + b, 0) * vcScale;
    const blendFY = w * seasFY + (1 - w) * vcFY;
    const openShape = ix.slice(k).reduce((a, b) => a + b, 0);
    const openTarget = blendFY - closedSum;
    for (let i = k; i < 12; i++) out[i] = openShape ? openTarget * (ix[i] / openShape) : bud[i] * vcScale;
  } else if (cls === 'variance') {
    for (let i = k; i < 12; i++) out[i] = bud[i] * vcScale;
  } else {
    for (let i = k; i < 12; i++) out[i] = bud[i];
  }
  const fy = out.reduce((a, b) => a + b, 0);
  const budFY = bud.reduce((a, b) => a + b, 0);
  return { monthly: out, fy, budFy: budFY, budMonthly: bud.slice() };
}

// stock metric (GLP, Borrower): point-in-time. Use latest actual as anchor,
// project remaining months along the seasonal shape's month-over-month path,
// else along budget's remaining path scaled to the latest actual.
function forecastStock(entity, metric, k, model = MODEL) {
  const rec = model.budget[entity] && model.budget[entity][metric];
  if (!rec) return null;
  const bud = rec.bud.map(x => (typeof x === 'number' ? x : 0));
  const act = rec.act.map(x => (typeof x === 'number' ? x : 0));
  const cls = model.classification[entity];
  const out = new Array(12);
  for (let i = 0; i < k; i++) out[i] = act[i];
  if (k === 0) { return { monthly: bud.slice(), fy: bud[11], budFy: bud[11] }; }
  const lastAct = act[k - 1];
  const ix = (cls === 'seasonal') ? (model.seasonalIndices[entity] || {})[metric] : null;
  const w = seasonalWeight(k);
  for (let i = k; i < 12; i++) {
    // budget path scaled so month k-1 matches last actual
    const budAnchor = bud[k - 1] !== 0 ? lastAct / bud[k - 1] : 1;
    const budProj = bud[i] * budAnchor;
    if (cls === 'seasonal' && ix && ix.length === 12 && ix[k - 1]) {
      const seasProj = lastAct * (ix[i] / ix[k - 1]);
      out[i] = w * seasProj + (1 - w) * budProj;
    } else {
      out[i] = budProj;
    }
  }
  return { monthly: out, fy: out[11], budFy: bud[11], budMonthly: bud.slice() }; // year-end value
}

// Net profit derived from components is more stable than forecasting NP directly.
// NP_forecast = TotInc_fc - TotOpEx_fc - IntExpBorr_fc - (budget's other below-the-line,
// carried as residual = budget NP - (budget TotInc - budget OpEx - budget IntExpBorr)).
// Apply a yearly override amount to a metric's monthly series, spreading across
// OPEN (forecast) months only. Closed actuals are never touched. Returns a NEW
// monthly array; also returns the original for model-vs-adjusted display.
// method: 'prorata' (proportional to existing forecast), 'even' (equal split),
// or a month index 0-11 for a point adjustment.
function applyOverrideToSeries(series, amount, k, method) {
  const orig = series.slice();
  const out = series.slice();
  if (!amount) return { monthly: out, orig };
  const openIdx = [];
  for (let i = k; i < 12; i++) openIdx.push(i);
  if (openIdx.length === 0) return { monthly: out, orig };
  if (typeof method === 'number' && method >= k && method < 12) {
    out[method] += amount;                       // point adjustment in a month
  } else if (method === 'even') {
    const per = amount / openIdx.length;
    for (const i of openIdx) out[i] += per;      // equal split
  } else {
    // prorata: proportional to existing open-month magnitudes
    const base = openIdx.reduce((a, i) => a + Math.abs(orig[i]), 0);
    if (base > 0) for (const i of openIdx) out[i] += amount * (Math.abs(orig[i]) / base);
    else { const per = amount / openIdx.length; for (const i of openIdx) out[i] += per; }
  }
  return { monthly: out, orig };
}

// default spread method per override line
const SPREAD_DEFAULT = { revenue: 'prorata', other: 'prorata', salary: 'even', travel: 'even', finexp: 'prorata', ecl: 'prorata', provision: 'point' };

function forecastEntity(entity, k, model = MODEL, overrides = {}) {
  const ov = overrides[entity] || {};
  const res = { entity, cls: model.classification[entity], metrics: {} };
  for (const m of model.flowMetrics) {
    if (m === 'TotOpEx') continue; // derived from components below
    const f = forecastFlow(entity, m, k, model);
    if (f) res.metrics[m] = f;
  }
  // OpEx components: Salary, Travel, OtherOpEx (each budget-then-run-rate)
  const comps = model.opexComponents || ['Salary', 'Travel', 'OtherOpEx'];
  let haveComps = true;
  for (const c of comps) {
    const f = forecastFlow(entity, c, k, model);
    if (f) res.metrics[c] = f; else haveComps = false;
  }
  // Total OpEx = sum of component forecasts (so the split is always consistent)
  if (haveComps) {
    const monthly = [];
    for (let i = 0; i < 12; i++) monthly[i] = comps.reduce((a, c) => a + res.metrics[c].monthly[i], 0);
    const fy = monthly.reduce((a, b) => a + b, 0);
    const budFy = comps.reduce((a, c) => a + res.metrics[c].budFy, 0);
    const budMonthly = [];
    for (let i = 0; i < 12; i++) budMonthly[i] = comps.reduce((a, c) => a + (res.metrics[c].budMonthly ? res.metrics[c].budMonthly[i] : 0), 0);
    res.metrics.TotOpEx = { monthly, fy, budFy, budMonthly };
  } else {
    const f = forecastFlow(entity, 'TotOpEx', k, model);
    if (f) res.metrics.TotOpEx = f;
  }
  for (const m of model.stockMetrics) {
    const f = forecastStock(entity, m, k, model);
    if (f) res.metrics[m] = f;
  }

  // ---- apply management overrides to MONTHLY series (open months only) ----
  // Yearly amounts entered once, spread across forecast months so the drill-down
  // stays coherent (monthly lines always sum to the adjusted full-year figure).
  res.overrideDetail = {};
  function ovApply(metricKey, amount, ovKey) {
    if (!amount || !res.metrics[metricKey]) return;
    const sp = (ov.spread && ov.spread[ovKey]) || SPREAD_DEFAULT[ovKey] || 'prorata';
    const method = sp === 'point' ? (ov.spreadMonth && typeof ov.spreadMonth[ovKey] === 'number' ? ov.spreadMonth[ovKey] : 11) : sp;
    const r = applyOverrideToSeries(res.metrics[metricKey].monthly, amount, k, method);
    res.metrics[metricKey].monthly = r.monthly;
    res.metrics[metricKey].fy = r.monthly.reduce((a, b) => a + b, 0);
    res.overrideDetail[metricKey] = { amount, orig: r.orig, method };
  }
  ovApply('TotInc', ov.revenue, 'revenue');
  ovApply('Salary', ov.salary, 'salary');
  ovApply('Travel', ov.travel, 'travel');
  ovApply('OtherOpEx', ov.other, 'other');
  // generic opex override (if used instead of component-level) hits OtherOpEx
  ovApply('OtherOpEx', ov.opex, 'other');
  // financial expense delta (pro-rata across open months)
  ovApply('TotFinExp', ov.finexp, 'finexp');
  // rebuild TotOpEx from (possibly adjusted) components
  if (res.metrics.Salary && res.metrics.Travel && res.metrics.OtherOpEx) {
    const monthly = [];
    for (let i = 0; i < 12; i++) monthly[i] = ['Salary','Travel','OtherOpEx'].reduce((a, c) => a + res.metrics[c].monthly[i], 0);
    res.metrics.TotOpEx = { monthly, fy: monthly.reduce((a,b)=>a+b,0), budFy: res.metrics.TotOpEx.budFy, budMonthly: res.metrics.TotOpEx.budMonthly };
  }

  // ---- rebuilt net profit derivation ----
  // PBT = Income - OpEx - InterestExpense - Provisions - otherResidual
  // Provisions scale with forecast portfolio at a PAR-adjusted rate.
  // Tax = effectiveRate * max(PBT,0) + one-off. Both provisions and tax now move
  // with profit, instead of being carried flat at budget.
  const ti = res.metrics.TotInc, oe = res.metrics.TotOpEx, ie = res.metrics.IntExpBorr;
  const fe = res.metrics.TotFinExp;
  const glp = res.metrics.GLP;
  const rec = model.budget[entity];
  if (ti && oe && rec) {
    const budTI = rec.TotInc.bud.reduce((a,b)=>a+(b||0),0);
    const budOE = rec.TotOpEx.bud.reduce((a,b)=>a+(b||0),0);
    const budFE = rec.TotFinExp ? rec.TotFinExp.bud.reduce((a,b)=>a+(b||0),0)
                : (ie ? rec.IntExpBorr.bud.reduce((a,b)=>a+(b||0),0) : 0);
    const budNP = rec.NetProfit ? rec.NetProfit.bud.reduce((a,b)=>a+(b||0),0) : 0;
    const budPBT = rec.PBT ? rec.PBT.bud.reduce((a,b)=>a+(b||0),0) : 0;

    const provRate = (model.provRate && model.provRate[entity]) || 0;
    const parBud = model.parBudget && model.parBudget[entity];
    const parAct = model.parActual && model.parActual[entity];
    let parScale = 1;
    if (parBud && parAct && parBud > 0) parScale = parAct / parBud;
    const ovrEcl = (typeof ov.provision === 'number') ? ov.provision
                 : (model.eclOverride && model.eclOverride[entity]);
    const budEndGLP = rec.GLP ? rec.GLP.bud[11] : 0;
    const fcGLP = glp ? glp.fy : budEndGLP;
    // Budget ECL from the actual Loan Loss Provision line where available
    const budECL = rec.ECL ? rec.ECL.bud.reduce((a,b)=>a+(b||0),0) : (provRate * budEndGLP);
    // PAR-driven ECL, plus an optional management delta (ov.ecl, +/-)
    let fcECL = (typeof ovrEcl === 'number') ? ovrEcl : provRate * fcGLP * parScale;
    if (typeof ov.ecl === 'number') fcECL += ov.ecl;

    // Financial expense: forecast series already includes any finexp delta
    const fcFE = fe ? fe.fy : (ie ? ie.fy : budFE);

    // other below-the-line residual that is NOT financial expense, ECL or tax
    const otherBudget = budPBT - (budTI - budOE - budFE - budECL);

    // ti.fy and oe.fy already include any revenue/opex overrides.
    let pbt = ti.fy - oe.fy - fcFE - fcECL + otherBudget;
    if (typeof ov.pbt === 'number') pbt = ov.pbt; // direct PBT override

    const taxRate = (model.taxRate && model.taxRate[entity]) || 0;
    const baseOneOff = (model.oneOffTax && model.oneOffTax[entity]) || 0;
    const oneOff = (typeof ov.oneOff === 'number') ? ov.oneOff : baseOneOff;
    const tax = taxRate * Math.max(pbt, 0) + oneOff;

    let np = pbt - tax;
    if (typeof ov.np === 'number') np = ov.np; // direct NP override (last resort)

    res.derivedNP = np;
    res.budNP = budNP;
    res.fcPBT = pbt;
    res.fcProv = fcECL;       // kept for backward compatibility
    res.fcECL = fcECL;
    res.budECL = budECL;
    res.fcFinExp = fcFE;
    res.budFinExp = budFE;
    res.budProv = budECL;
    res.parScale = parScale;
    res.fcTax = tax;
    res.oneOff = oneOff;
    res.baseOneOff = baseOneOff;
    res.hasOverride = !!(ov.revenue || ov.opex || ov.salary || ov.travel || ov.other || typeof ov.finexp==='number' || typeof ov.provision==='number' || typeof ov.ecl==='number' || typeof ov.pbt==='number' || typeof ov.np==='number' || (typeof ov.oneOff==='number' && ov.oneOff!==baseOneOff));

    // Keep the displayed ECL metric line consistent with the PAR-driven ECL used
    // in the P&L bridge: scale its forecast (open) months so the FY equals fcECL.
    if (res.metrics.ECL) {
      const eclM = res.metrics.ECL;
      const closed = eclM.monthly.slice(0, k).reduce((a,b)=>a+(b||0),0);
      const openFY = fcECL - closed;
      const openBudSum = eclM.budMonthly ? eclM.budMonthly.slice(k).reduce((a,b)=>a+(b||0),0) : 0;
      for (let i = k; i < 12; i++) {
        eclM.monthly[i] = openBudSum ? openFY * ((eclM.budMonthly[i]||0) / openBudSum) : openFY / Math.max(1, 12 - k);
      }
      eclM.fy = eclM.monthly.reduce((a,b)=>a+b,0);
    }
  }
  // confidence: low when entity is back-loaded/volatile AND few months are in.
  // dispersion from model; reliability rises with k. Score 0..1 (1 = high conf).
  const disp = (model.dispersion && model.dispersion[entity]) || 0;
  const thr = model.backloadedThreshold || 0.25;
  let conf = 'high';
  if (disp > thr) {
    // back-loaded entity: low confidence until ~H2
    conf = k >= 8 ? 'medium' : 'low';
  } else if (k < 4) {
    conf = 'medium';
  }
  // also flag if YTD actual diverges sharply from YTD budget (big early swing)
  const rec2 = model.budget[entity];
  if (rec2 && rec2.TotInc) {
    const a = rec2.TotInc.act.slice(0, k).reduce((s,v)=>s+(v||0),0);
    const b = rec2.TotInc.bud.slice(0, k).reduce((s,v)=>s+(v||0),0);
    const ytdVar = b ? Math.abs(a - b) / b : 0;
    res.ytdVariancePct = b ? (a - b) / b * 100 : 0;
    if (ytdVar > 0.15 && k < 8 && conf === 'high') conf = 'medium';
    if (ytdVar > 0.15 && k < 8 && conf === 'medium' && disp > thr) conf = 'low';
  }
  res.confidence = conf;
  res.dispersion = disp;
  return res;
}

export function runForecast(k = null, model = MODEL, overrides = {}) {
  const cutoff = k == null ? detectCutoff(model) : k;
  const entities = model.entities.map(e => forecastEntity(e, cutoff, model, overrides));
  const elim = forecastEntity(model.elimKey, cutoff, model, overrides);
  // bottom-up consolidation: sum all entities + eliminations
  const consol = {};
  const allMetrics = [...model.flowMetrics, ...model.stockMetrics];
  for (const m of allMetrics) {
    let fy = 0, budFy = 0;
    for (const ent of [...entities, elim]) {
      if (ent.metrics[m]) { fy += ent.metrics[m].fy; budFy += ent.metrics[m].budFy; }
    }
    consol[m] = { fy, budFy };
  }
  let npFy = 0, npBud = 0;
  for (const ent of [...entities, elim]) {
    if (typeof ent.derivedNP === 'number') { npFy += ent.derivedNP; npBud += ent.budNP; }
  }
  return { cutoff, entities, elim, consol, consolNP: npFy, consolBudNP: npBud };
}

