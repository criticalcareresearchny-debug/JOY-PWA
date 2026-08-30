
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const GGL_SERVICE = '0000fffe-0000-1000-8000-00805f9b34fb';
const GGL_WRITE = '0000fe02-0000-1000-8000-00805f9b34fb';
const BATTERY_SERVICE = 'battery_service';
const BATTERY_LEVEL = 'battery_level';
const DEVICE_INFO_SERVICE = 'device_information';

const state = {
  profiles: [], profile: null, device: null, server: null, writeChar: null, batteryChar: null,
  relay: { url: localStorage.getItem('joyRelayUrl') || '', code:'', secret:'', proof:'', role:'none', cursor:0, clientId: crypto.randomUUID(), polling:false, online:false },
  permissions: {control:true,text:true,audio:true,video:false},
  messages: [], deferredInstall:null,
  call: {pc:null, stream:null, active:false, audioOnly:false, ptt:false, initiator:false, pendingOffer:null, iceServers:[{urls:'stun:stun.l.google.com:19302'}]},
  sync: {sound:null,music:null,lastWrite:0}
};
const logLines=[];

function log(msg){ const row=`${new Date().toLocaleTimeString()}  ${msg}`; logLines.push(row); if(logLines.length>400)logLines.shift(); renderLog(); console.log(row); }
function renderLog(){ const el=$('#diagnosticLog'); if(el) el.textContent=logLines.join('\n'); }
function toast(msg){ const el=$('#toast'); el.textContent=msg; el.classList.add('show'); clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.remove('show'),2400); }
function setGlobalStatus(text,connected=false){ const el=$('#globalStatus'); el.querySelector('span:last-child').textContent=text; el.classList.toggle('connected',connected); }
function base64Url(bytes){
  let s=''; bytes.forEach(b=>s+=String.fromCharCode(b));
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function base64UrlDecode(s){
  s=s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4)s+='=';
  const raw=atob(s); return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
function utf8B64(s){ return base64Url(new TextEncoder().encode(s)); }
function decodeUtf8B64(s){ return new TextDecoder().decode(base64UrlDecode(s)); }
function hex(bytes){ return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join(''); }
async function sha256Hex(s){ return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))); }
async function encrypt(secret,plain){
  const key=await crypto.subtle.importKey('raw',base64UrlDecode(secret),{name:'AES-GCM'},false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const enc=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(plain)));
  return `${base64Url(iv)}.${base64Url(enc)}`;
}
async function decrypt(secret,payload){
  const [a,b]=payload.split('.',2); if(!a||!b) throw new Error('Invalid encrypted payload');
  const key=await crypto.subtle.importKey('raw',base64UrlDecode(secret),{name:'AES-GCM'},false,['decrypt']);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:base64UrlDecode(a)},key,base64UrlDecode(b));
  return new TextDecoder().decode(plain);
}
function randomSecret(){ return base64Url(crypto.getRandomValues(new Uint8Array(32))); }
function randomCode(){
  const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const r=crypto.getRandomValues(new Uint8Array(6));
  return 'JOY-'+[...r].map(v=>alphabet[v%alphabet.length]).join('');
}
function relayUrl(){ return state.relay.url.replace(/\/+$/,''); }
async function request(path,{method='GET',form=null}={}){
  if(!/^https:\/\//i.test(relayUrl())) throw new Error('Relay URL must begin with https://');
  const opts={method,headers:{'Accept':'text/plain','Cache-Control':'no-store'}};
  if(form){opts.headers['Content-Type']='application/x-www-form-urlencoded;charset=UTF-8';opts.body=new URLSearchParams(form).toString();}
  const res=await fetch(relayUrl()+path,opts); const text=await res.text();
  if(!res.ok) throw new Error(`HTTP ${res.status}${text?': '+text:''}`); return text;
}
async function relayHealth(){
  const text=await request('/health'); state.relay.online=true; $('#diagRelay').textContent='online'; $('#relayStatus').textContent='Online';
  log(`Relay: ${text}`); return text;
}
async function rtcConfig(){
  try{
    const res=await fetch(relayUrl()+'/v1/rtc-config',{cache:'no-store'}); if(!res.ok)throw new Error();
    const cfg=await res.json(); if(Array.isArray(cfg.iceServers)&&cfg.iceServers.length) state.call.iceServers=cfg.iceServers;
    return cfg;
  }catch{ return {iceServers:state.call.iceServers,turnConfigured:false}; }
}
async function sendRelayPlain(plain){
  if(!state.relay.code||!state.relay.secret||!state.relay.proof) throw new Error('No active session');
  const envelope=state.relay.clientId+'~'+plain;
  const payload=await encrypt(state.relay.secret,envelope);
  return request('/v1/event',{method:'POST',form:{code:state.relay.code,proof:state.relay.proof,payload}});
}
async function pollRelay(){
  if(state.relay.polling) return; state.relay.polling=true;
  const loop=async()=>{
    if(!state.relay.polling)return;
    try{
      const text=await request(`/v1/events?code=${encodeURIComponent(state.relay.code)}&proof=${encodeURIComponent(state.relay.proof)}&after=${state.relay.cursor}`);
      if(text.trim()){
        for(const line of text.split('\n')){
          const tab=line.indexOf('\t'); if(tab<1)continue;
          const id=Number(line.slice(0,tab)); state.relay.cursor=Math.max(state.relay.cursor,id);
          await handleRelayPayload(line.slice(tab+1));
        }
      }
    }catch(e){ log('Relay poll: '+e.message); }
    setTimeout(loop,500);
  }; loop();
}
async function handleRelayPayload(payload){
  try{
    const env=await decrypt(state.relay.secret,payload); const i=env.indexOf('~'); if(i<1)return;
    const sender=env.slice(0,i); if(sender===state.relay.clientId)return;
    const plain=env.slice(i+1);
    if(plain.startsWith('MSG|')){
      if(state.permissions.text){ state.messages.push({mine:false,text:decodeUtf8B64(plain.slice(4)),time:Date.now()}); renderMessages(); }
    } else if(plain.startsWith('MASTER|')){
      if(state.permissions.control){ const pct=Math.max(0,Math.min(100,Number(plain.split('|')[1])||0)); await setMaster(pct,false); }
    } else if(plain.startsWith('PATTERN|')){
      if(state.permissions.control){ await sendPattern(Math.max(1,Number(plain.split('|')[1])||1)); }
    } else if(plain==='STOP'){
      if(state.permissions.control) await stopAll(false);
    } else if(plain.startsWith('VID|')){
      const p=plain.split('|',3), kind=p[1], data=decodeUtf8B64(p[2]||'');
      await receiveSignal(kind,data);
    }
  }catch(e){ log('Ignored unreadable relay event'); }
}

async function loadProfiles(){
  try{
    const r=await fetch('profiles/profiles.json',{cache:'no-store'}); const j=await r.json();
    state.profiles=j.profiles||[]; $('#profileCount').textContent=state.profiles.length; log(`Profile catalog loaded • schema ${j.schemaVersion} • ${state.profiles.length} profile(s)`);
  }catch(e){ log('Profile catalog unavailable: '+e.message); }
}
function matchProfileByName(name=''){
  const u=name.toUpperCase();
  return state.profiles.find(p=>(p.nameHints||[]).some(h=>u.includes(String(h).toUpperCase())))||null;
}
function capabilities(profile){
  if(!profile)return[]; const c=profile.capabilities||{}, out=[];
  if(c.zoneCount)out.push(`${c.zoneCount} zones`); if(c.patterns)out.push('patterns'); if(c.customModulation)out.push('custom modulation');
  if(c.heating)out.push('heat'); if(c.rotation)out.push('rotation'); if(c.suction)out.push('suction'); if(c.thrusting)out.push('thrust');
  if(c.musicSync)out.push('music'); if(c.soundSync)out.push('live sound'); if(c.remoteSessionCompatible)out.push('remote');
  return out;
}
function updateBluetoothSupport(){
  const ok=!!navigator.bluetooth; $('#bridgeBadge').textContent=ok?'Web Bluetooth ready':'Bluetooth bridge required';
  $('#bridgeBadge').style.color=ok?'#78f0bf':'#f4bc6b'; $('#bleSupportStat').textContent=ok?'ready':'needed'; $('#diagBle').textContent=ok?'ready':'blocked';
  log(ok?'Web Bluetooth API available':'Web Bluetooth API not available in this browser');
}

async function findDevice(){
  if(!navigator.bluetooth){
    toast('iPhone Safari needs a Bluetooth bridge/browser for direct device control.');
    log('Find device blocked: navigator.bluetooth unavailable'); return;
  }
  try{
    const device=await navigator.bluetooth.requestDevice({
      filters:[{services:[GGL_SERVICE]},{namePrefix:'DSJM'},{namePrefix:'BEST'},{namePrefix:'GGL'}],
      optionalServices:[GGL_SERVICE,'battery_service','device_information']
    });
    state.device=device; const byName=matchProfileByName(device.name||'');
    device.addEventListener('gattserverdisconnected',onDisconnected);
    setGlobalStatus('Connecting…'); log(`Selected BLE device: ${device.name||device.id}`);
    const server=await device.gatt.connect(); state.server=server;
    let profile=byName;
    try{
      const service=await server.getPrimaryService(GGL_SERVICE);
      const char=await service.getCharacteristic(GGL_WRITE);
      state.writeChar=char;
      profile=profile||state.profiles.find(p=>String(p.serviceUuid).toLowerCase()===GGL_SERVICE)||null;
      log('Verified GGL transport FFFE / FE02');
    }catch(e){
      state.writeChar=null; log('Expected GGL transport not verified: '+e.message);
    }
    state.profile=state.writeChar?profile:null;
    try{
      const bs=await server.getPrimaryService('battery_service');
      state.batteryChar=await bs.getCharacteristic('battery_level');
      await readBattery();
    }catch{}
    renderConnected();
    if(state.writeChar) await stopAll(false);
  }catch(e){ if(e.name!=='NotFoundError')log('BLE connect error: '+e.message); }
}
function onDisconnected(){ log('Bluetooth device disconnected'); state.server=state.writeChar=state.batteryChar=null; state.device=null; state.profile=null; renderConnected(); }
function renderConnected(){
  const connected=!!(state.device?.gatt?.connected && state.writeChar && state.profile);
  setGlobalStatus(connected?'Connected':'Disconnected',connected);
  $('#disconnectBtn').disabled=!state.device?.gatt?.connected;
  $('#masterSlider').disabled=!connected; $('#stopAllBtn').disabled=!connected;
  $('#homeDeviceName').textContent=state.device?.name||'No device connected';
  $('#homeProfile').textContent=state.profile?.displayName||(state.device?'Profile not verified':'Connect a compatible device to unlock controls.');
  $('#homeCompat').textContent=connected?'Compatible ✓':state.device?'Unverified':'Waiting';
  $('#profileBadge').textContent=state.profile?.displayName||'No profile';
  $('#diagProfile').textContent=state.profile?.id||'none';
  $('#selectedDeviceCard').classList.toggle('hidden',!state.device);
  if(state.device){$('#selectedDeviceName').textContent=state.device.name||'Unnamed device';$('#selectedDeviceStatus').textContent=connected?'GATT transport verified and controls unlocked.':'Device selected, but expected profile transport was not verified.';}
  const chips=$('#selectedCapabilities'); chips.innerHTML=''; capabilities(state.profile).forEach(x=>{const s=document.createElement('span');s.className='mini-pill';s.textContent=x;chips.appendChild(s)});
  buildControls();
}
function gglPacket(channel,value,pattern=false){
  const a=new Uint8Array(20);a[0]=channel;a[1]=0x12;a[2]=Math.max(0,Math.min(255,value));
  if(pattern){a[3]=0;a[4]=0x64;} return a;
}
async function writePacket(packet){
  if(!state.writeChar)throw new Error('Compatible device not connected');
  if(state.writeChar.writeValueWithoutResponse) await state.writeChar.writeValueWithoutResponse(packet);
  else await state.writeChar.writeValue(packet);
}
async function setMaster(percent,fromUi=true){
  percent=Math.max(0,Math.min(100,Number(percent)||0)); $('#masterSlider').value=percent; updateDial(percent);
  if(state.writeChar){const raw=Math.round(percent*2.55);await writePacket(gglPacket(state.profile.masterChannel||3,raw));log(`Master ${percent}% → raw ${raw}`);}
}
async function setZone(channel,percent){
  if(!state.writeChar)return; const raw=Math.round(Math.max(0,Math.min(100,percent))*2.55);await writePacket(gglPacket(channel,raw));log(`Zone ch${channel} ${percent}%`);
}
async function sendPattern(n){
  if(!state.writeChar)return; const channels=state.profile.channels||[1,2,5];
  for(const c of channels)await writePacket(gglPacket(c,n,true));
  log(`Pattern ${n} sent to ${channels.join(',')}`);
}
async function stopAll(fromUi=true){
  if(state.writeChar&&state.profile){
    for(const c of (state.profile.channels||[]))await writePacket(gglPacket(c,0));
    await writePacket(gglPacket(state.profile.masterChannel||3,0));
    log('STOP ALL sent');
  }
  $('#masterSlider').value=0;updateDial(0);
}
function updateDial(p){$('#masterValue').textContent=`${Math.round(p)}%`;$('#dial').style.background=`conic-gradient(var(--purple) ${p*3.6}deg,#262846 ${p*3.6}deg)`;}
function buildControls(){
  const host=$('#dynamicControls');host.innerHTML='';
  if(!state.profile||!state.writeChar){host.className='empty-state';host.textContent='JOY builds this area from the connected device profile.';return;}
  host.className='';
  const c=state.profile.capabilities||{};
  if(c.independentZones){
    (state.profile.channels||[]).forEach((ch,i)=>{
      const row=document.createElement('div');row.className='control-row';
      row.innerHTML=`<div class="control-title"><b>Zone ${i+1}</b><span>Channel ${ch}</span></div><input class="range" type="range" min="0" max="100" value="0"><strong>0%</strong>`;
      const slider=row.querySelector('input'),value=row.querySelector('strong');let timer;
      slider.oninput=()=>{value.textContent=slider.value+'%';clearTimeout(timer);timer=setTimeout(()=>setZone(ch,slider.value).catch(e=>log(e.message)),60)};
      host.appendChild(row);
    });
  }
  const extra=[['heating','Heat'],['rotation','Rotation'],['suction','Suction'],['thrusting','Thrust'],['leds','Lighting']];
  extra.forEach(([k,label])=>{if(c[k]){const d=document.createElement('div');d.className='mini-pill';d.textContent=label+' profile control';host.appendChild(d)}});
}
function buildPatterns(){
  const names=['Pulse','Wave','Rise','Tide','Echo','Burst','Flow','Spark','Drift','Rush'];
  const glyphs=['∿','〰','⌁','≈','∽','⋀','∿','⌁','〜','≋'];
  const host=$('#patterns');host.innerHTML='';
  names.forEach((name,i)=>{const b=document.createElement('button');b.className='pattern';b.disabled=!state.writeChar;b.innerHTML=`<div class="wave">${glyphs[i]}</div><b>${name}</b>`;b.onclick=()=>sendPattern(i+1).catch(e=>log(e.message));host.appendChild(b)});
}
async function readBattery(){
  if(!state.batteryChar){toast('Standard battery service not available.');return;}
  try{const v=await state.batteryChar.readValue();const p=v.getUint8(0);$('#homeBattery').classList.remove('hidden');$('#homeBattery').textContent=`Battery ${p}%`;log(`Battery ${p}%`);}catch(e){log('Battery read failed: '+e.message)}
}

function updatePermissions(){
  state.permissions.control=$('#allowControl').checked;state.permissions.text=$('#allowText').checked;state.permissions.audio=$('#allowAudio').checked;state.permissions.video=$('#allowVideo').checked;
}
async function createInvite(){
  try{
    saveRelayUrl(); await relayHealth();
    const code=randomCode(),secret=randomSecret(),proof=await sha256Hex(secret);
    await request('/v1/session/create',{method:'POST',form:{code,proof}});
    Object.assign(state.relay,{code,secret,proof,role:'owner',cursor:0});
    const payload=`JOY1:${code}:${secret}`;$('#inviteOutput').value=payload;$('#sessionStatus').textContent=`Owner session ready • ${code}`;pollRelay();log(`Created secure session ${code}`);
  }catch(e){toast(e.message);log('Create session failed: '+e.message)}
}
async function joinInvite(){
  try{
    saveRelayUrl();await relayHealth();
    const p=$('#inviteInput').value.trim().split(':',3);if(p.length!==3||p[0]!=='JOY1'||!/^JOY-[A-Z2-9]{6}$/.test(p[1]))throw new Error('Invalid JOY secure invite');
    const code=p[1],secret=p[2],proof=await sha256Hex(secret);
    await request('/v1/session/join',{method:'POST',form:{code,proof}});
    Object.assign(state.relay,{code,secret,proof,role:'partner',cursor:0});
    $('#sessionStatus').textContent=`Joined securely • ${code}`;pollRelay();await sendRelayPlain('SYS|JOINED');log(`Joined secure session ${code}`);
  }catch(e){toast(e.message);log('Join failed: '+e.message)}
}
function saveRelayUrl(){state.relay.url=$('#relayUrl').value.trim().replace(/\/+$/,'');localStorage.setItem('joyRelayUrl',state.relay.url)}
async function sendMessage(){
  const text=$('#messageInput').value.trim();if(!text)return;
  try{await sendRelayPlain('MSG|'+utf8B64(text));state.messages.push({mine:true,text,time:Date.now()});$('#messageInput').value='';renderMessages();}catch(e){toast(e.message)}
}
function renderMessages(){
  const h=$('#messageList');h.innerHTML='';
  if(!state.messages.length){h.innerHTML='<div class="empty-state">Messages will appear here.</div>';return;}
  state.messages.forEach(m=>{const d=document.createElement('div');d.className='msg'+(m.mine?' mine':'');d.innerHTML=`<div></div><small>${new Date(m.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</small>`;d.querySelector('div').textContent=m.text;h.appendChild(d)});h.scrollTop=h.scrollHeight;
}
async function endSession(){
  try{if(state.relay.code)await request('/v1/session/close',{method:'POST',form:{code:state.relay.code,proof:state.relay.proof}})}catch{}
  state.relay.polling=false;Object.assign(state.relay,{code:'',secret:'',proof:'',role:'none',cursor:0});state.messages=[];renderMessages();$('#sessionStatus').textContent='No active session.';$('#inviteOutput').value='';log('Partner session ended and revoked');
}
async function sendRemoteMaster(){try{await sendRelayPlain('MASTER|'+Math.round($('#remoteMaster').value));}catch(e){toast(e.message)}}

async function sendSignal(kind,data){ return sendRelayPlain(`VID|${kind}|${utf8B64(data||'')}`); }
async function receiveSignal(kind,data){
  if(kind==='hangup'){ if(state.call.active)await hangup(false);return; }
  if(!state.call.active && kind==='offer'){
    state.call.pendingOffer={kind,data};$('#incomingCall').classList.remove('hidden');$('#incomingTitle').textContent='Incoming private call';return;
  }
  if(!state.call.pc)return;
  const pc=state.call.pc;
  try{
    if(kind==='offer'){await pc.setRemoteDescription(JSON.parse(data));const ans=await pc.createAnswer();await pc.setLocalDescription(ans);await sendSignal('answer',JSON.stringify(pc.localDescription));}
    else if(kind==='answer')await pc.setRemoteDescription(JSON.parse(data));
    else if(kind==='ice')await pc.addIceCandidate(JSON.parse(data));
  }catch(e){log('Call signaling: '+e.message)}
}
async function startCall({audioOnly=false,ptt=false,initiator=true,offer=null}={}){
  if(!state.relay.code) return toast('Join or create a partner session first.');
  if(audioOnly&&!state.permissions.audio)return toast('Talk permission is disabled.');
  if(!audioOnly&&!state.permissions.video)return toast('Video permission is disabled.');
  try{
    const cfg=await rtcConfig();state.call.iceServers=cfg.iceServers||state.call.iceServers;
    const constraints={audio:true,video:audioOnly?false:{facingMode:'user'}};
    const stream=await navigator.mediaDevices.getUserMedia(constraints);
    const pc=new RTCPeerConnection({iceServers:state.call.iceServers});
    Object.assign(state.call,{pc,stream,active:true,audioOnly,ptt,initiator});
    stream.getTracks().forEach(t=>pc.addTrack(t,stream));
    if(ptt){const a=stream.getAudioTracks()[0];if(a)a.enabled=false;}
    $('#callOverlay').classList.remove('hidden');$('#remoteVideo').style.display=audioOnly?'none':'block';$('#localVideo').style.display=audioOnly?'none':'block';$('#audioOrb').classList.toggle('hidden',!audioOnly);$('#cameraCallBtn').classList.toggle('hidden',audioOnly);$('#pttCallBtn').classList.toggle('hidden',!ptt);$('#muteCallBtn').classList.toggle('hidden',ptt);
    $('#callTitle').textContent=ptt?'Push-to-talk':audioOnly?'Private Talk':'Private video';
    $('#callSubtitle').textContent=ptt?'Press and hold when you want to speak':'Peer-to-peer media • encrypted JOY signaling';
    if(!audioOnly)$('#localVideo').srcObject=stream;
    pc.ontrack=e=>{if(!audioOnly)$('#remoteVideo').srcObject=e.streams[0];$('#callStatus').textContent='Connected';};
    pc.onicecandidate=e=>{if(e.candidate)sendSignal('ice',JSON.stringify(e.candidate)).catch(()=>{})};
    pc.onconnectionstatechange=()=>$('#callStatus').textContent=pc.connectionState||'connecting';
    if(offer){await pc.setRemoteDescription(JSON.parse(offer.data));const ans=await pc.createAnswer();await pc.setLocalDescription(ans);await sendSignal('answer',JSON.stringify(pc.localDescription));}
    else if(initiator){const off=await pc.createOffer();await pc.setLocalDescription(off);await sendSignal('offer',JSON.stringify(pc.localDescription));}
  }catch(e){toast('Call could not start: '+e.message);log('Call error: '+e.message)}
}
async function hangup(notify=true){
  try{state.call.stream?.getTracks().forEach(t=>t.stop());state.call.pc?.close();}catch{}
  if(notify&&state.relay.code)try{await sendSignal('hangup','{}')}catch{}
  Object.assign(state.call,{pc:null,stream:null,active:false,pendingOffer:null});$('#callOverlay').classList.add('hidden');$('#incomingCall').classList.add('hidden');
}

async function setupAnalyserFromStream(stream){
  const ctx=new (window.AudioContext||window.webkitAudioContext)();await ctx.resume();const src=ctx.createMediaStreamSource(stream),an=ctx.createAnalyser();an.fftSize=256;src.connect(an);return{ctx,an,stream};
}
async function setupAnalyserFromAudio(audio){
  const ctx=new (window.AudioContext||window.webkitAudioContext)();await ctx.resume();const src=ctx.createMediaElementSource(audio),an=ctx.createAnalyser();an.fftSize=256;src.connect(an);an.connect(ctx.destination);return{ctx,an,audio};
}
function analyserLoop(obj,meter,sensitivity,kind){
  const data=new Uint8Array(obj.an.frequencyBinCount);let stopped=false;
  const tick=async()=>{
    if(obj.stopped)return;obj.an.getByteFrequencyData(data);let sum=0;for(const v of data)sum+=v*v;const rms=Math.sqrt(sum/data.length)/255;
    const pct=Math.max(0,Math.min(100,Math.round(rms*(Number(sensitivity.value)/100)*180)));meter.style.width=pct+'%';
    const now=performance.now();if(state.writeChar&&now-state.sync.lastWrite>120){state.sync.lastWrite=now;try{await setMaster(pct,false)}catch{}}
    requestAnimationFrame(tick);
  };tick();return obj;
}
async function startSoundSync(){
  if(!state.writeChar)return toast('Connect a compatible device first.');
  try{stopSoundSync();const stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});const obj=await setupAnalyserFromStream(stream);state.sync.sound=analyserLoop(obj,$('#soundMeter'),$('#soundSensitivity'),'sound');log('Live Sound Sync started');}catch(e){toast(e.message)}
}
function stopSoundSync(){const o=state.sync.sound;if(o){o.stopped=true;o.stream?.getTracks().forEach(t=>t.stop());o.ctx?.close();state.sync.sound=null;$('#soundMeter').style.width='0';log('Live Sound Sync stopped')}}
async function startMusicSync(){
  if(!state.writeChar)return toast('Connect a compatible device first.');
  const audio=$('#musicPlayer');if(!audio.src)return toast('Choose an audio file first.');
  try{stopMusicSync();const obj=await setupAnalyserFromAudio(audio);state.sync.music=analyserLoop(obj,$('#musicMeter'),$('#musicSensitivity'),'music');await audio.play();log('Music Sync started');}catch(e){toast(e.message)}
}
function stopMusicSync(){const o=state.sync.music;if(o){o.stopped=true;o.ctx?.close();state.sync.music=null;}$('#musicPlayer').pause();$('#musicMeter').style.width='0';}

