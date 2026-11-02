'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
const jobs = new Map();
const captured = [];
let canalConfirmado = true;
const fakePool = {
  async query(sql, params) {
    captured.push({ sql, params });
    if (sql.includes('FROM usuarios WHERE activo=TRUE')) return { rows: [{ id: 12, nombre: 'Giuliano Carabajal' }] };
    if (sql.includes('AS vencidas') && sql.includes('AS proximas')) return {
      rows: [{ vencidas: 1, proximas: 0, mensajes_por_responder: 0, por_cerrar: 0 }]
    };
    if (sql.includes('INSERT INTO crm_avisos')) return { rows: [{ id: 90 }] };
    if (sql.includes('FROM crm_tareas t LEFT JOIN prospectos')) return { rows: [{
      id: 501, vence_en: new Date('2026-10-30T16:00:00-03:00'),
      descripcion: 'Coordinar demo', responsable_id: 12,
      chatwoot_conversation_id: 3150, nombre_negocio: 'Prueba', contacto: null
    }] };
    if (sql.includes('INSERT INTO crm_recordatorios_tareas')) return { rows: [{ id: 91 }] };
    return { rows: [] };
  }
};
Module._load = function(request, parent, isMain) {
  if (request === 'node-cron') return { schedule(pattern, fn) { jobs.set(pattern, fn); } };
  if (request === '../db') return { pool: fakePool };
  if (request === '../zoomAgentes') return { AGENTE_TELEFONO: {}, telefonoVendedor(id) { return id === 12 ? '5491100000000' : null; } };
  if (request === '../zoomChatwoot') return { enviarPorChatwoot: async () => canalConfirmado };
  return originalLoad.call(this, request, parent, isMain);
};
const { iniciarAvisosCRM, recordarSeguimientosProgramados } = require('./notifications');
Module._load = originalLoad;

async function withEnv(fn) {
  const oldAlerts = process.env.CRM_ALERTAS_WHATSAPP;
  const oldUrl = process.env.CHATWOOT_URL;
  const oldAccount = process.env.CHATWOOT_ACCOUNT_ID;
  process.env.CRM_ALERTAS_WHATSAPP = 'true';
  process.env.CHATWOOT_URL = 'https://example.test';
  process.env.CHATWOOT_ACCOUNT_ID = '1';
  try { await fn(); } finally {
    if (oldAlerts === undefined) delete process.env.CRM_ALERTAS_WHATSAPP;
    else process.env.CRM_ALERTAS_WHATSAPP = oldAlerts;
    if (oldUrl === undefined) delete process.env.CHATWOOT_URL;
    else process.env.CHATWOOT_URL = oldUrl;
    if (oldAccount === undefined) delete process.env.CHATWOOT_ACCOUNT_ID;
    else process.env.CHATWOOT_ACCOUNT_ID = oldAccount;
  }
}

test('resumen enviado marca crm_avisos con parámetro booleano en lugar de tipos mixtos', async () => {
  await withEnv(async () => {
    captured.length = 0;
    iniciarAvisosCRM();
    const job = jobs.get('0,15 9 * * 1-5');
    assert.equal(typeof job, 'function');
    await job();
    const q = captured.find(({ sql }) => sql.includes('UPDATE crm_avisos'));
    assert.ok(q, 'debe actualizar crm_avisos');
    assert.match(q.sql, /\$2::boolean/g);
    assert.equal(q.params[1], true);
  });
});

test('recordatorio enviado marca crm_recordatorios_tareas con parámetro booleano', async () => {
  await withEnv(async () => {
    captured.length = 0;
    await recordarSeguimientosProgramados();
    const q = captured.find(({ sql }) => sql.includes('UPDATE crm_recordatorios_tareas'));
    assert.ok(q, 'debe actualizar crm_recordatorios_tareas');
    assert.match(q.sql, /\$2::boolean/g);
    assert.equal(q.params[1], true);
  });
});


test('resumen sin confirmación registra error sin conflicto de tipos', async () => {
  await withEnv(async () => {
    canalConfirmado = false;
    try {
      captured.length = 0;
      iniciarAvisosCRM();
      await jobs.get('0,15 9 * * 1-5')();
      const q = captured.find(({ sql }) => sql.includes('UPDATE crm_avisos'));
      assert.equal(q.params[1], false);
      assert.match(q.sql, /\$2::boolean/g);
    } finally { canalConfirmado = true; }
  });
});

test('recordatorio sin confirmación registra error sin conflicto de tipos', async () => {
  await withEnv(async () => {
    canalConfirmado = false;
    try {
      captured.length = 0;
      await recordarSeguimientosProgramados();
      const q = captured.find(({ sql }) => sql.includes('UPDATE crm_recordatorios_tareas'));
      assert.equal(q.params[1], false);
      assert.match(q.sql, /\$2::boolean/g);
    } finally { canalConfirmado = true; }
  });
});
