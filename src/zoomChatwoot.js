const axios = require('axios');
const { AGENTE_INBOX, AGENTE_CHATWOOT_ID, AGENTE_TELEFONO, telefonoVendedor } = require('./zoomAgentes');

async function getZoomToken() {
  const auth = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');
  const { data } = await axios.post('https://zoom.us/oauth/token', null, {
    params: { grant_type: 'account_credentials', account_id: process.env.ZOOM_ACCOUNT_ID },
    headers: { Authorization: `Basic ${auth}` }
  });
  return data.access_token;
}

function formatearFechaAR(demoFechaStr) {
  // demoFechaStr viene como "2026-07-05T23:00" (hora de Buenos Aires, sin zona)
  const [fecha, hora] = demoFechaStr.split('T');
  const [anio, mes, dia] = fecha.split('-');
  const [hh, mm] = hora.split(':');
  const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  // Creamos la fecha SOLO para saber el día de la semana, tratándola como si fuera UTC (evita el corrimiento)
  const fechaUTC = new Date(`${fecha}T${hora}:00Z`);
  const diaSemana = dias[fechaUTC.getUTCDay()];
  return `${diaSemana} ${dia} de ${meses[parseInt(mes)-1]} a las ${hh}:${mm}`;
}

async function crearReunionZoom(zoomEmail, topic, startTimeISO) {
  const token = await getZoomToken();
  // Zoom espera "yyyy-MM-ddTHH:mm:ss" (con segundos). El input datetime-local
  // llega sin segundos ("2026-07-05T22:40"), y si el formato no matchea,
  // Zoom lo ignora silenciosamente y usa la hora de creación como default.
  const startTimeCompleto = /T\d{2}:\d{2}$/.test(startTimeISO)
    ? `${startTimeISO}:00`
    : startTimeISO;

  const { data } = await axios.post(
    `https://api.zoom.us/v2/users/${zoomEmail}/meetings`,
    { topic, type: 2, start_time: startTimeCompleto, timezone: 'America/Argentina/Buenos_Aires', duration: 30 },
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

// Los avisos internos comerciales son privados y se dirigen al vendedor asignado.
// Nunca enviar a un grupo como alternativa si falla la entrega.
async function enviarAvisoInterno(mensaje, usuarioId) {
  const { telefonoVendedor } = require('./zoomAgentes');
  const telefono = telefonoVendedor(Number(usuarioId));
  if (!telefono) {
    console.warn('[VENTAS] AVISO_SIN_TELEFONO', { usuarioId });
    return false;
  }

  // Canal opcional y explícito para AVISOS INTERNOS. No depende de que el
  // vendedor tenga una conversación previa en Chatwoot, ni crea una desde CRM.
  const evolutionKeys = ['EVOLUTION_API_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE'];
  const configuradas = evolutionKeys.filter(key => Boolean(process.env[key]?.trim()));
  if (configuradas.length > 0) {
    if (configuradas.length !== evolutionKeys.length) {
      throw new Error('EVOLUTION_CONFIG_INCOMPLETA: configurar URL, API_KEY e INSTANCE');
    }
    const base = process.env.EVOLUTION_API_URL.trim().replace(/\/+$/, '');
    if (!/^https:\/\/[^/]+/i.test(base)) throw new Error('EVOLUTION_URL_INVALIDA: se requiere HTTPS');
    const numero = telefono.replace(/\D/g, '');
    if (!/^\d{10,15}$/.test(numero)) throw new Error('EVOLUTION_NUMERO_INVALIDO');
    try {
      // Evolution API v2: salida dirigida al teléfono del vendedor, nunca a grupos.
      const resultado = await axios.post(
        `${base}/message/sendText/${encodeURIComponent(process.env.EVOLUTION_INSTANCE.trim())}`,
        { number: numero, text: mensaje },
        { headers: { apikey: process.env.EVOLUTION_API_KEY, 'content-type': 'application/json' }, timeout: 15000 }
      );
      if (!resultado || resultado.status < 200 || resultado.status >= 300 || resultado.data?.error) {
        throw new Error('EVOLUTION_RECHAZO_ENVIO');
      }
      console.info('[VENTAS] AVISO_EVOLUTION_ACEPTADO', { usuarioId, status: resultado.status });
      return true;
    } catch (error) {
      console.error('[VENTAS] AVISO_EVOLUTION_FALLIDO', {
        usuarioId,
        status: error.response?.status || null,
        detalle: error.response?.data?.message || error.code || error.message,
      });
      throw error; // Sin fallback para evitar un envío duplicado si hubo timeout.
    }
  }

  // Compatibilidad: sin Evolution configurado, enviar al chat existente.
  // No reabrir, reasignar, etiquetar ni crear conversaciones por estos avisos.
  const ok = Boolean(await enviarPorChatwoot(telefono, mensaje, Number(usuarioId)));
  if (!ok) console.warn('[VENTAS] AVISO_SIN_CHAT_PREVIO_O_CONTACTO', { usuarioId, inboxId: Number(process.env.BOT_INBOX_ID) || null });
  return ok;
}

async function enviarMensajePorConversationId(conversationId, mensaje) {
  await axios.post(
    `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    { content: mensaje, message_type: 'outgoing' },
    { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
  );
}

async function obtenerEstadoConversacionChatwoot(conversationId) {
  const headers = { api_access_token: process.env.CHATWOOT_API_TOKEN };
  try {
    const [{ data: conversation }, { data: labelsData }] = await Promise.all([
      axios.get(
        `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`,
        { headers }
      ),
      axios.get(
        `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/labels`,
        { headers }
      ).catch(() => ({ data: { payload: [] } }))
    ]);

    return {
      status: conversation?.status || null,
      labels: Array.isArray(labelsData?.payload)
        ? labelsData.payload
        : Array.isArray(conversation?.labels)
          ? conversation.labels
          : []
    };
  } catch (error) {
    if (error.response?.status === 404) return null;
    throw error;
  }
}

async function enviarCampaniaPorConversationId(conversationId, mensaje, campaniaId) {
  const headers = {
    'content-type': 'application/json',
    api_access_token: process.env.CHATWOOT_API_TOKEN
  };

  await axios.post(
    `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    {
      content: mensaje,
      message_type: 'outgoing',
      private: false,
      content_attributes: {
        sm_prospectos_campaign: true,
        campania_id: Number(campaniaId)
      }
    },
    { headers }
  );
}

const BOT_INBOX_ID = Number(process.env.BOT_INBOX_ID);

async function enviarPorChatwoot(telefono, mensaje, usuarioId, origen = null) {

      const inboxId = BOT_INBOX_ID;

        if (!inboxId) {
          console.log('BOT_INBOX_ID no configurado');
          return false;
        }



  const variantes = normalizarTelefono(telefono);
  let contacto = null;

  for (const variante of variantes) {
    const { data } = await axios.get(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/contacts/search?q=${encodeURIComponent(variante)}`,
      {
        headers: {
          api_access_token: process.env.CHATWOOT_API_TOKEN
        }
      }
    );

    if (data.payload?.length) {
      const digitos = valor => String(valor || '').replace(/\D/g, '');
      const permitidos = new Set(variantes.map(digitos));
      contacto = data.payload.find(item => permitidos.has(digitos(item.phone_number))) || null;
      if (contacto) break;
    }
  }

  if (!contacto) {
    console.error(`No se encontró contacto ${telefono}`);
    return false;
  }


  const { data: convData } = await axios.get(
    `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/contacts/${contacto.id}/conversations`,
    {
      headers: {
        api_access_token: process.env.CHATWOOT_API_TOKEN
      }
    }
  );


  // No crear una sesión/contact_inbox ni una conversación desde un envío saliente.
  // Esa responsabilidad es exclusivamente de Evolution API, el canal de WhatsApp.
  const conversaciones = Array.isArray(convData.payload) ? convData.payload : [];
  const delInbox = conversaciones
    .filter(c => Number(c.inbox_id) === Number(inboxId) && Number(c.id) > 0)
    .sort((a,b) => {
      const fecha = c => {
        for (const key of ['last_activity_at','updated_at','created_at']) {
          if (c[key] == null) continue;
          const n=typeof c[key] === 'number' ? c[key]*1000 : Date.parse(c[key]);
          if (Number.isFinite(n)) return n;
        }
        return 0;
      };
      return fecha(b)-fecha(a) || Number(b.id)-Number(a.id);
    });
  const conversation = delInbox[0] || null;
  if (!conversation) {
    console.warn('[CHATWOOT] AVISO_SIN_CONVERSACION_EXISTENTE: envío omitido sin crear conversaciones', {
      contactId: contacto.id, inboxId, usuarioId
    });
    return false;
  }

  // Envío a un integrante de SM: no reabrir, reasignar ni etiquetar su chat.
  // El destinatario se verifica contra el teléfono configurado del responsable,
  // no se infiere solo por el ID del agente que dispara la operación.
  const digitos = valor => String(valor || '').replace(/\D/g, '');
  const telefonoDestino = digitos(telefono);
  const esAvisoInterno = [AGENTE_TELEFONO[Number(usuarioId)], telefonoVendedor(Number(usuarioId))]
    .some(v => Boolean(v) && digitos(v) === telefonoDestino);

  if (!esAvisoInterno && conversation.status === 'resolved') {
    await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversation.id}/toggle_status`,
      { status: 'open' },
      { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
    );
  }

  if (!esAvisoInterno) {
    // La modificación de asignación y etiquetas solo corresponde a mensajes
    // comerciales al cliente, nunca a recordatorios enviados al personal SM.
    const chatwootAgentId = Number(
      Object.keys(AGENTE_CHATWOOT_ID).find(
        id => Number(AGENTE_CHATWOOT_ID[id]) === Number(usuarioId)
      )
    );

    if (chatwootAgentId) {
      await axios.post(
        `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversation.id}/assignments`,
        { assignee_id: chatwootAgentId },
        { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
      );
    }

    try {
      const { data: labelsData } = await axios.get(
        `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversation.id}/labels`,
        { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
      );
      const labelsActuales = labelsData.payload || [];
      const nuevasLabels = [
        ...labelsActuales.filter(label => label !== 'bot-ventas-activo'),
        'derivar-ventas'
      ];
      await axios.post(
        `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversation.id}/labels`,
        { labels: [...new Set(nuevasLabels)] },
        { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
      );
    } catch (error) {
      console.error('ERROR actualizando etiquetas de Chatwoot:', error.response?.data || error.message);
    }
  }

  console.info('[CHATWOOT] Envío en conversación existente', { contactId: contacto.id, conversationId: conversation.id, inboxId, avisoInterno: esAvisoInterno });
  await axios.post(
    `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversation.id}/messages`,
    {
      content: mensaje,
      message_type: 'outgoing'
    },
    {
      headers: {
        api_access_token: process.env.CHATWOOT_API_TOKEN
      }
    }
  );


  return true;
}



module.exports = {
  crearReunionZoom,
  enviarPorChatwoot,
  formatearFechaAR,
  enviarMensajePorConversationId,
  normalizarTelefono,
  enviarAvisoInterno,
  obtenerEstadoConversacionChatwoot,
  enviarCampaniaPorConversationId,
};