function bind(){
  $$('.nav-btn').forEach(b=>b.onclick=()=>{$$('.nav-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');$$('.view').forEach(v=>v.classList.toggle('active',v.dataset.view===b.dataset.target));});
  $('#findDeviceBtn').onclick=findDevice;$('#disconnectBtn').onclick=()=>state.device?.gatt?.disconnect();
  $('#masterSlider').oninput=e=>{updateDial(e.target.value);clearTimeout(bind.mt);bind.mt=setTimeout(()=>setMaster(e.target.value).catch(x=>log(x.message)),70)};
  $('#stopAllBtn').onclick=()=>stopAll().catch(e=>log(e.message));
  $('#readBatteryBtn').onclick=readBattery;
  $('#relayUrl').value=state.relay.url;$('#relayUrl').onchange=saveRelayUrl;$('#testRelayBtn').onclick=async()=>{try{saveRelayUrl();const cfg=await rtcConfig();await relayHealth();$('#relayStatus').textContent=cfg.turnConfigured?'Online • TURN ready':'Online • STUN';}catch(e){$('#relayStatus').textContent='Offline';toast(e.message)}};
  $('#createInviteBtn').onclick=createInvite;$('#joinInviteBtn').onclick=joinInvite;$('#copyInviteBtn').onclick=()=>navigator.clipboard.writeText($('#inviteOutput').value).then(()=>toast('Invite copied'));
  ['allowControl','allowText','allowAudio','allowVideo'].forEach(id=>$('#'+id).onchange=updatePermissions);
  $('#sendMessageBtn').onclick=sendMessage;$('#messageInput').onkeydown=e=>{if(e.key==='Enter')sendMessage()};
  $('#remoteMaster').onchange=sendRemoteMaster;$('#remoteWaveBtn').onclick=()=>sendRelayPlain('PATTERN|2').catch(e=>toast(e.message));$('#remoteStopBtn').onclick=()=>sendRelayPlain('STOP').catch(e=>toast(e.message));$('#endSessionBtn').onclick=endSession;
  $('#talkBtn').onclick=()=>startCall({audioOnly:true,ptt:false,initiator:true});$('#pttBtn').onclick=()=>startCall({audioOnly:true,ptt:true,initiator:true});$('#videoBtn').onclick=()=>startCall({audioOnly:false,ptt:false,initiator:true});
  $('#acceptCallBtn').onclick=()=>{const p=state.call.pendingOffer;$('#incomingCall').classList.add('hidden');startCall({audioOnly:!state.permissions.video,ptt:false,initiator:false,offer:p})};$('#declineCallBtn').onclick=()=>{$('#incomingCall').classList.add('hidden');sendSignal('hangup','{}').catch(()=>{});state.call.pendingOffer=null};
  $('#hangupBtn').onclick=()=>hangup(true);$('#muteCallBtn').onclick=()=>{const t=state.call.stream?.getAudioTracks()[0];if(t){t.enabled=!t.enabled;$('#muteCallBtn').textContent=t.enabled?'Mute':'Unmute'}};
  $('#cameraCallBtn').onclick=()=>{const t=state.call.stream?.getVideoTracks()[0];if(t){t.enabled=!t.enabled;$('#cameraCallBtn').textContent=t.enabled?'Camera off':'Camera on'}};
  const ptt=$('#pttCallBtn'),pttState=on=>{const t=state.call.stream?.getAudioTracks()[0];if(t)t.enabled=on;ptt.textContent=on?'Talking…':'Hold to talk';};['pointerdown','touchstart'].forEach(ev=>ptt.addEventListener(ev,e=>{e.preventDefault();pttState(true)},{passive:false}));['pointerup','pointercancel','pointerleave','touchend'].forEach(ev=>ptt.addEventListener(ev,e=>{e.preventDefault();pttState(false)},{passive:false}));
  $('#musicFile').onchange=e=>{const f=e.target.files?.[0];if(f){URL.revokeObjectURL($('#musicPlayer').src);$('#musicPlayer').src=URL.createObjectURL(f)}};
  $('#musicSensitivity').oninput=e=>$('#musicSensitivityLabel').textContent=e.target.value+'%';$('#soundSensitivity').oninput=e=>$('#soundSensitivityLabel').textContent=e.target.value+'%';
  $('#startMusicSyncBtn').onclick=startMusicSync;$('#stopMusicSyncBtn').onclick=stopMusicSync;$('#startSoundSyncBtn').onclick=startSoundSync;$('#stopSoundSyncBtn').onclick=stopSoundSync;
  $('#copyDiagnosticsBtn').onclick=()=>navigator.clipboard.writeText(logLines.join('\n')).then(()=>toast('Diagnostics copied'));$('#clearDiagnosticsBtn').onclick=()=>{logLines.length=0;renderLog()};
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.deferredInstall=e;$('#installBtn').classList.remove('hidden')});$('#installBtn').onclick=async()=>{if(state.deferredInstall){state.deferredInstall.prompt();await state.deferredInstall.userChoice;state.deferredInstall=null;$('#installBtn').classList.add('hidden')}};
}
async function init(){
  bind();updateBluetoothSupport();updatePermissions();buildPatterns();updateDial(0);renderMessages();await loadProfiles();renderConnected();
  if('serviceWorker' in navigator){try{await navigator.serviceWorker.register('sw.js');log('PWA service worker registered')}catch(e){log('Service worker error: '+e.message)}}
  log('JOY Web/PWA v0.1 • Profile Schema v3');
}
init();
