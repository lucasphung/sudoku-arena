const express=require('express'),http=require('http'),{WebSocketServer}=require('ws'),Redis=require('ioredis'),bcrypt=require('bcryptjs'),crypto=require('crypto');
const redis=new Redis(process.env.REDIS_URL||'redis://localhost:6379',{maxRetriesPerRequest:3});
const app=express();app.use(express.json());app.use(express.static('public'));
app.get('/healthz',(q,r)=>r.send('ok'));
const server=http.createServer(app),wss=new WebSocketServer({server,path:'/ws'});

/* ---------- Sudoku ---------- */
const shuffle=a=>{for(let i=a.length-1;i>0;i--){const j=Math.random()*(i+1)|0;[a[i],a[j]]=[a[j],a[i]]}return a};
function cands(g,i){const r=i/9|0,c=i%9,u=new Set(),br=r-r%3,bc=c-c%3;
  for(let k=0;k<9;k++){u.add(g[r*9+k]);u.add(g[k*9+c]);u.add(g[(br+(k/3|0))*9+bc+k%3])}
  const o=[];for(let v=1;v<=9;v++)if(!u.has(v))o.push(v);return o}
function fill(g){let b=-1,bc=null;
  for(let i=0;i<81;i++)if(!g[i]){const c=cands(g,i);if(!bc||c.length<bc.length){b=i;bc=c;if(c.length<2)break}}
  if(b<0)return true;for(const v of shuffle(bc)){g[b]=v;if(fill(g))return true}g[b]=0;return false}
function count(g,lim){let b=-1,bc=null;
  for(let i=0;i<81;i++)if(!g[i]){const c=cands(g,i);if(!bc||c.length<bc.length){b=i;bc=c;if(c.length<2)break}}
  if(b<0)return 1;if(!bc.length)return 0;let n=0;
  for(const v of bc){g[b]=v;n+=count(g,lim-n);if(n>=lim)break}g[b]=0;return n}
const CLUES={easy:40,medium:32,hard:27},BASE={easy:100,medium:200,hard:300};
function gen(diff){const sol=Array(81).fill(0);fill(sol);const p=[...sol];let left=81;
  for(const i of shuffle([...Array(81).keys()])){if(left<=CLUES[diff])break;const v=p[i];p[i]=0;if(count([...p],2)!==1)p[i]=v;else left--}
  return{puzzle:p,sol}}
const same=(a,b)=>Array.isArray(a)&&a.length===81&&a.every((x,i)=>x===b[i]);
const pts=(d,s)=>Math.max(BASE[d]/10,BASE[d]-Math.floor(s/10));

/* ---------- Auth & API ---------- */
const wrap=f=>(q,r)=>f(q,r).catch(e=>r.status(e.code||500).json({error:e.message}));
const E=(m,c=400)=>Object.assign(new Error(m),{code:c});
async function newSession(u){const t=crypto.randomBytes(24).toString('hex');await redis.setex('sess:'+t,7*86400,u);return t}
const auth=f=>wrap(async(q,r)=>{const u=await redis.get('sess:'+q.get('x-token'));if(!u)throw E('Chưa đăng nhập',401);q.user=u;return f(q,r)});
app.post('/api/register',wrap(async(q,r)=>{const u=String(q.body.u||'').toLowerCase(),p=String(q.body.p||'');
  if(!/^[a-z0-9_]{3,16}$/.test(u))throw E('Tên đăng nhập 3-16 ký tự (a-z, 0-9, _)');if(p.length<6)throw E('Mật khẩu tối thiểu 6 ký tự');
  if(!await redis.hsetnx('u:'+u,'pw',await bcrypt.hash(p,10)))throw E('Tên đăng nhập đã tồn tại');
  await redis.zadd('lb','NX',0,u);r.json({token:await newSession(u)})}));
