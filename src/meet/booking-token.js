'use strict';
const {createHmac,timingSafeEqual}=require('crypto');
function secret(){const s=process.env.DEMO_BOOKING_SECRET || process.env.AUTOMATION_API_KEY; if(!s || s.length<20) throw new Error('Falta DEMO_BOOKING_SECRET (mínimo 20 caracteres)'); return s;}
function sign(conversationId, expiresAt){const payload=`${conversationId}.${expiresAt}`;return `${payload}.${createHmac('sha256',secret()).update(payload).digest('hex')}`;}
function issue(conversationId,now=Date.now()){
 const id=Number(conversationId);if(!Number.isSafeInteger(id)||id<1)throw new Error('ID conversación inválido');
 return sign(id,Math.floor((now+7*86400000)/1000));
}
function verify(token,now=Date.now()){
 const match=String(token||'').match(/^(\d+)\.(\d+)\.([0-9a-f]{64})$/);if(!match)throw new Error('Enlace de reserva inválido');
 const [,idText,expText,mac]=match; const id=Number(idText),exp=Number(expText);
 if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(exp)||exp*1000<now||exp*1000>now+8*86400000)throw new Error('Enlace expirado o inválido');
 const correct=sign(id,exp).split('.').at(-1);
 if(!timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(correct,'hex')))throw new Error('Enlace de reserva inválido');
 return id;
}
module.exports={issue,verify};
