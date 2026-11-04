'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'..','routes','prospectos.js'),'utf8');
const start = source.indexOf("router.post('/prospectos/:id/responsable-demo'");
const end = source.indexOf('// ─── CAMBIAR RESPONSABLE (SOLO ADMIN)', start);
const handler = source.slice(start,end);
test('corrección desde ficha: únicamente CRM e historial, ninguna llamada externa',()=>{
  assert.ok(start>=0 && end>start);
  assert.match(handler,/UPDATE prospectos SET demo_responsable=\$2/);
  assert.match(handler,/INSERT INTO historial_estados/);
  assert.doesNotMatch(handler,/actualizarResponsableReunionMeet|enviarPorChatwoot|enviarAvisoInterno|axios\.|fetch\(|notifySalesAgent|assignAgent/);
  assert.match(handler,/solo en SM Comercial/);
});
test('el formulario informa que es una corrección silenciosa',()=>{
  assert.match(source,/No se modificarán Chatwoot, Calendar ni Meet/);
  assert.match(source,/No envía avisos ni modifica Chatwoot, Calendar o Meet/);
});
