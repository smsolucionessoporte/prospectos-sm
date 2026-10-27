'use strict';
/**
 * SM Prospectos — auditoría histórica de respuestas de Chatwoot.
 *
 * Por defecto audita únicamente los derivados que tienen primera atención
 * registrada en PostgreSQL, pero no tienen seguimiento posterior registrado.
 * Incluye las conversaciones SIN fecha_derivacion (por ejemplo #2052/#1833).
 *
 * NO modifica datos sin --apply. Aun con --apply, solo escribe fechas
 * corroboradas a partir de mensajes en Chatwoot, nunca estados, responsables,
 * motivos de pérdida ni alertas.
 *
 * node scripts/auditar-respuestas-post-derivacion.js
 * node scripts/auditar-respuestas-post-derivacion.js --limit=10
 * node scripts/auditar-respuestas-post-derivacion.js --id=2462
 * node scripts/auditar-respuestas-post-derivacion.js --apply
 *
 * Variables de Railway: DATABASE_URL, CHATWOOT_URL, CHATWOOT_ACCOUNT_ID,
 * CHATWOOT_API_TOKEN. Opcional: CHATWOOT_BOT_AGENT_ID.
 */

const fs = require('fs');
const path = require('path');

const argumentsList = process.argv.slice(2);
const apply = argumentsList.includes('--apply');
const limitArg = argumentsList.find(a => a.startsWith('--limit='));
const idArg = argumentsList.find(a => a.startsWith('--id='));
const outputArg = argumentsList.find(a => a.startsWith('--output='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : null;
const targetId = idArg ? Number(idArg.slice('--id='.length)) : null;

if ((limitArg && (!Number.isSafeInteger(limit) || limit < 1)) ||
    (idArg && (!Number.isSafeInteger(targetId) || targetId < 1))) {
  console.error('Usá --limit=10 o --id=2462 con números enteros positivos.');
  process.exit(1);
}

const botAgentId = Number(process.env.CHATWOOT_BOT_AGENT_ID || 0);
const MATCH_TOLERANCE_MS = 10 * 60 * 1000;

function messageType(m) {
  const raw = String(m.message_type ?? '').toLowerCase();
  if (raw === 'incoming' || raw === '0') return 'incoming';
  if (raw === 'outgoing' || raw === '1') return 'outgoing';
  return 'other';
}
function msgDate(m) {
  const value = m.created_at;
  if (value == null || value === '') return null;
  const numeric = typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value));
  const timestamp = numeric ? Number(value) * (Number(value) < 1e12 ? 1000 : 1) : value;
  const d = new Date(timestamp);
  return Number.isFinite(d.getTime()) ? d : null;
}
function isIncoming(m) {
  return !m.private && messageType(m) === 'incoming' && msgDate(m) !== null;
}
function humanOutgoing(m) {
  if (m.private || messageType(m) !== 'outgoing' || !msgDate(m)) return false;
  const s = m.sender || {};
  const kind = String(s.type || '').toLowerCase();
  const name = String(s.name || s.available_name || '').trim();
  if (botAgentId && Number(s.id) === botAgentId) return false;
  if (kind !== 'user' && kind !== 'agent') return false;
  if (/\b(bot|automation system|automatizaci[oó]n|sistema autom[aá]tico)\b/i.test(name)) return false;
  return true;
}
function looksAutomated(m) {
  const body = String(m.content || '');
  return /me interesa,? coordinemos una llamada|estoy con mucho trabajo,? hablemos la pr[oó]xima semana|ya lo resolv[ií] \/ no lo necesito/i.test(body);
}
function csvCell(v) {
  const text = v instanceof Date ? v.toISOString() : String(v ?? '');
  const safe = /^[=+@\-\t\r]/.test(text) ? "'" + text : text;
  return '"' + safe.replace(/"/g, '""') + '"';
}
function classify(row, messages) {
  const dateDb = row.fecha_primera_respuesta_vendedor ? new Date(row.fecha_primera_respuesta_vendedor) : null;
  if (!dateDb || !Number.isFinite(dateDb.valueOf())) {
    return { status: 'REVISAR_SIN_FECHA_ATENCION', firstHuman: null, firstReply: null, afterDerivation: null, messages: messages.length };
  }
  if (!messages.length) {
    return { status: 'REVISAR_SIN_HISTORIAL', firstHuman: null, firstReply: null, afterDerivation: null, messages: 0 };
  }
  const dateDerivation = row.fecha_derivacion ? new Date(row.fecha_derivacion) : null;
  const validDerivation = dateDerivation && Number.isFinite(dateDerivation.valueOf());
  // Anclamos el primer contacto a la fecha existente en PostgreSQL, evitando
  // confundir mensajes de antiguos responsables con el primer contacto.
  const matches = messages.filter(m => humanOutgoing(m) &&
    Math.abs(msgDate(m).getTime() - dateDb.getTime()) <= MATCH_TOLERANCE_MS &&
    (!validDerivation || msgDate(m) >= dateDerivation));
  if (!matches.length) {
    return { status: 'REVISAR_PRIMERA_ATENCION', firstHuman: null, firstReply: null,
      afterDerivation: null, messages: messages.length };
  }
  matches.sort((a, b) => Math.abs(msgDate(a) - dateDb) - Math.abs(msgDate(b) - dateDb));
  const firstHumanMessage = matches[0];
  if (looksAutomated(firstHumanMessage)) {
    return { status: 'REVISAR_POSIBLE_MENSAJE_AUTOMATICO', firstHuman: msgDate(firstHumanMessage),
      firstReply: null, afterDerivation: null, messages: messages.length };
  }
  const firstHuman = msgDate(firstHumanMessage);
  const firstReplyMessage = messages.find(m => isIncoming(m) && msgDate(m) > firstHuman);
  const afterDerivationMessage = validDerivation
    ? messages.find(m => isIncoming(m) && msgDate(m) > dateDerivation)
    : null;
  return {
    status: firstReplyMessage ? 'RESPONDIO_TRAS_ATENCION' : 'ATENDIDO_SIN_RESPUESTA',
    firstHuman,
    firstReply: firstReplyMessage ? msgDate(firstReplyMessage) : null,
    afterDerivation: afterDerivationMessage ? msgDate(afterDerivationMessage) : null,
    messages: messages.length,
  };
}

async function main() {
  const required = ['DATABASE_URL','CHATWOOT_URL','CHATWOOT_ACCOUNT_ID','CHATWOOT_API_TOKEN'];
  const missing = required.filter(name => !process.env[name]);
  if (missing.length) throw new Error('Faltan variables de Railway: ' + missing.join(', '));

  // Estas dependencias ya son parte de SM Prospectos.
  const axios = require('axios');
  const { pool } = require('../src/db');
  const url = process.env.CHATWOOT_URL.replace(/\/$/, '');
  const api = axios.create({ baseURL: `${url}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}`,
    headers: { api_access_token: process.env.CHATWOOT_API_TOKEN }, timeout: 30000 });

  async function allMessages(id) {
    const seen = new Map();
    let before;
    let complete = false;
    for (let page = 0; page < 200; page++) {
      const response = await api.get(`/conversations/${id}/messages`, {
        params: before == null ? {} : { before },
      });
      const json = response.data;
      const arr = Array.isArray(json?.payload) ? json.payload :
        Array.isArray(json?.data?.payload) ? json.data.payload :
        Array.isArray(json) ? json : null;
      if (!arr) throw new Error('Formato inesperado de mensajes');
      if (!arr.length) { complete = true; break; }
      const ids = arr.map(m => Number(m.id)).filter(Number.isSafeInteger);
      if (!ids.length) throw new Error('Página de mensajes sin IDs');
      const minId = Math.min(...ids);
      if (before != null && minId >= before) throw new Error('Paginación repetida');
      for (const item of arr) if (Number.isSafeInteger(Number(item.id))) seen.set(Number(item.id), item);
      before = minId;
    }
    if (!complete) throw new Error('Historial demasiado extenso para auditar por completo');
    return [...seen.values()].sort((a,b) => (msgDate(a)?.getTime() || 0) - (msgDate(b)?.getTime() || 0) || Number(a.id)-Number(b.id));
  }

  try {
    const params = [];
    let filters = `cv.derivado = TRUE
      AND cv.fecha_primera_respuesta_vendedor IS NOT NULL
      AND cv.fecha_inicio_seguimiento_post_atencion IS NULL
      AND cv.fecha_respuesta_cliente_post_atencion IS NULL`;
    if (targetId) { params.push(targetId); filters += ` AND cv.chatwoot_conversation_id = $${params.length}`; }
    let end = ' ORDER BY cv.fecha_derivacion DESC NULLS LAST, cv.id DESC';
    if (limit) { params.push(limit); end += ` LIMIT $${params.length}`; }
    const records = (await pool.query(`SELECT cv.id, cv.chatwoot_conversation_id, cv.vendedor_nombre, cv.origen,
      cv.fecha_derivacion, cv.fecha_primera_respuesta_vendedor
      FROM control_ventas cv WHERE ${filters} ${end}`, params)).rows;
    console.log(`Conversaciones candidatas: ${records.length}. Modo ${apply ? 'APLICAR' : 'SOLO LECTURA'}.`);
    const rows = [];
    let changed = 0;
    for (const row of records) {
      let result;
      try {
        const messages = await allMessages(row.chatwoot_conversation_id);
        result = classify(row, messages);
        if (apply && ['RESPONDIO_TRAS_ATENCION','ATENDIDO_SIN_RESPUESTA'].includes(result.status)) {
          const resp = await pool.query(`UPDATE control_ventas
            SET fecha_inicio_seguimiento_post_atencion = $2::timestamptz,
                fecha_respuesta_cliente_post_atencion = $3::timestamptz,
                actualizado_en = NOW()
            WHERE id = $1 AND derivado = TRUE
              AND fecha_inicio_seguimiento_post_atencion IS NULL
              AND fecha_respuesta_cliente_post_atencion IS NULL
              AND fecha_primera_respuesta_vendedor IS NOT NULL`, [row.id, result.firstHuman, result.firstReply]);
          changed += resp.rowCount;
        }
      } catch (e) {
        result = { status: 'ERROR_CHATWOOT', firstHuman: null, firstReply: null,
          afterDerivation: null, messages: 0, error: e.response?.status ? `HTTP ${e.response.status}` : e.message };
      }
      rows.push({ ...row, ...result });
      console.log(`#${row.chatwoot_conversation_id} | ${result.status}${result.error ? ' | '+result.error : ''}`);
    }
    const headers = ['conversacion','vendedor','origen','fecha_derivacion','fecha_atencion_bd','resultado',
      'fecha_atencion_chatwoot','respuesta_posterior','respuesta_tras_derivacion','cantidad_mensajes','error'];
    const csv = [headers.join(';'), ...rows.map(r => [r.chatwoot_conversation_id, r.vendedor_nombre,
      r.origen, r.fecha_derivacion, r.fecha_primera_respuesta_vendedor, r.status,
      r.firstHuman, r.firstReply, r.afterDerivation, r.messages, r.error].map(csvCell).join(';'))].join('\r\n') + '\r\n';
    const out = outputArg ? path.resolve(outputArg.slice('--output='.length)) :
      path.resolve(process.cwd(), 'auditoria-respuestas-post-derivacion.csv');
    fs.writeFileSync(out, '\ufeff'+csv, 'utf8');
    const counts = {};
    for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
    console.log('\nRESUMEN:', JSON.stringify(counts, null, 2));
    console.log('Reporte CSV:', out);
    console.log(apply ? `Filas actualizadas: ${changed}` : 'SOLO LECTURA: no se actualizó la base de datos.');
    if (rows.some(r => r.status.startsWith('ERROR_'))) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(e => { console.error('ERROR:',e.message); process.exitCode = 1; });
}
module.exports = { classify, msgDate, humanOutgoing };
