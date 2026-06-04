const express = require('express');
const { getClient, isConfigured, hasToken, writeToken, clearToken, SCOPES } = require('../lib/msGraph');

const router = express.Router();

router.get('/', async (_req, res, next) => {
  try {
    if (!isConfigured()) {
      return res.status(500).send('Microsoft credentials not configured. Set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID in .env');
    }
    const client = getClient();
    const redirectUri = process.env.MICROSOFT_REDIRECT_URI || 'http://localhost:3001/api/auth/microsoft/callback';
    const url = await client.getAuthCodeUrl({ scopes: SCOPES, redirectUri });
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

router.get('/callback', async (req, res, next) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing authorization code');
    const client = getClient();
    const redirectUri = process.env.MICROSOFT_REDIRECT_URI || 'http://localhost:3001/api/auth/microsoft/callback';
    const result = await client.acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri
    });
    const tokenCache = client.getTokenCache();
    const cache = await tokenCache.serialize();
    writeToken({ account: result.account, cache });
    res.send(`<html><body style="font-family:system-ui;background:#0d0f12;color:#e6edf3;padding:40px;">
      <h2>Outlook connected.</h2>
      <p>You can close this tab and return to SE/notebook.</p>
      <script>setTimeout(() => window.close(), 1500);</script>
    </body></html>`);
  } catch (err) {
    next(err);
  }
});

router.get('/status', (_req, res) => {
  res.json({ configured: isConfigured(), connected: hasToken() });
});

router.post('/disconnect', (_req, res) => {
  clearToken();
  res.json({ ok: true });
});

module.exports = router;
