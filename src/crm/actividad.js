'use strict';
// Vendedores Chatwoot habilitados: evitar que un mensaje enviado con el token técnico
// de un administrador se tome por una respuesta comercial humana.
const IDS_VENDEDORES_CHATWOOT = new Set([4, 8, 11, 19]);
const { businessMinutesBetween } = require('../salesBusinessTime');
const ARG_OFFSET = 3 * 60 * 60 * 1000;
function sumarMinutosLaborales(fecha, minutos = 60) {
  let cursor = new Date(fecha.getTime() - ARG_OFFSET);
  let resto = minutos;
  for (let i = 0; i < 20 && resto > 0; i++) {
    const dia = cursor.getUTCDay();
    if (dia === 0 || dia === 6) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(9, 0, 0, 0);
      continue;
    }
    const desde = new Date(cursor); desde.setUTCHours(9, 0, 0, 0);
    const hasta = new Date(cursor); hasta.setUTCHours(17, 0, 0, 0);
    if (cursor < desde) cursor = desde;
    if (cursor >= hasta) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(9, 0, 0, 0);
      continue;
    }
    const disponibles = Math.floor((hasta - cursor) / 60000);
    const avanzar = Math.min(disponibles, resto);
    cursor = new Date(cursor.getTime() + avanzar * 60000);
    resto -= avanzar;
  }
  return new Date(cursor.getTime() + ARG_OFFSET);
}

function millis(v) {
  if (!v) return 0;
  const d = (typeof v === 'number' || /^\d{10,13}$/.test(String(v)))
    ? (Number(v) < 1e12 ? Number(v) * 1000 : Number(v)) : new Date(v).getTime();
  return Number.isFinite(d) ? d : 0;
}

function evaluarConversacion(datos, { ahora = Date.now() } = {}) {
  const lista = Array.isArray(datos?.messages) ? datos.messages : [];
  const mensajes = lista.filter(m => !m.private && ['0', '1', 'incoming', 'outgoing'].includes(String(m.message_type)));
  const entrantes = mensajes.filter(m => ['0', 'incoming'].includes(String(m.message_type)));
  const humanos = mensajes.filter(m => {
    if (!['1', 'outgoing'].includes(String(m.message_type))) return false;
    const sender = m.sender || {};
    const id = Number(sender.id ?? m.sender_id);
    return (String(sender.type || m.sender_type).toLowerCase() === 'user') &&
      IDS_VENDEDORES_CHATWOOT.has(id);
  });
  const ultimaEntrada = entrantes.sort((a, b) => millis(b.created_at) - millis(a.created_at))[0];
  const ultimaSalida = humanos.sort((a, b) => millis(b.created_at) - millis(a.created_at))[0];
  // La bandeja 'esperando respuesta' muestra SOLO chats cuyo último mensaje público
  // es del cliente, no un mensaje de bot ni uno saliente de otro agente.
  const ultimoPublico = mensajes.sort((a, b) =>
    millis(b.created_at) - millis(a.created_at) || Number(b.id || 0) - Number(a.id || 0))[0];
  const ultimoEsDelCliente = Boolean(ultimoPublico && ['0', 'incoming'].includes(String(ultimoPublico.message_type)));
  const entradaMs = millis(ultimaEntrada?.created_at);
  const salidaMs = millis(ultimaSalida?.created_at);
  // Evitar que mensajes viejos se conviertan en tareas urgentes al iniciar el CRM.
  const reciente = entradaMs > 0 && entradaMs >= ahora - 14 * 86400000;
  const requiereRespuesta = reciente && ultimoEsDelCliente && entradaMs > salidaMs;
  return {
    requiereRespuesta,
    ultimoEsDelCliente,
    ultimaEntrada: entradaMs ? new Date(entradaMs) : null,
    ultimaSalida: salidaMs ? new Date(salidaMs) : null,
    ultimoMensajeId: ultimaEntrada ? String(ultimaEntrada.id || '') : null,
    minutosLaborales: requiereRespuesta ? businessMinutesBetween(new Date(entradaMs), new Date(ahora)) : 0,
  };
}


function requiereAviso(resultado, descartadoMensajeId) {
  return Boolean(resultado?.requiereRespuesta && resultado.ultimoMensajeId &&
    String(resultado.ultimoMensajeId) !== String(descartadoMensajeId ?? ''));
}

module.exports = { sumarMinutosLaborales, evaluarConversacion, requiereAviso };
