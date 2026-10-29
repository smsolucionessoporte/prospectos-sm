'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pasoPorEstado, instanteDemoAR } = require('./pasos');
const AHORA=Date.parse('2026-10-28T14:00:00-03:00');

test('Próxima acción de cada estado comercial',()=>{
  assert.equal(pasoPorEstado('prospecto').accion,'Coordinar demo');
  assert.equal(pasoPorEstado('sin_respuesta').accion,'Reintentar contacto');
  assert.equal(pasoPorEstado('demo_realizada').accion,'Activar prueba o cerrar cliente');
  assert.equal(pasoPorEstado('confirmado').terminal,true);
  assert.equal(pasoPorEstado('perdido').terminal,true);
});

test('Demo a las 14:30 de Argentina todavía no ocurrió a las 14:00',()=>{
  const paso=pasoPorEstado('demo_coordinada','2026-10-28T14:30:00',AHORA);
  assert.equal(paso.accion,'Dar demo');
  assert.equal(paso.demoVencida,false);
  assert.equal(paso.vencimiento,Date.parse('2026-10-28T14:30:00-03:00'));
});

test('Demo que ya pasó requiere cargar relevamiento o reagendar',()=>{
  const paso=pasoPorEstado('demo_coordinada','2026-10-28T13:30:00',AHORA);
  assert.equal(paso.accion,'Cargar relevamiento o reagendar');
  assert.equal(paso.demoVencida,true);
});

test('Fecha naive de PostgreSQL tratada como hora argentina, no UTC',()=>{
  assert.equal(instanteDemoAR(new Date('2026-10-28T14:30:00Z')),
    Date.parse('2026-10-28T14:30:00-03:00'));
  assert.equal(pasoPorEstado('demo_coordinada',null,AHORA).accion,'Confirmar fecha de la demo');
});

test('La etapa Prueba tiene seguimiento antes de contratar o perder',()=>{
  const p=pasoPorEstado('prueba');
  assert.equal(p.tipo,'seguimiento');
  assert.equal(p.terminal,false);
  assert.match(p.accion,/vencimiento/);
});
