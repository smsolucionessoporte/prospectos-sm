const axios = require('axios');

async function getZoomToken() {
  const auth = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');
  const { data } = await axios.post('https://zoom.us/oauth/token', null, {
    params: { grant_type: 'account_credentials', account_id: process.env.ZOOM_ACCOUNT_ID },
    headers: { Authorization: `Basic ${auth}` }
  });
  return data.access_token;
}

async function crearReunionZoom(zoomEmail, topic, startTimeISO) {
  const token = await getZoomToken();
  const { data } = await axios.post(
    `https://api.zoom.us/v2/users/${zoomEmail}/meetings`,
    { topic, type: 2, start_time: startTimeISO, timezone: 'America/Argentina/Buenos_Aires', duration: 30 },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return data.join_url;
}

async function enviarPorChatwoot(telefono, mensaje) {
  const { data } = await axios.get(
    `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/contacts/search?q=${telefono}`,
    { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
  );
  const conversationId = data.payload[0]?.conversations?.[0]?.id;
  if (!conversationId) return false;
  await axios.post(
    `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    { content: mensaje, message_type: 'outgoing' },
    { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
  );
  return true;
}

module.exports = { crearReunionZoom, enviarPorChatwoot };