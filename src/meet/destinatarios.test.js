'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { destinatariosDemo } = require('./destinatarios');

test('Rafael recibe un solo aviso individual', () => {
  assert.deepEqual(destinatariosDemo(8, 'Demo', { 6: '+549111', 10: '+549222' }), [
    { destino: 'vendedor', destinatario: 8, telefono: null, conversacion: null, mensaje: 'Demo' }
  ]);
});
test('Giuliano y Santiago reciben únicamente sus propios avisos', () => {
  for (const id of [12, 13]) {
    const avisos = destinatariosDemo(id, 'Demo');
    assert.equal(avisos.length, 1);
    assert.equal(avisos[0].destinatario, id);
  }
});
test('Marisol y Román solo reciben aviso cuando son responsables de prospecto interno', () => {
  assert.deepEqual(destinatariosDemo(6, 'Demo', { 6: '+54911666', 10: '+54910777' }).map(x => x.destinatario), [6]);
  assert.deepEqual(destinatariosDemo(10, 'Demo', { 6: '+54911666', 10: '+54910777' }).map(x => x.destinatario), [10]);
});
test('Sin propietario válido o teléfono interno, no se envía a otros ni a grupos', () => {
  assert.deepEqual(destinatariosDemo(0, 'Demo', { 6: '+54911666' }), []);
  assert.deepEqual(destinatariosDemo(6, 'Demo', {}), []);
});