app.post('/api/login',wrap(async(q,r)=>{const u=String(q.body.u||'').toLowerCase(),h=await redis.hget('u:'+u,'pw');
  if(!h||!await bcrypt.compare(String(q.body.p||''),h))throw E('Sai tên đăng nhập hoặc mật khẩu',401);r.json({token:await newSession(u)})}));
app.get('/api/me',auth(async(q,r)=>{const u=q.user,[st,sc,rk,h]=await Promise.all([redis.hgetall('u:'+u),redis.zscore('lb',u),redis.zrevrank('lb',u),redis.lrange('hist:'+u,0,9)]);
  r.json({user:u,points:+sc||0,rank:rk==null?null:rk+1,games:+st.games||0,wins:+st.wins||0,hist:h.map(x=>JSON.parse(x))})}));
app.get('/api/leaderboard',auth(async(q,r)=>{const t=q.query.type||'points',time=BASE[t]!==undefined;
  const a=await(time?redis.zrange('best:'+t,0,49,'WITHSCORES'):redis.zrevrange('lb',0,49,'WITHSCORES'));
  r.json(a.reduce((o,x,i)=>(i%2?o[o.length-1].score=+x:o.push({user:x}),o),[]))}));
const finishRec=(u,rec)=>redis.multi().hincrby('u:'+u,'games',1).hincrby('u:'+u,'wins',rec.win?1:0).zincrby('lb',rec.pts,u)
  .lpush('hist:'+u,JSON.stringify({t:Date.now(),...rec})).ltrim('hist:'+u,0,19).exec();
app.post('/api/solo/start',auth(async(q,r)=>{const d=q.body.diff;if(!BASE[d])throw E('Độ khó không hợp lệ');
  const g=gen(d),id=crypto.randomBytes(8).toString('hex');
  await redis.setex('solo:'+id,10800,JSON.stringify({u:q.user,d,sol:g.sol,s:Date.now()}));r.json({id,puzzle:g.puzzle})}));
app.post('/api/solo/submit',auth(async(q,r)=>{const raw=await redis.get('solo:'+q.body.id);if(!raw)throw E('Ván không tồn tại hoặc đã hết hạn');
  const s=JSON.parse(raw);if(s.u!==q.user)throw E('Không hợp lệ',403);if(!same(q.body.grid,s.sol))return r.json({ok:false});
  await redis.del('solo:'+q.body.id);const secs=Math.round((Date.now()-s.s)/1000),p=pts(s.d,secs);
  await redis.zadd('best:'+s.d,'LT',secs,q.user);await finishRec(q.user,{mode:'solo',diff:s.d,win:true,secs,pts:p});r.json({ok:true,secs,pts:p})}));

/* ---------- Phòng thi (WebSocket) ---------- */
const rooms=new Map(),send=(w,m)=>w.readyState===1&&w.send(JSON.stringify(m)),all=(r,m)=>r.players.forEach(p=>send(p.ws,m));
const sideOf=r=>[...new Set([...r.players.values()].map(p=>p.side))];
const info=r=>({type:'room',code:r.code,mode:r.mode,diff:r.diff,host:r.host,players:[...r.players].map(([user,p])=>({user,side:p.side}))});
function progress(r){const o={};for(const s of sideOf(r))o[s]=r.boards[s].filter((v,i)=>v&&!r.puzzle[i]).length;all(r,{type:'progress',sides:o,total:r.puzzle.filter(x=>!x).length})}
function join(ws,r,side){if(r.state!=='lobby')throw E('Phòng đã bắt đầu');leave(ws);
  if(r.mode==='duel'){if(r.players.size>=2)throw E('Phòng đã đủ 2 người');side=ws.user}
  else{if(r.players.size>=8)throw E('Phòng đã đầy');const n=s=>[...r.players.values()].filter(p=>p.side===s).length;side=side==='A'||side==='B'?side:(n('A')<=n('B')?'A':'B')}
  r.players.set(ws.user,{ws,side});ws.room=r;all(r,info(r))}
