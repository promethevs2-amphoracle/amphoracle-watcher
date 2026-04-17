// Decide how often to re-check a watcher based on how far away its
// event date is. Mirrors the ladder used in server.js pollWatchers.
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const DEFAULT_INTERVAL = 5 * MINUTE;
const FAR_INTERVAL = 6 * HOUR;
const NEAR_INTERVAL = 2 * HOUR;
const SAMEDAY_INTERVAL = 30 * MINUTE;
const ACTIVE_INTERVAL = 5 * MINUTE;

function decidePollInterval(now, checkAfterDateMs) {
  if (checkAfterDateMs == null || Number.isNaN(checkAfterDateMs)) {
    return DEFAULT_INTERVAL;
  }
  if (now < checkAfterDateMs - 48 * HOUR) return FAR_INTERVAL;
  if (now < checkAfterDateMs - 24 * HOUR) return NEAR_INTERVAL;
  if (now < checkAfterDateMs) return SAMEDAY_INTERVAL;
  return ACTIVE_INTERVAL;
}

module.exports = {
  decidePollInterval,
  DEFAULT_INTERVAL,
  FAR_INTERVAL,
  NEAR_INTERVAL,
  SAMEDAY_INTERVAL,
  ACTIVE_INTERVAL,
};
