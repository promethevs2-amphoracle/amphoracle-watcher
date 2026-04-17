// Keep whispers whose check_after_date is strictly in the future (or absent).
// Matches the filter in /scout. Invalid dates are dropped so they can't slip
// through as NaN > now.
function filterFutureWhispers(whispers, nowMs) {
  if (!Array.isArray(whispers)) return [];
  return whispers.filter((w) => {
    if (!w || !w.check_after_date) return true;
    const t = new Date(w.check_after_date).getTime();
    if (Number.isNaN(t)) return false;
    return t > nowMs;
  });
}

module.exports = { filterFutureWhispers };
