// ============================================================
// Node: "Expandir Recorrentes" — Code v2 (CORRIGIDO v2)
// Flow: busca-total-evento
// ============================================================
// CORREÇÕES:
// 1. $items('Edit Fields2') → $('Edit Fields2').all()[0].json
//    ($items é sintaxe Code v1, o node usa v2)
// 2. SEM filtro por x.id — deixa itens vazios {} passarem
//    (eles vêm do alwaysOutputData e mantêm o workflow vivo)
// 3. Safety net: se resultado final for vazio, retorna [{json:{}}]
//    pra nunca travar o workflow
// ============================================================

const allItems = $input.all()
  .map(i => i.json)
  .filter(x => x && typeof x === 'object');

// Pega critérios — sintaxe Code v2
let criterio = {};
try {
  const items = $('Edit Fields2').all();
  criterio = (items[0] || {}).json || {};
} catch (e) {
  criterio = {};
}

const startRaw = criterio.start_event || '';
const endRaw   = criterio.end_event || '';

function parseDate(raw) {
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(' ', 'T');
  s = s.replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

const rangeStart = parseDate(startRaw);
const rangeEnd   = parseDate(endRaw);

const isTrue = (v) => v === true || v === 'true' || v === 1 || v === '1';
const normais = allItems.filter(e => !isTrue(e.is_recurring));
const recorrentes = allItems.filter(e => isTrue(e.is_recurring) && e.rrule);

// se não tem range, devolve tudo sem expandir
if (!rangeStart || !rangeEnd) {
  const result = [...normais, ...recorrentes].map(e => ({ json: e }));
  return result.length > 0 ? result : [{ json: {} }];
}

// --- helpers de offset ISO ---
function getOffsetMinutesFromIso(iso) {
  const s = String(iso || '');
  const m = s.match(/([+-])(\d{2}):?(\d{2})$/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

function shiftToLocal(dUtc, offMin) {
  return new Date(dUtc.getTime() + offMin * 60000);
}
function unshiftFromLocal(dLocalShift, offMin) {
  return new Date(dLocalShift.getTime() - offMin * 60000);
}

function ymdLocal(dLocalShift) {
  return `${dLocalShift.getUTCFullYear()}-${String(dLocalShift.getUTCMonth()+1).padStart(2,'0')}-${String(dLocalShift.getUTCDate()).padStart(2,'0')}`;
}

function toIsoWithOffset(dUtc, offMin) {
  const d = shiftToLocal(dUtc, offMin);
  const sign = offMin < 0 ? '-' : '+';
  const abs = Math.abs(offMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');

  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth()+1).padStart(2,'0');
  const D = String(d.getUTCDate()).padStart(2,'0');
  const h = String(d.getUTCHours()).padStart(2,'0');
  const m = String(d.getUTCMinutes()).padStart(2,'0');
  const s = String(d.getUTCSeconds()).padStart(2,'0');

  return `${Y}-${M}-${D}T${h}:${m}:${s}${sign}${oh}:${om}`;
}

// --- RRULE PARSER ---
function parseRRule(rruleStr) {
  const str = String(rruleStr || '').replace(/^RRULE:/i, '').trim();
  const parts = {};
  for (const pair of str.split(';')) {
    const i = pair.indexOf('=');
    if (i === -1) continue;
    const k = pair.slice(0, i).toUpperCase().trim();
    const v = pair.slice(i + 1).trim();
    if (k && v) parts[k] = v;
  }
  return parts;
}

const DAY_MAP = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };

function addDaysUTC(d, n) {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}
function addMonthsUTC(d, n) {
  const r = new Date(d.getTime());
  r.setUTCMonth(r.getUTCMonth() + n);
  return r;
}
function setUTCTime(d, h, m, s) {
  d.setUTCHours(h, m, s, 0);
}

function getMondayUTC(d) {
  const r = new Date(d.getTime());
  const day = r.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  r.setUTCDate(r.getUTCDate() + diff);
  r.setUTCHours(0,0,0,0);
  return r;
}

function getWeekdayInWeekUTC(weekStart, targetDay) {
  const r = new Date(weekStart.getTime());
  const diff = (targetDay - r.getUTCDay() + 7) % 7;
  r.setUTCDate(r.getUTCDate() + diff);
  return r;
}

function generateOccurrenceStarts(rrule, dtstartUtc, genStartUtc, genEndUtc, exdatesSet, maxOcc, offMin) {
  const freq = (rrule.FREQ || '').toUpperCase();
  const interval = parseInt(rrule.INTERVAL || '1', 10);

  const byDay = rrule.BYDAY ? rrule.BYDAY.split(',').map(s => s.trim()) : null;
  const byMonthDay = rrule.BYMONTHDAY ? rrule.BYMONTHDAY.split(',').map(Number) : null;

  const byHour = rrule.BYHOUR !== undefined ? parseInt(rrule.BYHOUR, 10) : shiftToLocal(dtstartUtc, offMin).getUTCHours();
  const byMinute = rrule.BYMINUTE !== undefined ? parseInt(rrule.BYMINUTE, 10) : shiftToLocal(dtstartUtc, offMin).getUTCMinutes();
  const bySecond = rrule.BYSECOND !== undefined ? parseInt(rrule.BYSECOND, 10) : 0;

  const dtstartL = shiftToLocal(dtstartUtc, offMin);
  const genStartL = shiftToLocal(genStartUtc, offMin);
  const genEndL = shiftToLocal(genEndUtc, offMin);

  const out = [];

  if (freq === 'WEEKLY') {
    const targetDays = byDay
      ? byDay.map(d => DAY_MAP[d.replace(/[^A-Z]/g,'')])
      : [dtstartL.getUTCDay()];

    let wk = getMondayUTC(dtstartL);

    while (wk <= genEndL && out.length < maxOcc) {
      for (const dayNum of targetDays) {
        if (out.length >= maxOcc) break;

        const oL = getWeekdayInWeekUTC(wk, dayNum);
        setUTCTime(oL, byHour, byMinute, bySecond);

        if (oL >= dtstartL && oL >= genStartL && oL <= genEndL) {
          const dk = ymdLocal(oL);
          if (!exdatesSet.has(dk)) out.push(unshiftFromLocal(oL, offMin));
        }
      }
      wk = addDaysUTC(wk, 7 * interval);
    }
  }

  else if (freq === 'DAILY') {
    let cur = new Date(dtstartL.getTime());
    setUTCTime(cur, byHour, byMinute, bySecond);

    while (cur <= genEndL && out.length < maxOcc) {
      if (cur >= genStartL) {
        const dk = ymdLocal(cur);
        if (!exdatesSet.has(dk)) out.push(unshiftFromLocal(cur, offMin));
      }
      cur = addDaysUTC(cur, interval);
      setUTCTime(cur, byHour, byMinute, bySecond);
    }
  }

  else if (freq === 'MONTHLY') {
    let cur = new Date(Date.UTC(dtstartL.getUTCFullYear(), dtstartL.getUTCMonth(), 1, 0, 0, 0));
    while (cur <= genEndL && out.length < maxOcc) {
      const days = byMonthDay || [dtstartL.getUTCDate()];
      for (const day of days) {
        if (out.length >= maxOcc) break;
        const last = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0)).getUTCDate();
        if (day > last) continue;

        const oL = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), day, byHour, byMinute, bySecond));
        if (oL >= dtstartL && oL >= genStartL && oL <= genEndL) {
          const dk = ymdLocal(oL);
          if (!exdatesSet.has(dk)) out.push(unshiftFromLocal(oL, offMin));
        }
      }
      cur = addMonthsUTC(cur, interval);
    }
  }

  else if (freq === 'YEARLY') {
    let cur = new Date(dtstartL.getTime());
    setUTCTime(cur, byHour, byMinute, bySecond);

    while (cur <= genEndL && out.length < maxOcc) {
      if (cur >= genStartL) {
        const dk = ymdLocal(cur);
        if (!exdatesSet.has(dk)) out.push(unshiftFromLocal(cur, offMin));
      }
      cur = new Date(Date.UTC(cur.getUTCFullYear() + interval, cur.getUTCMonth(), cur.getUTCDate(), byHour, byMinute, bySecond));
    }
  }

  return out;
}

