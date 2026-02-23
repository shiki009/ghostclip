export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { level, message, context } = req.body || {};
  const ua = req.headers['user-agent'] || 'unknown';
  const ts = new Date().toISOString();

  const entry = { ts, level, message, context, ua };

  if (level === 'error') {
    console.error('[GhostClip]', JSON.stringify(entry));
  } else {
    console.log('[GhostClip]', JSON.stringify(entry));
  }

  res.status(200).json({ ok: true });
}
