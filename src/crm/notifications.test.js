'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const orig=Module._load;
const queries=[];
const pool={ async query(sql,args) {
  queries.push([sql,args]);
  if (sql.includes('INSERT INTO crm_avisos')) return { rows:[{id:90}] };
  return {rows:[]};
}};
Module._load=function(name,parent,isMain){
  if(name==='node-cron') return {schedule(){}};
  if(name==='../db') return {pool};
  if(name==='../zoomAgentes')return {AGENTE_TELEFONO:{},telefonoVendedor(){return null;}};
  if(name==='../zoomChatwoot')return {enviarPorChatwoot(){return false;}};
  return orig.apply(this,arguments);
};
const {reclamarAviso,recordarSeguimientosProgramados}=require('./notifications');
Module._load=orig;

test('un envío fallido puede reclamarse de nuevo con espera de 15 minutos',async()=>{
  assert.equal(await reclamarAviso('respuesta_15',13),90);
  const sql=queries.at(-1)[0];
  assert.match(sql,/ON CONFLICT \(fecha, tipo, usuario_id\) DO UPDATE/);
  assert.match(sql,/crm_avisos\.estado='error'/);
  assert.match(sql,/15 minutes/);
});

test('recordatorios fallidos se habilitan para reintento y enviados no',async()=>{
  const anterior=process.env.CRM_ALERTAS_WHATSAPP;
  process.env.CRM_ALERTAS_WHATSAPP='true';
  try {await recordarSeguimientosProgramados();}finally{
    if(anterior===undefined) delete process.env.CRM_ALERTAS_WHATSAPP;
    else process.env.CRM_ALERTAS_WHATSAPP=anterior;
  }
  const sql=queries.at(-1)[0];
  assert.match(sql,/r.estado='enviado'/);
  assert.match(sql,/r.creado_en > NOW\(\)-interval '15 minutes'/);
});
