import * as XLSX from 'xlsx';

// Parse a dropped BIHBV monthly summary workbook and extract the 2026 actuals
// for every entity/metric the model tracks. Returns a patch object that replaces
// the `.act` arrays in the model's budget block. Budget columns are left as-is.
//
// The monthly file layout (confirmed): per entity sheet, column B holds the line
// label; actual month columns are headed "Jan 26A" ... "Dec 26A". We locate the
// header row, map month->column, then read each tracked line by its label.

const LINE_LABELS = {
  TotInc: 'total income',
  IntInc: 'interest income',
  FeeInc: 'fee income',
  NetProfit: 'net profit',
  PBT: 'profit before tax',
  Disb: 'disbursement',
  IntExpBorr: 'interest expenses on borrowings',
  TotFinExp: 'total financial expense',
  ECL: 'loan loss provision',
  Salary: 'salary and benefits',
  Travel: 'travel and transportation',
  TotOpEx: 'total operating expense',
  GLP: 'gross loan portfolio',
  Borrower: 'borrower',
};

const ENTITY_SHEETS = {
  Tanzania: 'Tanzania', Uganda: 'Uganda', Rwanda: 'Rwanda', Myanmar: 'Myanmar',
  Liberia: 'Liberia', 'Sierra Leone': 'Sierra Leone', Ghana: 'Ghana', Kenya: 'Kenya',
  BIHBV: 'BIHBV', BIFBV: 'BIFBV', 'Eliminations and adjustments': 'Eliminations and adjustments',
  Consolidated: 'Consolidated',
};

const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

function findHeaderAndMonthCols(rows) {
  // scan first ~6 rows for cells like "Jan 26A"
  for (let r = 0; r < Math.min(6, rows.length); r++) {
    const row = rows[r] || [];
    const map = {};
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (typeof v === 'string') {
        const mtch = v.toLowerCase().match(/^([a-z]{3})\s*26\s*a$/);
        if (mtch && MONTHS.includes(mtch[1])) map[MONTHS.indexOf(mtch[1])] = c;
      }
    }
    if (Object.keys(map).length >= 6) return { headerRow: r, monthCols: map };
  }
  return null;
}

export function parseMonthlyWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const result = { actuals: {}, cutoff: 0, warnings: [] };

  for (const [entity, sheetName] of Object.entries(ENTITY_SHEETS)) {
    const ws = wb.Sheets[sheetName];
    if (!ws) { result.warnings.push(`Missing sheet: ${sheetName}`); continue; }
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null });
    const hdr = findHeaderAndMonthCols(rows);
    if (!hdr) { result.warnings.push(`No 26A month columns found in ${sheetName}`); continue; }

    // build label -> rowIndex map from column A (0) or B (1), whichever holds it
    const labelRow = {};
    for (let r = 0; r < rows.length; r++) {
      const a = rows[r] && rows[r][0];
      const b = rows[r] && rows[r][1];
      if (typeof b === 'string') labelRow[b.trim().toLowerCase()] = r;
      else if (typeof a === 'string') labelRow[a.trim().toLowerCase()] = r;
    }

    const entAct = {};
    for (const [key, label] of Object.entries(LINE_LABELS)) {
      const r = labelRow[label];
      if (r == null) continue;
      const series = new Array(12).fill(0);
      for (let mi = 0; mi < 12; mi++) {
        const c = hdr.monthCols[mi];
        if (c == null) continue;
        const v = rows[r][c];
        series[mi] = (typeof v === 'number') ? v : 0;
      }
      entAct[key] = series;
    }
    result.actuals[entity] = entAct;
  }

  // cutoff = number of closed months, detected from Consolidated Total Income
  const con = result.actuals['Consolidated'];
  if (con && con.TotInc) {
    let k = 0;
    for (let i = 0; i < 12; i++) { if (con.TotInc[i] && con.TotInc[i] !== 0) k = i + 1; else break; }
    result.cutoff = k;
  }
  return result;
}

// Merge parsed actuals into a clone of the model (replace strategy).
// Also derive OtherOpEx actuals = TotOpEx - Salary - Travel.
export function applyActualsToModel(model, parsed) {
  const next = JSON.parse(JSON.stringify(model));
  for (const [entity, act] of Object.entries(parsed.actuals)) {
    const rec = next.budget[entity];
    if (!rec) continue;
    for (const [key, series] of Object.entries(act)) {
      if (rec[key]) rec[key].act = series.slice();
    }
    // derive OtherOpEx actuals if components present
    if (rec.Salary && rec.Travel && rec.OtherOpEx && rec.TotOpEx) {
      rec.OtherOpEx.act = rec.TotOpEx.act.map((t, i) =>
        (t || 0) - (rec.Salary.act[i] || 0) - (rec.Travel.act[i] || 0));
    }
  }
  return next;
}
