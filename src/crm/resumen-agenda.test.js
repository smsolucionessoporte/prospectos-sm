'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const load = Module._load;
const jobs = new Map();
const sqls = [];
const mensajes = [];
let resumenSimulado = {vencidas:0,proximas:0,sin_fecha:0,oportunidades_abiertas:6,mensajes_por_responder:0,por_cerrar:0};
const pool = { async query(sql, args) {
  sqls.push(sql);
  if (sql.includes('SELECT id, nombre FROM usuarios WHERE activo=TRUE')) return { rows: [{id:12,nombre:'Giuliano Carabajal'}] };
  if (sql.includes('AS vencidas') && sql.includes('AS proximas')) return {rows:[resumenSimulado]};
  if (sql.includes('INSERT INTO crm_avisos')) return {rows:[{id:42}]};
  return {rows:[]};
} };
Module._load = function(id, parent, isMain) {
 if (id==='node-cron') return { schedule: (pattern,fn) => jobs.set(pattern,fn) };
 if (id==='../db') return {pool};
 if (id==='../zoomAgentes') return { AGENTE_TELEFONO:{}, telefonoVendedor: id => id===12?'5491111111111':null };
 if (id==='../zoomChatwoot') return {enviarPorChatwoot: async (tel,msg)=>{mensajes.push(msg);return true;}};
 return load.call(this,id,parent,isMain);
};
const { iniciarAvisosCRM } = require('./notifications');
Module._load=load;

test('envía agenda aunque todas las oportunidades carezcan de tarea con vencimiento', async () => {
 const prev = process.env.CRM_ALERTAS_WHATSAPP;
 process.env.CRM_ALERTAS_WHATSAPP='true';
 try {
   iniciarAvisosCRM();
   await jobs.get('0,15 9 * * 1-5')();
   assert.equal(mensajes.length,1);
   assert.match(mensajes[0],/Oportunidades abiertas: \*6\*/);
   assert.match(mensajes[0],/Tareas sin fecha: \*0\*/);
   assert.ok(sqls.some(sql => sql.includes('vence_en IS NULL')));
   assert.ok(sqls.some(sql => sql.includes('UPDATE crm_avisos') && sql.includes('$2::boolean')));
 } finally {
  if(prev===undefined)delete process.env.CRM_ALERTAS_WHATSAPP;else process.env.CRM_ALERTAS_WHATSAPP=prev;
 }
});

test('incluye tareas sin fecha si no hay otra clase de actividad', async () => {
 const prev = process.env.CRM_ALERTAS_WHATSAPP;
 process.env.CRM_ALERTAS_WHATSAPP='true';
 resumenSimulado={vencidas:0,proximas:0,sin_fecha:2,oportunidades_abiertas:0,mensajes_por_responder:0,por_cerrar:0};
 try {
   iniciarAvisosCRM();
   await jobs.get('0,15 9 * * 1-5')();
   assert.equal(mensajes.length,2);
   assert.match(mensajes.at(-1),/Tareas sin fecha: \*2\*/);
 } finally {
   if (prev===undefined) delete process.env.CRM_ALERTAS_WHATSAPP; else process.env.CRM_ALERTAS_WHATSAPP=prev;
 }
});
