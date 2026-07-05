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
  console.log('DEBUG buscando contacto con teléfono:', telefono);
  const { data } = await axios.get(
    `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/contacts/search?q=${telefono}`,
    { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
  );
  console.log('DEBUG contactos encontrados:', JSON.stringify(data.payload?.map(c => ({ id: c.id, phone: c.phone_number, conversations: c.conversations }))));

  const contacto = data.payload[0];
  if (!contacto) {
    console.error(`No se encontró contacto con teléfono ${telefono}`);
    return false;
  }

  const conversation = contacto.conversations?.find(c => c.inbox_id === Number(process.env.CHATWOOT_WHATSAPP_INBOX_ID));
  console.log('DEBUG INBOX_ID esperado:', process.env.CHATWOOT_WHATSAPP_INBOX_ID, '| conversación encontrada:', conversation?.id);

  if (!conversation) {
    console.error(`No hay conversación de WhatsApp para ${telefono}`);
    return false;
  }

  await axios.post(
    `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversation.id}/messages`,
    { content: mensaje, message_type: 'outgoing' },
    { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
  );
  return true;
}

module.exports = { crearReunionZoom, enviarPorChatwoot };