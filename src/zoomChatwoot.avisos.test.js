const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const {enviarAvisoInterno} = require('./zoomChatwoot');
const baseEnv = {
  EVOLUTION_API_URL: process.env.EVOLUTION_API_URL,
  EVOLUTION_API_KEY: process.env.EVOLUTION_API_KEY,
  EVOLUTION_INSTANCE: process.env.EVOLUTION_INSTANCE,
  VENTAS_TELEFONO_SANTIAGO: process.env.VENTAS_TELEFONO_SANTIAGO,
};
const oldPost = axios.post;
function setTestEnv(){
  process.env.EVOLUTION_API_URL='https://evolution.example.com';
  process.env.EVOLUTION_API_KEY='FAKEKEY';
  process.env.EVOLUTION_INSTANCE='ventas-sm';
  process.env.VENTAS_TELEFONO_SANTIAGO='+5491168443757';
}
test('aviso interno directo a Santiago usa Evolution sin crear una conversación Chatwoot',async()=>{
  setTestEnv();
  const requests=[];
  axios.post=async (url,body,opts)=>{
    requests.push({url,body,opts});
    return {status:201,data:{key:{id:'id123'}}};
  };
  try {
    const ok=await enviarAvisoInterno('Test de aviso',13);
    assert.equal(ok,true);
    assert.equal(requests.length,1);
    assert.equal(requests[0].url,'https://evolution.example.com/message/sendText/ventas-sm');
    assert.deepEqual(requests[0].body,{number:'5491168443757',text:'Test de aviso'});
    assert.equal(requests[0].opts.headers.apikey,'FAKEKEY');
  }finally{axios.post=oldPost;}
});
test('un fallo de Evolution no prueba por otro canal y evita duplicados',async()=>{
  setTestEnv();
  let calls=0;
  axios.post=async()=>{calls++;throw Object.assign(new Error('sin red'),{code:'ECONNRESET'});};
  try{
    await assert.rejects(enviarAvisoInterno('Test',13),/sin red/);
    assert.equal(calls,1);
  }finally{axios.post=oldPost;}
});
test('configuración incompleta bloquea envíos en lugar de usar otro número',async()=>{
  setTestEnv();
  delete process.env.EVOLUTION_API_KEY;
  let called=false;
  axios.post=async()=>{called=true;return {status:200,data:{}};};
  try{
    await assert.rejects(enviarAvisoInterno('Test',13),/EVOLUTION_CONFIG_INCOMPLETA/);
    assert.equal(called,false);
  }finally{axios.post=oldPost;}
});
test.after(()=>{
  axios.post=oldPost;
  for(const [k,v] of Object.entries(baseEnv)) if(v===undefined) delete process.env[k];else process.env[k]=v;
});
