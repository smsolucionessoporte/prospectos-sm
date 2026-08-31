const axios = require('axios');
const { pool } = require('./db');

const GIULIANO_USUARIO_ID = 12;
const REDIRECT_URI = process.env.ZOOM_GIULIANO_REDIRECT_URI ||
  'https://prospectos-sm-production.up.railway.app/zoom/oauth/callback';

function getClientAuth() {
  const clientId = process.env.ZOOM_GIULIANO_CLIENT_ID;
  const clientSecret = process.env.ZOOM_GIULIANO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Faltan ZOOM_GIULIANO_CLIENT_ID / ZOOM_GIULIANO_CLIENT_SECRET');
  }
  return {
    clientId,
    auth: Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  };
}

async function guardarTokens(data) {
  if (!data.access_token || !data.refresh_token) {
    throw new Error('Zoom no devolvió access_token/refresh_token');
  }
  const expiresIn = Number(data.expires_in || 3600);
  // margen de 60 s para no usar un token a punto de vencer
  const expiresAt = new Date(Date.now() + Math.max(60, expiresIn - 60) * 1000);
  await pool.query(`
    INSERT INTO zoom_oauth_tokens (usuario_id, access_token, refresh_token, expires_at, actualizado_en)
    VALUES ($1,$2,$3,$4,NOW())
    ON CONFLICT (usuario_id) DO UPDATE SET
      access_token=EXCLUDED.access_token,
      refresh_token=EXCLUDED.refresh_token,
      expires_at=EXCLUDED.expires_at,
      actualizado_en=NOW()
  `, [GIULIANO_USUARIO_ID, data.access_token, data.refresh_token, expiresAt]);
}

async function intercambiarCode(code) {
  const { auth } = getClientAuth();
  const { data } = await axios.post('https://zoom.us/oauth/token', null, {
    params: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI
    },
    headers: { Authorization: `Basic ${auth}` }
  });
  await guardarTokens(data);
  return data;
}

async function refrescarToken(refreshToken) {
  const { auth } = getClientAuth();
  const { data } = await axios.post('https://zoom.us/oauth/token', null, {
    params: { grant_type: 'refresh_token', refresh_token: refreshToken },
    headers: { Authorization: `Basic ${auth}` }
  });
  await guardarTokens(data);
  return data.access_token;
}

async function getAccessTokenGiuliano() {
  const { rows } = await pool.query(
    'SELECT access_token, refresh_token, expires_at FROM zoom_oauth_tokens WHERE usuario_id=$1',
    [GIULIANO_USUARIO_ID]
  );
  if (!rows.length) {
    throw new Error('Giuliano todavía no autorizó Zoom');
  }
  const token = rows[0];
  if (new Date(token.expires_at).getTime() > Date.now()) return token.access_token;
  return refrescarToken(token.refresh_token);
}

async function crearReunionZoomGiuliano(topic, startTimeISO) {
  const token = await getAccessTokenGiuliano();
  const startTimeCompleto = /T\d{2}:\d{2}$/.test(startTimeISO)
    ? `${startTimeISO}:00`
    : startTimeISO;
  const { data } = await axios.post(
    'https://api.zoom.us/v2/users/me/meetings',
    {
      topic,
      type: 2,
      start_time: startTimeCompleto,
      timezone: 'America/Argentina/Buenos_Aires',
      duration: 30
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return data.join_url;
}

function registrarRutasZoomGiuliano(app) {
  app.get('/zoom/oauth/callback', async (req, res) => {
    const { code, error } = req.query;
    if (error) return res.status(400).send(`Zoom rechazó la autorización: ${error}`);
    if (!code) return res.status(400).send('Falta el código de autorización de Zoom.');
    try {
      await intercambiarCode(code);
      console.log('✓ OAuth de Zoom de Giuliano autorizado/actualizado');
      res.status(200).send('Zoom de Giuliano quedó vinculado correctamente. Ya podés cerrar esta pestaña.');
    } catch (err) {
      console.error('ERROR OAuth Zoom Giuliano:', err.response?.data || err.message);
      res.status(500).send('No se pudo vincular Zoom. Revisá los logs de Prospectos en Railway.');
    }
  });
}

module.exports = {
  GIULIANO_USUARIO_ID,
  crearReunionZoomGiuliano,
  registrarRutasZoomGiuliano
};
