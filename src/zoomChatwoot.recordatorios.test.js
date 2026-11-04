'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

// Ejecutar tests sin servicios externos: simulamos exclusivamente respuestas
// de la API de Chatwoot. No se generan mensajes reales.
const calls = [];
let availableConversation = true;
const axiosMock = {
  async get(url) {
    calls.push({ method: 'GET', url });
    if (url.includes('/contacts/search?')) {
      return { data: { payload: [{ id: 100, phone_number: '+5491155554444' }] } };
    }
    if (url.includes('/contacts/100/conversations')) {
      return { data: { payload: availableConversation ? [{ id: 3161, inbox_id: 6, status: 'resolved' }] : [] } };
    }
    throw new Error(`GET inesperado: ${url}`);
  },
  async post(url, body) {
    calls.push({ method: 'POST', url, body });
    return { status: 200, data: { id: 1234 } };
  },
};
const originalLoad = Module._load;
try {
  Module._load = function patched(request, parent, isMain) {
    if (request === 'axios' && parent?.filename?.endsWith(`${path.sep}src${path.sep}zoomChatwoot.js`)) {
      return axiosMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  var { enviarMensajeSinReasignar } = require('./zoomChatwoot');
} finally {
  Module._load = originalLoad;
}
const envBefore = Object.fromEntries(['CHATWOOT_URL', 'CHATWOOT_ACCOUNT_ID', 'CHATWOOT_API_TOKEN', 'BOT_INBOX_ID'].map(k => [k, process.env[k]]));
process.env.CHATWOOT_URL = 'https://chatwoot.example.invalid';
process.env.CHATWOOT_ACCOUNT_ID = '1';
process.env.CHATWOOT_API_TOKEN = 'token-prueba';
process.env.BOT_INBOX_ID = '6';
// BOT_INBOX_ID se lee al importar; no depende del cambio de esta variable.
// Reiniciar el módulo bajo el valor conocido para la ruta sin id.
delete require.cache[require.resolve('./zoomChatwoot')];
let enviarConFallback;
try {
  Module._load = function patched(request, parent, isMain) {
    if (request === 'axios' && parent?.filename?.endsWith(`${path.sep}src${path.sep}zoomChatwoot.js`)) return axiosMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  enviarConFallback = require('./zoomChatwoot').enviarMensajeSinReasignar;
} finally {
  Module._load = originalLoad;
}
test.after(() => {
  for (const [key, value] of Object.entries(envBefore)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('recordatorio con conversation_id: publica el mensaje sin asignación ni cambio de estado', async () => {
  calls.length = 0;
  const ok = await enviarConFallback('+5491155554444', 'Recordatorio de demostración', 3161);
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/conversations\/3161\/messages$/);
  assert.equal(calls[0].body.message_type, 'outgoing');
});

test('sin conversation_id: encuentra chat existente, pero nunca reasigna, reabre ni cambia etiquetas', async () => {
  calls.length = 0;
  availableConversation = true;
  const ok = await enviarConFallback('+5491155554444', 'Recordatorio', null);
  assert.equal(ok, true);
  const posts = calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/conversations\/3161\/messages$/);
  assert.ok(!calls.some(c => /\/assignments|\/toggle_status|\/labels/.test(c.url)));
});

test('sin conversación: no crea chats nuevos ni registra el envío como exitoso', async () => {
  calls.length = 0;
  availableConversation = false;
  const ok = await enviarConFallback('+5491155554444', 'Recordatorio', null);
  assert.equal(ok, false);
  assert.equal(calls.filter(c => c.method === 'POST').length, 0);
});

test('sin teléfono ni conversation_id: omite el envío', async () => {
  calls.length = 0;
  assert.equal(await enviarConFallback('', 'Recordatorio', null), false);
  assert.equal(calls.length, 0);
});

test('el cron y las invitaciones usan la ruta sin reasignación', () => {
  const root = __dirname;
  const cron = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  const meet = fs.readFileSync(path.join(root, 'meet', 'routes.js'), 'utf8');
  const ficha = fs.readFileSync(path.join(root, 'routes', 'prospectos.js'), 'utf8');
  assert.match(cron, /enviarMensajeSinReasignar\(\s*p\.telefono,\s*mensaje,\s*p\.chatwoot_conversation_id/s);
  assert.match(meet, /ok=await enviarMensajeSinReasignar\(n\.telefono,n\.mensaje,n\.conversacion\)/);
  assert.match(ficha, /const ok=await enviarMensajeSinReasignar\(b\.telefono\|\|actual\.telefono,/);
});
