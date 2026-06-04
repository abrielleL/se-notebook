const fs = require('fs');
const path = require('path');
const msal = require('@azure/msal-node');

const TOKEN_PATH = path.join(__dirname, '..', 'db', 'token.json');
const SCOPES = ['Calendars.Read', 'User.Read', 'offline_access'];

function getConfig() {
  const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';
  return {
    auth: {
      clientId: process.env.MICROSOFT_CLIENT_ID || '',
      authority: `https://login.microsoftonline.com/${tenantId}`,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET || ''
    }
  };
}

function getClient() {
  return new msal.ConfidentialClientApplication(getConfig());
}

function isConfigured() {
  return Boolean(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);
}

function readToken() {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeToken(token) {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
}

function clearToken() {
  if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
}

function hasToken() {
  return Boolean(readToken());
}

async function getAccessToken() {
  const stored = readToken();
  if (!stored) throw new Error('Outlook not connected. Visit /api/auth/microsoft to authenticate.');

  const client = getClient();
  const tokenCache = client.getTokenCache();
  if (stored.cache) await tokenCache.deserialize(stored.cache);

  if (stored.account) {
    try {
      const result = await client.acquireTokenSilent({
        account: stored.account,
        scopes: SCOPES
      });
      const updatedCache = await tokenCache.serialize();
      writeToken({ account: result.account || stored.account, cache: updatedCache });
      return result.accessToken;
    } catch (err) {
      // fall through
    }
  }

  if (stored.refresh_token) {
    const result = await client.acquireTokenByRefreshToken({
      refreshToken: stored.refresh_token,
      scopes: SCOPES
    });
    if (result?.accessToken) return result.accessToken;
  }

  throw new Error('Outlook token expired. Reconnect via /api/auth/microsoft');
}

async function graphFetch(url) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph API error ${res.status}: ${text}`);
  }
  return res.json();
}

module.exports = {
  SCOPES,
  getClient,
  isConfigured,
  hasToken,
  readToken,
  writeToken,
  clearToken,
  getAccessToken,
  graphFetch
};
