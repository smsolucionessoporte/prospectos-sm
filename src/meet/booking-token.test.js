'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {issue,verify}=require('./booking-token');
const {checkSlot,MEET_GRUPAL,parseLocal}=require('./calendar');
process.env.DEMO_BOOKING_SECRET='testing-signing-secret-is-not-production';
test('enlace firmado válido, alteración y caducidad',()=>{
 const now=Date.parse('2026-10-29T12:00:00Z'),t=issue(3053,now);
 assert.equal(verify(t,now),3053);
 assert.throws(()=>verify(t.replace('3053.','3054.'),now));
 assert.throws(()=>verify(t,now+8*86400000));
});
test('turnos grupales, fecha y horizonte',()=>{
 const now=Date.parse('2026-10-29T11:00:00Z');
 assert.equal(checkSlot('2026-10-30','am',new Date(now)).url,MEET_GRUPAL.am.url);
 assert.throws(()=>checkSlot('2026-10-31','am',new Date(now)),/lunes a viernes/);
 assert.throws(()=>checkSlot('2026-10-29','am',new Date('2026-10-29T14:00:00Z')),/futuro/);
 assert.throws(()=>checkSlot('2027-01-01','am',new Date(now)),/30 días/);
});

test('las fechas argentinas válidas de noche no se rechazan y los días imposibles sí',()=>{
 assert.equal(parseLocal('2026-10-29T22:30').utc.toISOString(),'2026-10-30T01:30:00.000Z');
 assert.throws(()=>parseLocal('2026-02-30T10:30'),/Fecha inválida/);
});