function leave(ws){const r=ws.room;if(!r)return;ws.room=null;r.players.delete(ws.user);
  if(!r.players.size)return void rooms.delete(r.code);
  if(r.state==='lobby'){if(r.host===ws.user)r.host=[...r.players.keys()][0];return all(r,info(r))}
  if(r.state==='play'){const s=sideOf(r);if(s.length<2)finish(r,s[0],true);else all(r,info(r))}}
async function finish(r,winner,forfeit){r.state='done';const secs=Math.round((Date.now()-r.start)/1000),res=[];
  for(const[u,p]of r.players){const win=p.side===winner,pt=win?(r.mode==='duel'?50:40):10;res.push({user:u,side:p.side,win,pts:pt});p.ws.room=null}
  all(r,{type:'end',winner,secs,forfeit:!!forfeit,results:res});setTimeout(()=>rooms.delete(r.code),60000);
  for(const x of res)await finishRec(x.user,{mode:r.mode,diff:r.diff,win:x.win,secs,pts:x.pts}).catch(()=>{})}
function handle(ws,m){const r=ws.room;
  if(m.type==='create'){if(!['duel','team'].includes(m.mode)||!BASE[m.diff])throw E('Tham số sai');leave(ws);
    let code;do code=crypto.randomBytes(3).toString('hex').slice(0,5).toUpperCase();while(rooms.has(code));
    const room={code,mode:m.mode,diff:m.diff,host:ws.user,players:new Map(),state:'lobby'};rooms.set(code,room);join(ws,room,'A')}
  else if(m.type==='join'){const room=rooms.get(String(m.code||'').toUpperCase());if(!room)throw E('Không tìm thấy phòng');join(ws,room,m.side)}
  else if(m.type==='side'&&r&&r.state==='lobby'&&r.mode==='team'&&['A','B'].includes(m.side)){r.players.get(ws.user).side=m.side;all(r,info(r))}
  else if(m.type==='leave')leave(ws);
  else if(m.type==='start'){if(!r||r.host!==ws.user||r.state!=='lobby')throw E('Không thể bắt đầu');
    const s=sideOf(r);if(s.length<2)throw E(r.mode==='duel'?'Cần đủ 2 người chơi':'Mỗi đội cần ít nhất 1 người');
    const g=gen(r.diff);r.puzzle=g.puzzle;r.sol=g.sol;r.boards={};s.forEach(x=>r.boards[x]=[...g.puzzle]);r.state='play';r.start=Date.now();
    r.players.forEach(p=>send(p.ws,{type:'start',puzzle:g.puzzle,board:r.boards[p.side],side:p.side}));progress(r)}
  else if(m.type==='move'){if(!r||r.state!=='play')return;const p=r.players.get(ws.user),i=m.i,v=m.v;
    if(!Number.isInteger(i)||i<0||i>80||!Number.isInteger(v)||v<0||v>9||r.puzzle[i])return;
    const b=r.boards[p.side];b[i]=v;r.players.forEach(q=>q.side===p.side&&q.ws!==ws&&send(q.ws,{type:'board',board:b}));progress(r);
    if(same(b,r.sol))finish(r,p.side)}}
wss.on('connection',async(ws,req)=>{const t=new URL(req.url,'http://x').searchParams.get('token'),u=t&&await redis.get('sess:'+t);
  if(!u)return ws.close(4001);ws.user=u;ws.alive=true;ws.on('pong',()=>ws.alive=true);
  ws.on('message',d=>{try{handle(ws,JSON.parse(d))}catch(e){send(ws,{type:'err',msg:e.message})}});ws.on('close',()=>leave(ws))});
setInterval(()=>wss.clients.forEach(w=>{if(!w.alive)return w.terminate();w.alive=false;w.ping()}),30000);
server.listen(process.env.PORT||3000,()=>console.log('Sudoku Arena chạy tại cổng',process.env.PORT||3000));
