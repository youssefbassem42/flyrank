const { run } = require('./db');

const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';

async function alert(job, message) {
  await run('INSERT INTO alerts (job_id, message) VALUES (?, ?)', [job.id, message]);
  console.error(`[ALERT] job ${job.id}: ${message}`);
  if (ALERT_WEBHOOK_URL) {
    try {
      await fetch(ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: job.id, type: job.type, message, at: new Date().toISOString() }),
      });
    } catch (err) {
      console.error(`[ALERT] webhook delivery failed: ${err.message}`);
    }
  }
}

module.exports = { alert };
