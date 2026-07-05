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

function normalizarTelefono(tel) {
  const limpio = tel.replace(/[\s\-()]/g, ''); // saca espacios, guiones, paréntesis
  const variantes = [limpio];
  // Si es +54 sin el 9, agregar la variante con 9
  if (limpio.startsWith('+54') && !limpio.startsWith('+549')) {
    variantes.push('+549' + limpio.slice(3));
  }
  // Si ya tiene +549, agregar la variante sin el 9 también
  if (limpio.startsWith('+549')) {
    variantes.push('+54' + limpio.slice(4));
  }
  return variantes;
}

async function enviarPorChatwoot(telefono, mensaje) {
  const variantes = normalizarTelefono(telefono);
  let contacto = null;

  for (const variante of variantes) {
    console.log('DEBUG probando variante:', variante);
    const { data } = await axios.get(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/contacts/search?q=${encodeURIComponent(variante)}`,
      { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
    );
    if (data.payload?.length) {
      contacto = data.payload[0];
      break;
    }
  }

  if (!contacto) {
    console.error(`No se encontró contacto con ninguna variante de ${telefono}`);
    return false;
  }

console.log('DEBUG conversaciones del contacto:', JSON.stringify(contacto.conversations));
console.log('DEBUG INBOX_ID que está usando el código:', process.env.CHATWOOT_WHATSAPP_INBOX_ID);

  const conversation = contacto.conversations?.find(c => c.inbox_id === Number(process.env.CHATWOOT_WHATSAPP_INBOX_ID));
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