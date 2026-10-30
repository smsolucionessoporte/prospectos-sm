'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const original = Module._load;
const calls = [];
const now = Math.floor(Date.now()/1000);
const incoming = { id: 9001, message_type: 0, created_at: now, private: false, sender: { type: 'contact', id: 33 } };
const olderBot = { id: 8999, message_type: 1, created_at: now - 600, private: false, sender: { type: 'agent_bot', id: 17 } };
const axios = { async get(url) {
  calls.push(url);
  if (url.endsWith('/messages')) return { data: { payload: [incoming, olderBot] } };
  return { data: { id: 2860, inbox_id: 6, status: 'open',
    meta: { assignee: { id: 19 }, sender: { name: 'Jesús' } },
    messages: [{ id: 9010, message_type: 2, created_at: now + 1 }] } };
} };
let lastUpsert = null;
const pool = { async query(sql, args) {
  if (sql.includes('SELECT descartado_mensaje_id')) return { rows: [{ descartado_mensaje_id: null }] };
  if (sql.includes('INSERT INTO crm_chatwoot_estado')) {
    lastUpsert = args;
    return { rows: [{ requiere_respuesta: Boolean(args[8]) }] };
  }
  return { rows: [], rowCount: 1 };
} };
Module._load = function(name, parent, isMain) {
  if (name === 'axios') return axios;
  if (name === '../db') return { pool };
  return original.apply(this, arguments);
};
const { detalleChatwoot, grabarRevision } = require('./sync');
Module._load = original;

test('consulta siempre mensajes actuales incluso si el detalle contiene actividades', async () => {
  const chat = await detalleChatwoot({url:'https://cw.test/api/v1/accounts/1', headers: {}}, 2860);
  assert.ok(calls.some(u => u.endsWith('/2860/messages')));
  assert.ok(chat.messages.some(m => m.id === 9001));
  const pendiente = await grabarRevision({ chatwoot_conversation_id: 2860,
    vendedor_id:13, respondio_cliente:true, estado_prospecto:'prospecto', prospecto_id:266 }, chat);
  assert.equal(pendiente, true);
  assert.equal(lastUpsert[2], 13);
  assert.equal(lastUpsert[8], true);
  assert.ok(lastUpsert[5] instanceof Date);
});

test('Chatwoot sin agente nunca hereda el vendedor antiguo de Control', async () => {
  const chat = { id:2860, inbox_id:6, status:'open', meta:{ assignee:null }, messages:[incoming] };
  const pendiente = await grabarRevision({ chatwoot_conversation_id:2860,
    vendedor_id:13, respondio_cliente:true, estado_prospecto:'prospecto' }, chat);
  assert.equal(pendiente, false);
  assert.equal(lastUpsert[2], null);
});
