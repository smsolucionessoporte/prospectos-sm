'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {tieneEtiquetaClienteActivo,chatIdValido}=require('./exclusiones');
const {tareaDeProspectoAbierto,chatDeProspectoAbierto}=require('./cerrados');
test('Etiqueta de cliente activo de Chatwoot se reconoce en variantes',()=>{
  assert.equal(tieneEtiquetaClienteActivo({labels:['cliente-activo']}),true);
  assert.equal(tieneEtiquetaClienteActivo({meta:{labels:[{title:'CLIENTE-ACTIVO'}]}}),true);
  assert.equal(tieneEtiquetaClienteActivo({labels:['derivar-ventas']}),false);
});
test('Sólo IDs de Chatwoot numéricos positivos',()=>{
  assert.equal(chatIdValido(3210),true);assert.equal(chatIdValido(0),false);assert.equal(chatIdValido('abc'),false);
});
test('Las consultas de agenda excluyen tanto prospectos perdidos como tombstones',()=>{
  assert.match(tareaDeProspectoAbierto('t'),/crm_chatwoot_exclusiones/);
  assert.match(tareaDeProspectoAbierto('t'),/perdido/);
  assert.match(chatDeProspectoAbierto('s'),/crm_chatwoot_exclusiones/);
});
test('La eliminación es lógica: conservamos historial y bloqueamos recreación',()=>{
  const s=fs.readFileSync(path.resolve(__dirname,'../routes/prospectos.js'),'utf8');
  assert.match(s,/eliminado_en=NOW\(\)/);
  assert.match(s,/crm_chatwoot_exclusiones/);
  assert.match(s,/excluido:true/);
});
test('Campañas revalidan la exclusión antes de enviar',()=>{
  const s=fs.readFileSync(path.resolve(__dirname,'../routes/campanias.js'),'utf8');
  assert.match(s,/exclusiones\.length > 0/);
});