// --- EXPANDIR ---
const virtualOccurrences = [];

for (const evt of recorrentes) {
  const rrule = parseRRule(evt.rrule);
  const evtStartUtc = new Date(evt.start_event);
  const evtEndUtc = evt.end_event ? new Date(evt.end_event) : null;

  const offMin = getOffsetMinutesFromIso(evt.start_event);

  const duration = evtEndUtc ? (evtEndUtc.getTime() - evtStartUtc.getTime()) : 15 * 60 * 1000;

  const exdatesSet = new Set();
  if (Array.isArray(evt.exdates)) {
    for (const ex of evt.exdates) {
      if (!ex) continue;
      const exUtc = new Date(ex);
      const exL = shiftToLocal(exUtc, offMin);
      exdatesSet.add(ymdLocal(exL));
    }
  }

  let genStart = new Date(rangeStart.getTime() - duration);
  let genEnd = new Date(rangeEnd.getTime());

  if (evt.repeats_until) {
    const ru = new Date(evt.repeats_until);
    if (ru < genEnd) genEnd = ru;
  }

  const startsUtc = generateOccurrenceStarts(rrule, evtStartUtc, genStart, genEnd, exdatesSet, 366, offMin);

  for (const occStartUtc of startsUtc) {
    const occEndUtc = new Date(occStartUtc.getTime() + duration);

    if (occStartUtc < rangeEnd && occEndUtc > rangeStart) {
      virtualOccurrences.push({
        ...evt,
        start_event: toIsoWithOffset(occStartUtc, offMin),
        end_event: toIsoWithOffset(occEndUtc, offMin),
        remembered: false,
        _is_virtual: true,
        _parent_id: evt.id,
      });
    }
  }
}

// juntar normais + ocorrências expandidas, ordenar
const all = [...normais, ...virtualOccurrences]
  .filter(e => e && typeof e === 'object');

all.sort((a, b) => new Date(a.start_event || 0) - new Date(b.start_event || 0));

const result = all.map(e => ({ json: e }));

// Safety net: nunca retornar vazio (mesmo comportamento de alwaysOutputData)
return result.length > 0 ? result : [{ json: {} }];
