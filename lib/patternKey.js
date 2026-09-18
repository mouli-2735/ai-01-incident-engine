// lib/patternKey.js
// The pattern key is what makes "AI-01 Remembers" work: two incidents that are
// the same *kind* of problem must produce the same key, even though their
// alert ids, timestamps and metric values differ.
//
// Deliberately coarse. Too specific and every incident looks new (memory never
// accumulates); too loose and unrelated incidents share history. Service family
// + sorted services + dominant severity has been the right granularity here.

const FAMILY_MAP = [
  [/^payments|^checkout|^billing/, 'payments'],
  [/^cdn|^frontend|^web|^static/, 'frontend'],
  [/^auth|^user-db|^identity|^session/, 'auth'],
];

function serviceFamily(service = '') {
  const s = String(service).toLowerCase();
  for (const [re, family] of FAMILY_MAP) {
    if (re.test(s)) return family;
  }
  return 'other';
}

function slug(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * @param {Array} alerts - alert docs or plain objects with {service, severity}
 * @returns {string} e.g. "payments::checkout+payments-api+payments-db::critical"
 */
function buildPatternKey(alerts = []) {
  if (!alerts.length) return 'unknown';

  const services = [...new Set(alerts.map((a) => slug(a.service)))].sort();
  const family = serviceFamily(alerts[0].service);

  const severities = alerts.map((a) => a.severity);
  const dominant = severities.includes('high')
    ? 'high'
    : severities.includes('medium')
      ? 'medium'
      : 'low';

  return `${family}::${services.join('+')}::${dominant}`;
}

function patternLabel(alerts = []) {
  const services = [...new Set(alerts.map((a) => a.service))].sort();
  return `${serviceFamily(alerts[0]?.service || '')} — ${services.join(', ')}`;
}

module.exports = { buildPatternKey, patternLabel, serviceFamily };
