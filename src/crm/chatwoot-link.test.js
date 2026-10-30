'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {linkChatwoot,completarEnlaceConversacion}=require('./chatwoot-link');
test('enlaces a conversaciones individuales desde el canal del CRM',()=>{
  const oldBase=process.env.CHATWOOT_URL;
  const oldAccount=process.env.CHATWOOT_ACCOUNT_ID;
  process.env.CHATWOOT_URL='https://chatwoot.example/';
  process.env.CHATWOOT_ACCOUNT_ID='1';
  try {
    const url=linkChatwoot(2860,6);
    assert.equal(url,'https://chatwoot.example/app/accounts/1/inbox/6/conversations/2860');
    assert.equal(completarEnlaceConversacion('Alerta #2860',url).match(/chatwoot\.example/g).length,1);
    assert.equal(completarEnlaceConversacion(completarEnlaceConversacion('Alerta #2860',url),url).match(/chatwoot\.example/g).length,1);
  } finally {
    if (oldBase===undefined) delete process.env.CHATWOOT_URL; else process.env.CHATWOOT_URL=oldBase;
    if (oldAccount===undefined) delete process.env.CHATWOOT_ACCOUNT_ID; else process.env.CHATWOOT_ACCOUNT_ID=oldAccount;
  }
});
