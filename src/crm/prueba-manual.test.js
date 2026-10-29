'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { periodoPruebaManual } = require('./prueba-manual');

const codigo = fs.readFileSync(path.join(__dirname,'../routes/prospectos.js'), 'utf8');
const editar = codigo.slice(codigo.indexOf('router.post("/prospectos/:id/editar"'));
const vistaEditar = codigo.slice(codigo.indexOf('router.get("/prospectos/:id/editar"'),codigo.indexOf('router.post("/prospectos/:id/editar"'));

test('regularización conserva hora de Buenos Aires y vence exactamente siete días después', () => {
  const resultado = periodoPruebaManual('2026-10-21T10:30', new Date('2026-10-29T17:00:00Z'));
  assert.equal(resultado.inicio.toISOString(), '2026-10-21T13:30:00.000Z');
  assert.equal(resultado.vence.toISOString(), '2026-10-28T13:30:00.000Z');
});

test('si no se informa inicio de la prueba, utiliza la fecha del guardado', () => {
  const ahora=new Date('2026-10-29T15:00:00Z');
  const resultado=periodoPruebaManual('',ahora);
  assert.equal(resultado.inicio.toISOString(),ahora.toISOString());
  assert.equal(resultado.vence.toISOString(),'2026-11-05T15:00:00.000Z');
});

test('rechaza horas invalidas y fechas futuras', () => {
  assert.throws(()=>periodoPruebaManual('2026-10-29T25:60'),/Fecha de inicio inválida/);
  assert.throws(()=>periodoPruebaManual('2026-10-30T12:00',new Date('2026-10-29T17:00:00Z')),/no puede ser futura/);
});

test('edición manual no envía avisos ni ejecuta activación automática', () => {
  const tramo = editar.slice(editar.indexOf('let cambioEstado = null;'), editar.indexOf('let cambioResponsable = null;'));
  assert.match(tramo,/periodoPruebaManual/);
  assert.doesNotMatch(tramo,/activarPrueba|procesarAvisosPrueba|enviarPorChatwoot|enviarAvisoInterno/);
  assert.match(editar,/prueba_inicio=\$3,prueba_vence=\$4/);
  assert.match(editar,/await conexion\.query\('BEGIN'\)/);
  assert.match(editar,/await conexion\.query\('COMMIT'\)/);
  assert.match(editar,/INSERT INTO historial_estados/);
});

test('fecha demo solo visible al seleccionar demo coordinada', () => {
  assert.match(vistaEditar,/id="bloque-fecha-demo"/);
  assert.match(vistaEditar,/estado === 'demo_coordinada'/);
  assert.match(vistaEditar,/demoInput\.disabled = !visible/);
  assert.match(vistaEditar,/demoInput\.required = visible/);
  assert.match(vistaEditar,/id="bloque-inicio-prueba"/);
});

test('edición y relevamiento ocultan campos descartados sin borrar datos almacenados', () => {
  for (const nombre of ['Hace cuánto lo usa','Necesidades especiales','Cantidad de productos', 'Volumen de ventas diarias','Condiciones comerciales','Próxima acción']) {
    assert.doesNotMatch(vistaEditar,new RegExp('<label>'+nombre+'<\\/label>'));
  }
  for (const campo of ['tiempo_sistema','necesidades','cant_productos','cant_ventas','condiciones_comerciales']) {
    assert.match(editar, new RegExp('actual\\.'+campo));
  }
});

test('sin respuesta no está disponible como botón separado y sigue siendo motivo de pérdida', () => {
  const vista = codigo.slice(codigo.indexOf('router.get("/prospectos/:id",'),codigo.indexOf('// ELIMINAR PROSPECTO'));
  assert.doesNotMatch(vista, /Marcar sin respuesta/);
  assert.match(codigo,/<option value="Sin respuesta">Sin respuesta<\/option>/);
});
