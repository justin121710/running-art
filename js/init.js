/* Running Art — 免責聲明、地點搜尋、作品保存與分享連結、啟動。
   index.html 依序載入 js/theme.js → ui.js → route.js → edit.js → export.js → init.js，
   它們是一般的 <script>（不是 module），共用同一個全域範圍。 */
/* ---------- 免責聲明 ----------
   要不要在啟動時跳出，已經由 <body> 裡那段內嵌腳本決定了（早幾百毫秒）。
   這裡只接手「同意」與「再看一次」。 */
function openLegal(){ $('legalModal').hidden=false; }
$('legalOk').onclick=()=>{
  store.set(LEGAL_KEY,LEGAL_VER);
  const first=!$('legalModal').hidden && !S.offered;
  $('legalModal').hidden=true;
  if(first){ S.offered=true; offerRestore(); }
};
$('brand').onclick=openLegal;
$('brand').onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openLegal(); } };

/* ---------- 地點搜尋與定位 ----------
   Nominatim 的使用政策禁止「邊打邊查」的自動完成，所以只在按下搜尋（Enter）時查一次。 */
function toggleSearch(on){
  const box=$('searchBox');
  box.hidden=on==null?!box.hidden:!on;
  if(!box.hidden) setTimeout(()=>$('searchIn').focus(),30);
}
$('btnSearch').onclick=()=>toggleSearch();
$('searchForm').onsubmit=async e=>{
  e.preventDefault();
  const q=$('searchIn').value.trim();
  const ul=$('searchRes');
  if(!q) return;
  ul.innerHTML='';
  const li0=document.createElement('li'); li0.textContent=tx('搜尋中…','Searching…'); ul.appendChild(li0);
  let list=[];
  try{
    const ctrl=new AbortController(); const tm=setTimeout(()=>ctrl.abort(),9000);
    const r=await nominatimFetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6'+
      '&accept-language='+(EN()?'en':'zh-TW')+'&q='+encodeURIComponent(q),{signal:ctrl.signal});
    clearTimeout(tm);
    if(r.ok) list=await r.json();
  }catch(_){}
  ul.innerHTML='';
  if(!list.length){
    const li=document.createElement('li'); li.textContent=tx('找不到符合的地點','No matching places'); ul.appendChild(li);
    return;
  }
  list.forEach(it=>{
    const li=document.createElement('li');
    li.tabIndex=0;
    li.textContent=it.display_name;          // textContent：結果是外部資料，不能當 HTML 塞
    const go=()=>{
      const bb=(it.boundingbox||[]).map(Number);
      if(bb.length===4&&bb.every(isFinite)){
        const b=L.latLngBounds([bb[0],bb[2]],[bb[1],bb[3]]);
        map.fitBounds(b,{maxZoom:16});
      }else map.setView([+it.lat,+it.lon],16);
      toggleSearch(false);
    };
    li.onclick=go;
    li.onkeydown=ev=>{ if(ev.key==='Enter') go(); };
    ul.appendChild(li);
  });
};
$('btnLocate').onclick=()=>{
  if(!navigator.geolocation){ toast(tx('這個瀏覽器不支援定位','Location is not supported in this browser'),2000); return; }
  busy(tx('定位中…','Locating…'));
  navigator.geolocation.getCurrentPosition(
    p=>{ busy(''); map.setView([p.coords.latitude,p.coords.longitude],16); },
    ()=>{ busy(''); toast(tx('無法取得位置（可能沒有開啟定位權限）','Could not get your location (permission denied?)'),2600); },
    {enableHighAccuracy:true,timeout:10000,maximumAge:60000});
};

/* ---------- 作品保存與分享連結 ----------
   重新整理頁面以前會把畫好的圖全部弄丟。現在範圍、筆畫、起訖點存在本機，
   下次進站詢問要不要還原；也可以做成分享連結（資料全在網址 # 後面，不經過任何伺服器）。 */
