import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, join, newRoom, Client, type RunningServer } from '../helpers/server.ts';

let srv: RunningServer;
const connections:Client[]=[];
const track = <T extends {c:Client}>(value:T) => { connections.push(value.c); return value; };
before(async () => { srv=await startServer({ SYNCROBEAT_RELEASE_CHANNEL:'beta', BETA_PRO_ROOM_CODES:'PRO-TEST' }); });
after(async () => { connections.forEach(c=>c.close()); if (srv) await srv.stop(); });

test('free rooms admit two including the drummer, refuse a forged Pro claim, and release a seat on leaving', async () => {
  const room=newRoom();
  const d=track(await join(srv.wsUrl,room,'free-drummer-1','drums'));
  const g=track(await join(srv.wsUrl,room,'free-guitar-1','guitar'));
  assert.equal(d.state.memberLimit,2);
  const third=track(await join(srv.wsUrl,room,'free-bass-1','bass',{ plan:'pro', isPro:true }));
  assert.equal(third.msg.code,'room_full');
  assert.equal((await fetch(`${srv.url}/api/rooms/${room}`).then(r=>r.json())).membersCount,2);
  g.c.close();
  await d.c.waitFor(m=>m.type==='members_update'&&m.members.length===1);
  const admitted=track(await join(srv.wsUrl,room,'free-bass-1','bass'));
  assert.equal(admitted.msg.type,'room_state');
});

test('authorized reconnection does not count as a third member or drop the original seat', async () => {
  const room=newRoom();
  const d=track(await join(srv.wsUrl,room,'reconnect-drum-1','drums'));
  track(await join(srv.wsUrl,room,'reconnect-guitar-1','guitar'));
  const again=track(await join(srv.wsUrl,room,'reconnect-drum-1','drums'));
  assert.equal(again.msg.type,'room_state');
  assert.equal(again.state.members.length,2);
  await new Promise(r=>setTimeout(r,50));
  assert.equal(d.c.ws.readyState,d.c.ws.CLOSED);
});

test('the public member ID cannot replace the drummer without the private token', async () => {
  const room=newRoom();
  const d=track(await join(srv.wsUrl,room,'private-drum-1','drums'));
  const g=track(await join(srv.wsUrl,room,'private-guitar-1','guitar'));
  assert.ok(!JSON.stringify(g.state).includes('deviceToken'));
  const attacker=track(await join(srv.wsUrl,room,'private-drum-1','drums',{deviceToken:''}));
  assert.equal(attacker.msg.code,'identity_conflict');
  assert.equal(d.c.ws.readyState,d.c.ws.OPEN);
  const played=await d.c.request({type:'play'},m=>m.type==='playback_state');
  assert.equal(played.isPlaying,true);
});

test('a socket cannot change its member identity and leave a ghost drummer', async () => {
  const room=newRoom();
  const d=track(await join(srv.wsUrl,room,'immutable-drum-1','drums'));
  const response=await d.c.request({type:'join',roomId:room,clientId:'changed-guitar-1',instrument:'guitar'},m=>m.type==='error');
  assert.equal(response.code,'identity_conflict');
  d.c.close();
  await new Promise(r=>setTimeout(r,100));
  const metadata=await fetch(`${srv.url}/api/rooms/${room}`).then(r=>r.json());
  assert.equal(metadata.membersCount,0);
  assert.equal(metadata.drumsTaken,false);
});

test('server beta grants allow more than two; they are never supplied by client flags', async () => {
  track(await join(srv.wsUrl,'PRO-TEST','pro-drummer-1','drums'));
  track(await join(srv.wsUrl,'PRO-TEST','pro-guitar-1','guitar'));
  const third=track(await join(srv.wsUrl,'PRO-TEST','pro-bass-1','bass'));
  assert.equal(third.state.members.length,3);
  assert.equal(third.state.plan,'pro');
  assert.equal(third.state.memberLimit,null);
});

test('native origins can read room metadata; other origins receive no CORS permission', async () => {
  const allowed=await fetch(`${srv.url}/api/rooms/CORS`,{headers:{Origin:'capacitor://localhost'}});
  assert.equal(allowed.headers.get('access-control-allow-origin'),'capacitor://localhost');
  const denied=await fetch(`${srv.url}/api/rooms/CORS`,{headers:{Origin:'https://unrelated.example'}});
  assert.equal(denied.headers.get('access-control-allow-origin'),null);
});

test('test Pro grants are ignored outside the beta release channel', async () => {
  const production=await startServer({ SYNCROBEAT_RELEASE_CHANNEL:'production', BETA_PRO_ROOM_CODES:'PRO-TEST' });
  const clients:Client[]=[];
  try {
    for (const [id, instrument] of [['prod-drummer-1','drums'],['prod-guitar-1','guitar'],['prod-bass-1','bass']] as const) {
      const result=await join(production.wsUrl,'PRO-TEST',id,instrument);
      clients.push(result.c);
      if (instrument==='bass') assert.equal(result.msg.code,'room_full');
    }
  } finally { clients.forEach(c=>c.close()); await production.stop(); }
});
