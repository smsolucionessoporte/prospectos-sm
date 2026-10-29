const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { enviarPorChatwoot } = require('./zoomChatwoot');
const { AGENTE_TELEFONO } = require('./zoomAgentes');

const originalGet = axios.get;
const originalPost = axios.post;
const vars = {
  CHATWOOT_URL: process.env.CHATWOOT_URL,
  CHATWOOT_ACCOUNT_ID: process.env.CHATWOOT_ACCOUNT_ID,
  CHATWOOT_API_TOKEN: process.env.CHATWOOT_API_TOKEN,
  BOT_INBOX_ID: process.env.BOT_INBOX_ID,
};
// BOT_INBOX_ID se lee al cargar zoomChatwoot, por eso se configura en el comando de pruebas.
function mock(conversations, target='+5491155644899') {
  const calls=[];
  axios.get=async url => {
    if (url.includes('/contacts/search')) return {data:{payload:[{id:9683,phone_number:target}]}};
    if (url.includes('/contacts/9683/conversations')) return {data:{payload:conversations}};
    if (url.includes('/labels')) return {data:{payload:[]}};
    throw Error('GET inesperado '+url);
  };
  axios.post=async (url,data)=>{calls.push({url,data});return {data:{}};};
  return calls;
}

test('no crea contactos, sesiones ni conversaciones cuando no hay chat en el inbox', async()=>{
  const calls=mock([]);
  const ok=await enviarPorChatwoot('+5491155644899','Aviso',8);
  assert.equal(ok,false);
  assert.equal(calls.length,0);
});

test('aviso interno usa conversación existente sin reabrir, asignar ni etiquetar', async()=>{
  const calls=mock([{id:3041,inbox_id:6,status:'resolved',created_at:'2026-10-24T13:00:00Z'}]);
  const ok=await enviarPorChatwoot('+5491155644899','Aviso interno',8);
  assert.equal(ok,true);
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/\/conversations\/3041\/messages$/);
  assert.equal(calls[0].data.content,'Aviso interno');
});

test('elige la conversación más nueva dentro de la misma bandeja', async()=>{
  const calls=mock([
    {id:3041,inbox_id:6,status:'open',created_at:'2026-10-24T13:00:00Z'},
    {id:3100,inbox_id:6,status:'open',created_at:'2026-10-28T13:00:00Z'},
    {id:3200,inbox_id:7,status:'open',created_at:'2026-10-30T13:00:00Z'}
  ]);
  const ok=await enviarPorChatwoot('+5491155644899','Aviso interno',8);
  assert.equal(ok,true);
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/\/conversations\/3100\/messages$/);
});

test.after(()=>{
  axios.get=originalGet;axios.post=originalPost;
  for(const [k,v] of Object.entries(vars)) if(v===undefined) delete process.env[k];else process.env[k]=v;
});

test('cliente externo: reutiliza la conversación resuelta y no abre una nueva', async()=>{
  const calls=mock([{id:3100,inbox_id:6,status:'resolved',created_at:'2026-10-28T13:00:00Z'}],'+5491122233344');
  const ok=await enviarPorChatwoot('+5491122233344','Bienvenida',8);
  assert.equal(ok,true);
  assert.ok(calls.some(c=>c.url.endsWith('/conversations/3100/toggle_status')));
  assert.ok(calls.some(c=>c.url.endsWith('/conversations/3100/messages')));
  assert.ok(!calls.some(c=>/\/contacts\/\d+\/contact_inboxes$/.test(c.url)));
  assert.ok(!calls.some(c=>/\/conversations$/.test(c.url)));
});