const SESSION_KEY='runart_session';
const r6=v=>Math.round(v*1e6)/1e6;
function snapshotState(){
  if(!S.bounds) return null;
  return {v:1,
    b:[S.bounds.getSouth(),S.bounds.getWest(),S.bounds.getNorth(),S.bounds.getEast()].map(r6),
    s:S.strokes.map(st=>st.pts.map(p=>[r6(p.lat),r6(p.lng)])),
    a:S.start?[r6(S.start.lat),r6(S.start.lng)]:null,
    z:S.end?[r6(S.end.lat),r6(S.end.lng)]:null};
}
let _saveT=null;
function saveSession(){
  clearTimeout(_saveT);
  _saveT=setTimeout(()=>{
    const st=snapshotState();
    if(st&&st.s.length) store.set(SESSION_KEY,JSON.stringify(st));
    else if(st) store.del(SESSION_KEY);
  },400);
}
/* Google encoded polyline（精度 1e-5 ≈ 1m）：分享連結比 JSON 短很多 */
function encPoly(pts){
  let out='', pl=0, pn=0;
  const enc=v=>{ v=v<0?~(v<<1):(v<<1); let s=''; while(v>=0x20){ s+=String.fromCharCode((0x20|(v&0x1f))+63); v>>=5; } return s+String.fromCharCode(v+63); };
  pts.forEach(([la,ln])=>{ const a=Math.round(la*1e5), b=Math.round(ln*1e5); out+=enc(a-pl)+enc(b-pn); pl=a; pn=b; });
  return out;
}
function decPoly(str){
  const pts=[]; let i=0, la=0, ln=0;
  const dec=()=>{ let r=0, sh=0, b; do{ b=str.charCodeAt(i++)-63; r|=(b&0x1f)<<sh; sh+=5; }while(b>=0x20&&i<=str.length); return (r&1)?~(r>>1):(r>>1); };
  while(i<str.length){ la+=dec(); ln+=dec(); pts.push([la/1e5,ln/1e5]); }
  return pts;
}
function shareURL(){
  const st=snapshotState(); if(!st) return null;
  const f=a=>a?a.map(v=>v.toFixed(5)).join(','):'';
  // polyline 字元在 63..126 之間，用 ',' 分隔各筆畫不會撞到
  const h='v1;b='+st.b.map(v=>v.toFixed(5)).join(',')+';a='+f(st.a)+';z='+f(st.z)+
          ';s='+st.s.map(encPoly).map(encodeURIComponent).join(',');
  return location.origin+location.pathname+'#'+h;
}
function parseShare(hash){
  if(!hash.startsWith('#v1;')) return null;
  const kv={};
  hash.slice(4).split(';').forEach(p=>{ const k=p.indexOf('='); if(k>0) kv[p.slice(0,k)]=p.slice(k+1); });
  const nums=t=>t?t.split(',').map(Number):null;
  const b=nums(kv.b);
  if(!b||b.length!==4||!b.every(isFinite)) return null;
  const pt=t=>{ const v=nums(t); return v&&v.length===2&&v.every(isFinite)?v:null; };
  let s=[];
  try{ s=(kv.s||'').split(',').filter(Boolean).map(x=>decPoly(decodeURIComponent(x))).filter(x=>x.length>1); }
  catch(_){ return null; }
  return {v:1,b,s,a:pt(kv.a),z:pt(kv.z)};
}
/* 還原一份狀態：先載入範圍（通常有快取、不必連網），再把筆畫與起訖點放回去。 */
async function restoreState(st,fromLink){
  clearAll();
  const bounds=L.latLngBounds([st.b[0],st.b[1]],[st.b[2],st.b[3]]);
  map.fitBounds(bounds);
  try{ await loadBounds(bounds); }catch(_){ return; }
  st.s.forEach(pts=>{
    const ll=pts.map(p=>L.latLng(p[0],p[1]));
    S.strokes.push({pts:ll,line:L.polyline(ll,{color:PC().draw,weight:5,opacity:.95}).addTo(map)});
  });
  if(st.a) S.start=L.latLng(st.a[0],st.a[1]);
  if(st.z) S.end=L.latLng(st.z[0],st.z[1]);
  refreshSEMarkers(); refresh(); saveSession();
  toast(fromLink?tx('已載入分享的圖案，按「生成路線」就能產生路線','Shared drawing loaded — tap Generate to make the route')
                :tx('已還原上次的圖案','Your last drawing was restored'),2600);
}
function offerRestore(){
  const link=parseShare(location.hash||'');
  if(link){
    history.replaceState(null,'',location.pathname+location.search);   // 重新整理時不要再載一次
    restoreState(link,true);
    return;
  }
  let saved=null;
  try{ saved=JSON.parse(store.get(SESSION_KEY)||'null'); }catch(_){}
  if(saved&&saved.v===1&&saved.b&&saved.s&&saved.s.length&&
     confirm(tx('要還原上次畫的圖案嗎？','Restore the drawing from your last visit?'))) restoreState(saved,false);
}
$('aShare').onclick=async()=>{
  const url=shareURL(); if(!url) return;
  try{
    if(navigator.share){ await navigator.share({title:'Running Art',url}); return; }
  }catch(e){ if(e&&e.name==='AbortError') return; }
  try{ await navigator.clipboard.writeText(url); toast(tx('分享連結已複製','Share link copied'),1800); }
  catch(_){ prompt(tx('複製這個連結：','Copy this link:'),url); }
};

/* Service Worker：Pyodide 與本站檔案的快取（見 sw.js）。只在安全來源（https、localhost）啟用。 */
if('serviceWorker' in navigator && window.isSecureContext)
  navigator.serviceWorker.register('sw.js').catch(()=>{});

function busy(t){const b=$('busy');
  if(t){if(EN()&&PROG_EN[t]) t=PROG_EN[t]; $('busyTxt').textContent=t;b.classList.add('on');}
  else b.classList.remove('on');
  // 生成路線時可以取消（例如路線太長算太久）。運算在 Worker 裡，畫面不會卡住。
  $('busyCancel').hidden=!(t&&S.generating);
  // 進度膠囊出現／消失時，步驟 1 的引導框要重新讓位
  if(S.step===1&&!el.guide.classList.contains('hide')) positionGuide();}
$('busyCancel').onclick=()=>Engine.cancel();
Engine.setProgress(busy);
Engine.boot().then(()=>toast(tx('運算引擎已就緒','Engine ready'))).catch(e=>toast(tx('引擎載入失敗：','Engine load failed: ')+e.message,3000));

applyLang();
setMode('pan');guide();refresh();
// 免責聲明還開著的話，等使用者按「同意」之後才問要不要還原（見 legalOk）
if($('legalModal').hidden){ S.offered=true; offerRestore(); }
