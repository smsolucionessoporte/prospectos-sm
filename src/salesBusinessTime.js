const ARGENTINA_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 17;

function toArgentinaLocal(date) {
  return new Date(date.getTime() - ARGENTINA_UTC_OFFSET_MS);
}

/**
 * Devuelve los minutos laborales transcurridos entre dos instantes.
 * Horario de Ventas: lunes a viernes, 09:00-17:00 (Argentina).
 * No contempla feriados nacionales.
 */
function businessMinutesBetween(startValue, endValue = new Date()) {
  const start = startValue instanceof Date ? startValue : new Date(startValue);
  const end = endValue instanceof Date ? endValue : new Date(endValue);

  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end.getTime() <= start.getTime()
  ) {
    return 0;
  }

  const localStart = toArgentinaLocal(start);
  const localEnd = toArgentinaLocal(end);

  let day = new Date(Date.UTC(
    localStart.getUTCFullYear(),
    localStart.getUTCMonth(),
    localStart.getUTCDate(),
    0,
    0,
    0,
    0,
  ));

  const lastDay = new Date(Date.UTC(
    localEnd.getUTCFullYear(),
    localEnd.getUTCMonth(),
    localEnd.getUTCDate(),
    0,
    0,
    0,
    0,
  ));

  let totalMs = 0;

  while (day.getTime() <= lastDay.getTime()) {
    const weekday = day.getUTCDay();

    if (weekday !== 0 && weekday !== 6) {
      const workStart = new Date(day.getTime());
      workStart.setUTCHours(WORK_START_HOUR, 0, 0, 0);

      const workEnd = new Date(day.getTime());
      workEnd.setUTCHours(WORK_END_HOUR, 0, 0, 0);

      const overlapStart = Math.max(localStart.getTime(), workStart.getTime());
      const overlapEnd = Math.min(localEnd.getTime(), workEnd.getTime());

      if (overlapEnd > overlapStart) {
        totalMs += overlapEnd - overlapStart;
      }
    }

    day.setUTCDate(day.getUTCDate() + 1);
  }

  return Math.floor(totalMs / 60_000);
}

module.exports = { businessMinutesBetween };
