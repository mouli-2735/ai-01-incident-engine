// scripts/seed.js — load data/alerts.json into Atlas. Idempotent: re-run freely.
//   node scripts/seed.js            # alerts only
//   node scripts/seed.js --reset    # wipe incidents/audit first
//   node scripts/seed.js --history  # also seed prior pattern decisions for the demo

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { connectDB, disconnectDB } = require('../db');
const { Alert, Incident, AuditLog, PatternMemory } = require('../models');

const args = process.argv.slice(2);
const RESET = args.includes('--reset');
const HISTORY = args.includes('--history');

function serviceFamilyOf(service = '') {
  const s = service.toLowerCase();
  if (/^payments|^checkout|^billing/.test(s)) return 'payments';
  if (/^cdn|^frontend|^web|^static/.test(s)) return 'frontend';
  if (/^auth|^user-db|^identity|^session/.test(s)) return 'auth';
  return 'other';
}

async function main() {
  await connectDB();

  if (RESET) {
    await Promise.all([
      Incident.deleteMany({}),
      AuditLog.deleteMany({}),
      Alert.updateMany({}, { $set: { status: 'new', incident: null } }),
    ]);
    console.log('[seed] reset incidents + audit log, alerts marked new');
  }

  const file = path.join(__dirname, '..', 'data', 'alerts.json');
  if (!fs.existsSync(file)) {
    throw new Error(`Not found: ${file} — copy your existing data/alerts.json next to these files.`);
  }

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.alerts || [];

  let inserted = 0;
  for (const [i, a] of list.entries()) {
    const alertId = a.id || a.alertId || `seed-${i + 1}`;
    const doc = {
      alertId,
      source: a.source || 'mock',
      service: a.service,
      serviceFamily: serviceFamilyOf(a.service),
      severity: a.severity || 'medium',
      message: a.message || a.description || '',
      metric: a.metric,
      value: typeof a.value === 'number' ? a.value : undefined,
      timestamp: a.timestamp ? new Date(a.timestamp) : new Date(),
      raw: a,
    };

    const res = await Alert.updateOne(
      { alertId },
      { $set: doc, $setOnInsert: { status: 'new', incident: null } },
      { upsert: true }
    );
    if (res.upsertedCount) inserted++;
  }

  console.log(`[seed] ${list.length} alerts processed, ${inserted} newly inserted`);

  if (HISTORY) {
    // Pre-load a few past decisions so the demo can show "approved 4/4 times
    // previously" instead of an empty memory on a cold database.
    const demo = [
      { patternKey: 'payments::checkout-service+payments-api+payments-db::high',
        label: 'payments — checkout-service, payments-api, payments-db',
        approvals: 4, rejections: 0,
        action: 'Restart payments-db connection pool' },
      { patternKey: 'frontend::cdn-edge+frontend-web::high',
        label: 'frontend — cdn-edge, frontend-web',
        approvals: 2, rejections: 1,
        action: 'Purge CDN cache for affected edge nodes' },
    ];

    for (const d of demo) {
      for (let i = 0; i < d.approvals; i++) {
        await PatternMemory.record({
          patternKey: d.patternKey, label: d.label, decision: 'approved',
          decidedBy: 'sre-oncall', note: 'seeded history', action: d.action,
        });
      }
      for (let i = 0; i < d.rejections; i++) {
        await PatternMemory.record({
          patternKey: d.patternKey, label: d.label, decision: 'rejected',
          decidedBy: 'sre-oncall', note: 'seeded history',
        });
      }
    }
    console.log('[seed] pattern memory history seeded');
  }

  const counts = {
    alerts: await Alert.countDocuments(),
    incidents: await Incident.countDocuments(),
    audit: await AuditLog.countDocuments(),
    patterns: await PatternMemory.countDocuments(),
  };
  console.log('[seed] collection counts:', counts);

  await disconnectDB();
}

main().catch(async (err) => {
  console.error('[seed] failed:', err.message);
  await disconnectDB();
  process.exit(1);
});
