/* Running Art — 中英文、狀態、引導提示、框選下載、畫圖與起訖點的操作。
   index.html 依序載入 js/theme.js → ui.js → route.js → edit.js → export.js → init.js，
   它們是一般的 <script>（不是 module），共用同一個全域範圍。 */
/* ---------- 中英文切換（i18n） ----------
   靜態文字用 HTML 的 data-en 屬性；動態字串（toast / 進度 / 引導 / 匯出）查下面的表。
   toast() 與 busy() 會自動把中文原字換成英文，所以大多數呼叫端不用改。 */
let lang = store.get('runart_lang') || ((navigator.language||'').toLowerCase().startsWith('zh')?'zh':'en');
const EN=()=>lang==='en';
const tx=(zh,en)=>EN()?en:zh;   // 有插值的字串用這個選字

const STEPS_I18N={
 zh:{
  1:['先框選要載入的地圖範圍','點右上角 <b>載入地圖範圍</b>，然後在地圖上拖曳一個方框'],
  2:['畫出你想要的圖案','點下方 <b>畫圖</b>，在<b>藍色框線內</b>畫。畫錯可以按復原'],
  3:['設定起點與終點','點 <b>起點</b> 後在地圖上點一下，終點同理'],
  4:['準備好了','按 <b>生成路線</b>，把圖案對齊到真實道路'],
  5:['完成','可下載 GPX 或圖片。要改圖案請按 <b>修改圖案</b>']
 },
 en:{
  1:['Choose an area to load','Tap <b>Load Map</b> (top-right), then drag a box on the map'],
  2:['Draw your shape','Tap <b>Draw</b> and draw inside the <b>blue box</b>. Undo if needed'],
  3:['Set start & finish','Tap <b>Start</b> then tap the map; same for Finish'],
  4:['Ready','Tap <b>Generate</b> to snap your shape onto real roads'],
  5:['Done','Save a GPX or image. Tap <b>Edit Shape</b> to change the drawing']
 }
};
const TOASTS_EN={
 '在地圖上拖曳一個方框':'Drag a box on the map',
 '請在藍色框線內畫圖':'Please draw inside the blue box',
 '超出已下載範圍':'Outside the loaded area',
 '起點／終點要在藍色框線內':'Start / finish must be inside the blue box',
 '起點已設定':'Start set','終點已設定':'Finish set',
 '可以繼續修改圖案，改完再按生成路線':'Edit your shape, then tap Generate again',
 '已清空，重新開始畫':'Cleared — start drawing again',
 '已反轉方向':'Direction reversed',
 '橘色大點是轉彎處。點一下節點選取，或用「框選」一次選多個':'Orange dots are turns. Tap a node to select, or use Box Select for many',
 '拖曳框住要刪除的節點':'Drag a box over the nodes to delete',
 '改回點擊選取，可拖曳地圖':'Back to tap-select; you can pan the map',
 '刪掉這些節點後找不到別條路可以繞過去，已自動復原。試著把整段繞路一起框選刪除。':'No alternative road to detour around — auto-reverted. Try box-selecting the whole detour.',
 '無法刪除：這一段剩下的點太少了。':'Cannot delete: too few nodes left in this segment.',
 '已重新沿道路接好':'Re-routed along the roads',
 '沒有可復原的步驟':'Nothing to undo',
 'GPX 已下載':'GPX downloaded','運算引擎已就緒':'Engine ready',
 '地圖下載失敗：目前公用伺服器（Overpass）都很忙碌。請縮小範圍、或等一兩分鐘再試。已下載過的範圍會被記住，可以離線重用。':'Map load failed: the public Overpass servers are all busy. Try a smaller area or wait a minute. Loaded areas are remembered and reusable offline.',
 '這個範圍抓不到可跑的道路（伺服器可能回了空資料）。請換個地點、把範圍放大一點或稍後再試。':'No runnable roads found here (the server may have returned empty data). Try another spot, enlarge the area, or retry later.'
};
const PROG_EN={
 '載入運算引擎…':'Loading engine…','載入數學與路網套件…':'Loading math & graph packages…',
 '載入演算法…':'Loading algorithm…','下載路網…':'Loading roads…',
 '伺服器忙碌，改用之前下載過的地圖…':'Servers busy — using a previously saved map…',
 '伺服器忙碌，重試中…':'Servers busy, retrying…','使用已下載的地圖…':'Using saved map…',
 '建立路網…':'Building road network…','對齊道路中…':'Snapping to roads…',
 '重新接路中…':'Re-routing…','產生圖片…':'Creating image…','查詢地點…':'Finding location…',
 '下載底圖…':'Loading base map…',
 '底圖受限，改產生無底圖版本…':'Base map blocked — creating no-basemap version…'
};
const PACE_NAMES={zh:['競速','慢跑','輕鬆跑','快走'],en:['Fast','Jog','Easy','Brisk']};
const EXP_LABELS={zh:['距離','配速','預估時間','總爬升／下降'],en:['Distance','Pace','Est. time','Total Elev.']};

function updateDlLabel(){
  // 尚未載入地圖時顯示提示字；載入後由既有流程顯示面積，不覆寫
  if(!S.hasMap && !S.boxing) $('dlLabel').textContent = tx('載入地圖範圍','Load Map');
}
function applyLang(){
  document.querySelectorAll('[data-en]').forEach(eln=>{
    if(eln.dataset.zh==null) eln.dataset.zh=eln.textContent;
    eln.textContent = EN()?eln.dataset.en:eln.dataset.zh;
  });
  document.querySelectorAll('[data-ph-en]').forEach(eln=>{
    if(eln.dataset.phZh==null) eln.dataset.phZh=eln.placeholder;
    eln.placeholder = EN()?eln.dataset.phEn:eln.dataset.phZh;
  });
  document.documentElement.lang = EN()?'en':'zh-Hant';
  $('btnLang').textContent = EN()?'中':'EN';
  store.set('runart_lang',lang);
  guide(); paceUI(); updateDlLabel();
  if(S.result&&S.elevGain!=null) $('sElev').textContent='↑'+S.elevGain+' ↓'+S.elevLoss+' m';
}
document.getElementById('btnLang').onclick=()=>{ lang=EN()?'zh':'en'; applyLang(); };

const S={mode:'pan',hasMap:false,strokes:[],cur:null,start:null,end:null,
         boxing:false,generated:false,sheetUp:false,step:1,bounds:null,warned:0,
         editing:false,ebox:false,eDown:null,sel:new Set(),locked:false};
const $=id=>document.getElementById(id);
const el={guide:$('guide'),gn:$('gn'),gt:$('gt'),pill:$('pill'),sheet:$('sheet'),toast:$('toast')};
let routeLayer=null,startMk=null,endMk=null,boxEl=null,boxA=null;

function guide(){
  const s=STEPS_I18N[lang][S.step];
  // 結果面板升起時，引導條與距離膠囊都讓位，避免互相遮擋
  if(S.sheetUp||!s){el.guide.classList.add('hide');return;}
  el.guide.classList.remove('hide');
  el.gn.textContent=S.step;
  el.gt.innerHTML='<b>'+s[0]+'</b><br>'+s[1];
  positionGuide();
}
/* 把引導提示框放到「當前步驟要按的那顆按鈕」旁邊，操作更直覺。
   頂部按鈕→放下方；桌面左側工具列→放右邊；手機底部工具列→放上方。 */
const GUIDE_TARGET={1:'btnDl',2:'mDraw',3:'mStart',4:'btnGo'};
function positionGuide(){
  const g=el.guide;
  g.style.position=g.style.left=g.style.right=g.style.top=g.style.bottom=g.style.width=g.style.maxWidth='';
  if(!S.step) return;

  if(S.step===1){
    const btn=$('btnDl');
    if(!btn) return;
    const r=btn.getBoundingClientRect();
    if(!r.width) return;
    g.style.position='fixed';g.style.right='auto';g.style.bottom='auto';
    g.style.width='auto';
    const gw=Math.min(300, window.innerWidth-24);
    g.style.maxWidth=gw+'px';
    const gh=g.offsetHeight, gwA=Math.min(g.offsetWidth,gw), M=10;
    const top=r.bottom+M;
    const left=Math.min(r.right-gwA, window.innerWidth-gwA-12);
    g.style.left=Math.max(12,left)+'px'; g.style.top=Math.max(12,top)+'px';
    return;
  }

  // 步驟 2, 3, 4 定位在工具欄 (mainDock) 左右側，確保絕不遮擋工具欄
  const dock=$('mainDock');
  if(!dock) return;
  const d=dock.getBoundingClientRect();
  if(!d.width) return;

  g.style.position='fixed';g.style.right='auto';g.style.bottom='auto';g.style.width='auto';
  const gw=Math.min(270, window.innerWidth*0.65);
  g.style.maxWidth=gw+'px';g.style.left='0px';g.style.top='0px';

  const gh=g.offsetHeight, gwA=Math.min(g.offsetWidth,gw);
  let left, top;

  if(S.step===2){
    // 2 號放工具欄左側
    if(d.left >= gwA + 16){
      left = d.left - gwA - 12;
      top = d.top + (d.height - gh)/2;
    }else{
      left = Math.max(12, d.left);
      top = d.top - gh - 10;
    }
  }else{
    // 3, 4 號放工具欄右側
    if(window.innerWidth - d.right >= gwA + 16){
      left = d.right + 12;
      top = d.top + (d.height - gh)/2;
    }else{
      left = Math.min(window.innerWidth - gwA - 12, d.right - gwA);
      top = d.top - gh - 10;
    }
  }

  top = Math.max(12, Math.min(top, window.innerHeight - gh - 12));
  left = Math.max(12, Math.min(left, window.innerWidth - gwA - 12));
  g.style.left = left+'px'; g.style.top = top+'px';
}
// 高程圖不再需要對齊拉桿（它自己就是拉桿），圖上元素也全用百分比定位，縮放不必重畫
window.addEventListener('resize',()=>{ if(!el.guide.classList.contains('hide')) positionGuide(); updatePillPos(); });
function toast(t,ms=1500){
  if(EN()&&TOASTS_EN[t]) t=TOASTS_EN[t];   // 已知中文字串自動換英文
  el.toast.textContent=t;el.toast.classList.add('show');
  setTimeout(()=>el.toast.classList.remove('show'),ms);
}
// 把「已下載範圍」永久標示在底圖上：框線 + 框外變暗，
// 使用者一眼就知道自己能畫到哪裡。
function showArea(b){
  const W=[[90,-180],[90,180],[-90,180],[-90,-180]];
  const hole=[b.getNorthWest(),b.getNorthEast(),b.getSouthEast(),b.getSouthWest()];
  if(areaMask) areaMask.remove();
  if(areaRect) areaRect.remove();
  areaMask=L.polygon([W,hole],{stroke:false,fillColor:isLight()?'#8a96a6':'#05070a',
    fillOpacity:.72,interactive:false}).addTo(map);
  areaRect=L.rectangle(b,{color:isLight()?'#000':'#fff',weight:2,dashArray:'7 5',fill:false,interactive:false}).addTo(map);
}

/* 量出「浮在地圖上的 UI」實際吃掉哪幾邊，讓 fitBounds 把範圍塞進真正看得見的區域。
   以前是寫死的 [30,64]/[30,110]，但引導提示框會依步驟與版面換位置
   （手機貼在工具列上方、桌面在工具列左邊），寫死的數字擋不住它——
   實際回報：載入完成後，步驟 2 的提示框正好蓋住白色的範圍框。

   作法：把每個浮動元素和地圖容器求交集，看它離哪一邊最近就算成那一邊的邊距。
   例如貼著底部的提示框 → 底部要留 (地圖下緣 − 提示框上緣)。 */
/* 用選擇器而不是 id：頂部那條是 .top，沒有 id——寫成 $('top') 會拿到 null
   然後被靜靜跳過，頂部按鈕就完全沒被算進邊距裡。 */
const FLOATERS=['.top','#guide','#mainDock','#pill'];
function mapInsets(gap=12){
  const mr=mc.getBoundingClientRect();
  const ins={top:0,right:0,bottom:0,left:0};
  FLOATERS.forEach(sel=>{
    const eln=document.querySelector(sel);
    if(!eln||eln.hidden) return;
    const cs=getComputedStyle(eln);
    // 看不見或不吃事件的（例如 hide 掉的引導條、框選時退場的工具列）不算
    if(cs.display==='none'||cs.visibility==='hidden'||parseFloat(cs.opacity)<0.05) return;
    const r=eln.getBoundingClientRect();
    if(!r.width||!r.height) return;
    const ov={l:Math.max(r.left,mr.left), r:Math.min(r.right,mr.right),
              t:Math.max(r.top,mr.top),  b:Math.min(r.bottom,mr.bottom)};
    if(ov.r<=ov.l||ov.b<=ov.t) return;          // 根本沒疊在地圖上
    /* 從四邊各算一次「要留多少才能完全避開它」，取最小的那一邊。
       不能用「離哪一邊最近」：手機上引導條貼在工具列上方、左邊只差 12px，
       會被判成左側，於是 375px 寬的畫面被吃掉 267px，範圍框縮成一條。
       改成比較所需的邊距，同一個引導條會正確地算成「底部留 214」。 */
    const need={top:ov.b-mr.top, bottom:mr.bottom-ov.t,
                left:ov.r-mr.left, right:mr.right-ov.l};
    const side=Object.keys(need).reduce((a,k)=>need[k]<need[a]?k:a,'top');
    ins[side]=Math.max(ins[side],need[side]+gap);
  });
  // 邊距吃掉太多會讓 fitBounds 算出荒謬的縮放，各軸合計最多 70%
  const capX=mr.width*0.7, capY=mr.height*0.7;
  if(ins.left+ins.right>capX){const k=capX/(ins.left+ins.right);ins.left*=k;ins.right*=k;}
  if(ins.top+ins.bottom>capY){const k=capY/(ins.top+ins.bottom);ins.top*=k;ins.bottom*=k;}
  return ins;
}
/* 把視野拉到已載入的範圍，並閃開所有浮在上面的 UI。
   一定要在 refresh() 之後呼叫：引導條要先跳到步驟 2 的位置，量到的才是它真正的落點。 */
function fitArea(b){
  const i=mapInsets();
  map.fitBounds(b,{paddingTopLeft:[Math.round(i.left),Math.round(i.top)],
                   paddingBottomRight:[Math.round(i.right),Math.round(i.bottom)]});
}
function inArea(ll){return !S.bounds||S.bounds.contains(ll);}

function setMode(m){
  if(m!=='pan'&&!S.hasMap) return;
  // 生成後鎖住編輯，要先按「修改圖案」或「重新繪製」才能再動
  if(m!=='pan'&&S.locked) return;
  S.mode=m;
  document.querySelectorAll('.m').forEach(b=>b.classList.toggle('on',b.dataset.mode===m));
  // 模式切換：只有「移動」模式能拖曳地圖
  if(m==='pan'){map.dragging.enable();}else{map.dragging.disable();}
  map.getContainer().style.cursor = m==='pan'?'grab':'crosshair';
}
document.querySelectorAll('.m').forEach(b=>b.onclick=()=>setMode(b.dataset.mode));

/* 拖曳畫框（下載範圍與微調框選共用） */
function boxBegin(e){
  boxA=[e.clientX,e.clientY];
  boxEl=document.createElement('div');boxEl.className='box';document.body.appendChild(boxEl);
  /* 抓住這個指標：接下來的 pointermove／pointerup 一律送回地圖容器，
     就算放開手時停在某個浮在地圖上的 UI（工具列、引導條、頂部按鈕）也一樣。
     沒有這行的話那些元素會把 pointerup 吃掉——事件不會冒泡到地圖容器，
     因為它們是 #map 的兄弟不是子孫——框選就收不了尾，框會留在畫面上。
     兩個呼叫端（框選下載、微調框選）都已經把 map.dragging 關掉，不會打架。 */
  try{ mc.setPointerCapture(e.pointerId); }catch(_){}
}
/* 收不了尾時的清場：把還沒完成的框丟掉，不留殘影 */
function boxAbort(){
  boxA=null;
  if(boxEl){boxEl.remove();boxEl=null;}
}
function boxDrag(e){
  if(!boxA||!boxEl) return;
  const x=Math.min(boxA[0],e.clientX),y=Math.min(boxA[1],e.clientY);
  boxEl.style.cssText+=`;left:${x}px;top:${y}px;width:${Math.abs(e.clientX-boxA[0])}px;height:${Math.abs(e.clientY-boxA[1])}px`;
  /* 框選下載範圍時即時顯示面積與預估下載時間；超過上限框會變紅。
     以前框多大都照下，太大就逾時，或者路網大到演算法變慢，使用者不知道為什麼。 */
  if(S.boxing&&!S.editing){
    const r=mc.getBoundingClientRect();
    const km2=boxAreaKm2(boxA[0]-r.left,boxA[1]-r.top,e.clientX-r.left,e.clientY-r.top);
    const over=km2>MAX_AREA_KM2;
    boxEl.classList.toggle('over',over);
    boxEl.textContent=km2.toFixed(km2<10?2:0)+' km²'+(over
      ? tx('（上限 '+MAX_AREA_KM2+'）',' (max '+MAX_AREA_KM2+')')
      : tx(' · 約 ',' · ~')+Math.round(DL_FIXED_S+DL_S_PER_KM2*km2)+tx(' 秒',' s'));
  }
}
/* 範圍上限與下載時間估算（依實測校準：0.27km²≈8.6s、2.3km²≈12s、15.1km²≈59s） */
const MAX_AREA_KM2=6, DL_FIXED_S=7, DL_S_PER_KM2=3.5;
function boxAreaKm2(x0,y0,x1,y1){
  const a=map.containerPointToLatLng([x0,y0]), b=map.containerPointToLatLng([x1,y1]);
  return map.distance(a,L.latLng(a.lat,b.lng))/1000*map.distance(a,L.latLng(b.lat,a.lng))/1000;
}
/* 收框，回傳 {x0,y0,x1,y1}（相對地圖容器）；沒在畫框就回傳 null */
function boxEnd(e){
  if(!boxA) return null;
  try{ mc.releasePointerCapture(e.pointerId); }catch(_){}
  const a=boxA;boxA=null;
  if(boxEl){boxEl.remove();boxEl=null;}
  const r=mc.getBoundingClientRect();
  return {x0:Math.min(a[0],e.clientX)-r.left, y0:Math.min(a[1],e.clientY)-r.top,
          x1:Math.max(a[0],e.clientX)-r.left, y1:Math.max(a[1],e.clientY)-r.top};
}

/* 讓膠囊浮在「目前這個」工具列上方。
   以前寫死量 mainDock —— 但進微調模式後 mainDock 是 hidden、量到寬度 0 就直接 return，
   膠囊停在 CSS 預設的 88px，而 editDock 有 108px 高，實測會壓到按鈕 32px。 */
function updatePillPos(){
  const dock = (S.editing && !$('editDock').hidden) ? $('editDock') : $('mainDock');
  if(!dock || dock.hidden) return;
  const d = dock.getBoundingClientRect();
  if(!d.width) return;
  const bottomDist = Math.max(88, Math.round(window.innerHeight - d.top + 14));
  el.pill.style.bottom = bottomDist + 'px';
}
window.addEventListener('resize', updatePillPos);

function refresh(){
  if(S.editing) return;   // 微調模式有自己的一套按鈕與提示
  const n=S.strokes.length;
  $('btnUndo').disabled=!n||S.locked; $('btnClear').disabled=!n||S.locked;
  $('btnGo').disabled=!(n&&S.start&&S.end)||S.locked||!!S.generating;
  ['mDraw','mStart','mEnd'].forEach(i=>$(i).disabled=!S.hasMap||S.locked);
  if(S.locked&&S.mode!=='pan') setMode('pan');

  // 取消修改按鈕：只有在先前有生成結果、且目前退回修改圖案模式時顯示
  if($('btnCancelMod')){
    $('btnCancelMod').style.display = (S.prevResult && !S.sheetUp) ? 'flex' : 'none';
  }

  let d=0;
  for(const s of S.strokes) for(let i=1;i<s.pts.length;i++) d+=map.distance(s.pts[i-1],s.pts[i]);
  if(S.result&&!S.sheetUp){
    // 生成後不能再畫圖，在工具列上方顯示「查看路線結果」按鈕讓使用者點擊叫回
    el.pill.classList.remove('hide');
    el.pill.textContent=tx('▲ 查看路線結果 (','▲ View Result (')+S.km.toFixed(2)+' km)';
    el.pill.classList.add('tap');
    updatePillPos();
  }else if(n&&!S.sheetUp){
    el.pill.classList.remove('hide');
    el.pill.textContent=(d/1000).toFixed(2)+' km';
    el.pill.classList.remove('tap');
    updatePillPos();
  }else{
    el.pill.classList.add('hide');
    el.pill.classList.remove('tap');
  }
  // 引導自動推進，不需要使用者點「下一步」
  let st=1;
  if(S.hasMap) st=2;
  if(S.hasMap&&n) st=3;
  if(S.hasMap&&n&&S.start&&S.end) st=4;
  if(S.generated) st=5;
  if(st!==S.step){S.step=st;guide();}
  if(S.hasMap) saveSession();
}

/* ---------- 框選下載 ---------- */
/* 下載並載入一個範圍（框選、還原上次的圖案、開分享連結共用）。 */
let islandLayer=null;
function loadBounds(bounds){
  const km=(map.distance(bounds.getNorthWest(),bounds.getNorthEast())/1000)
         *(map.distance(bounds.getNorthWest(),bounds.getSouthWest())/1000);
  $('dlLabel').textContent=tx('載入中…','Loading…');
  return Engine.loadArea(bounds.getSouth(),bounds.getWest(),bounds.getNorth(),bounds.getEast())
    .then(st=>{
      S.hasMap=true;S.bounds=bounds;
      showArea(bounds);
      showIslands(st.islands||[]);
      $('dlLabel').textContent=km.toFixed(1)+' km²';
      ['mDraw','mStart','mEnd'].forEach(i=>$(i).disabled=false);
      toast(tx('路網已載入（'+st.nodes+' 個路口）','Roads loaded ('+st.nodes+' junctions)'));setMode('draw');refresh();
      if(st.islands&&st.islands.length)
        setTimeout(()=>toast(tx('灰色虛線框裡的道路沒有連到主要路網（例如橋沒畫進地圖），在那裡畫的圖會被拉到最近的連通道路',
                                'Roads inside the grey dashed areas are not connected to the main network; drawings there will snap to the nearest connected road'),4200),1600);
      // 視野最後才拉：refresh() 會把引導條推到步驟 2 並重新定位，
      // 先拉的話量到的是它舊的位置，範圍框還是會被蓋住。
      fitArea(bounds);
      saveSession();
      return st;
    })
    .catch(err=>{busy('');updateDlLabel();toast(err.message,3000);throw err;});
}
/* 主路網以外的孤立區域（橋沒畫進 OSM 的河濱公園之類）。以前被靜靜丟掉，
   使用者在那裡畫圖，路線會被吸到很遠的地方卻不知道為什麼。 */
function showIslands(list){
  if(islandLayer){islandLayer.remove();islandLayer=null;}
  if(!list.length) return;
  islandLayer=L.layerGroup(list.map(pts=>L.polygon(pts,{color:'#9aa3ad',weight:1.5,dashArray:'4 4',
    fillColor:'#9aa3ad',fillOpacity:.18,interactive:false}))).addTo(map);
}
/* 框選模式的開關集中在這裡：狀態、按鈕外觀、地圖拖曳、以及讓底部工具列退場
   （body.boxing，見檔頭 CSS）。以前開跟關寫在兩個地方，關的那邊少做了幾件事。 */
function setBoxing(on){
  S.boxing=on;
  $('btnDl').classList.toggle('on',on);
  document.body.classList.toggle('boxing',on);
  map.dragging[on?'disable':'enable']();
  if(!on) boxAbort();      // 離開框選就不該再留著半途的框
}
$('btnDl').onclick=()=>{
  setBoxing(!S.boxing);
  $('dlLabel').textContent=S.boxing?tx('取消框選','Cancel'):tx('載入地圖範圍','Load Map');
  if(S.boxing) toast('在地圖上拖曳一個方框',1800);
};
const mc=map.getContainer();
mc.addEventListener('pointerdown',e=>{
  if(S.editing){
    S.eDown=[e.clientX,e.clientY];
    if(S.ebox){ boxBegin(e); return; }
    // 按在節點上＝可能要拖曳它。先記下來，等移動超過門檻才真的開始拖。
    const hit=editHitNode(map.mouseEventToLatLng(e));
    if(hit>=0){
      S.eDragIdx=hit; S.eDragging=false;
      map.dragging.disable();          // 拖節點時不要連地圖一起拖
      ghostLoad(nodeMks[hit]);
    }
    return;
  }
  if(S.boxing){
    boxBegin(e);
    return;
  }
  if(S.mode==='draw'&&S.hasMap){
    const ll=map.mouseEventToLatLng(e);
    if(!inArea(ll)){toast('請在藍色框線內畫圖');return;}
    S.cur=[ll];
    S.curLine=L.polyline(S.cur,{color:PC().draw,weight:5,opacity:.95}).addTo(map);
  }
});
mc.addEventListener('pointermove',e=>{
  if(S.editing){
    if(S.ebox){ boxDrag(e); return; }
    if(S.eDragIdx!=null&&S.eDown){
      if(!S.eDragging&&Math.hypot(e.clientX-S.eDown[0],e.clientY-S.eDown[1])>8)
        S.eDragging=true;
      if(S.eDragging) ghostHighlight(map.mouseEventToLatLng(e));
    }
    return;
  }
  if(S.boxing){
    boxDrag(e);
    return;
  }
  if(S.mode==='draw'&&S.cur){
    const ll=map.mouseEventToLatLng(e);
    if(!inArea(ll)){
      if(Date.now()-S.warned>1600){S.warned=Date.now();toast('超出已下載範圍');}
      return;
    }
    S.cur.push(ll);S.curLine.setLatLngs(S.cur);
  }
});
mc.addEventListener('pointerup',e=>{
  if(S.editing){
    const d=S.eDown;S.eDown=null;
    if(S.ebox){
      const r=boxEnd(e);
      if(r) editBoxSelect(r);
      return;
    }
    if(S.eDragIdx!=null){
      const idx=S.eDragIdx, dragging=S.eDragging;
      S.eDragIdx=null; S.eDragging=false;
      map.dragging.enable();
      if(dragging){ editDropNode(idx,map.mouseEventToLatLng(e)); return; }
      ghostClear();
    }
    // 移動超過 8px 視為在拖曳地圖，不當成點選節點
    if(d&&Math.hypot(e.clientX-d[0],e.clientY-d[1])<=8) editPick(map.mouseEventToLatLng(e));
    return;
  }
  if(S.boxing&&boxA){
    const r=boxEnd(e);
    if(r&&r.x1-r.x0>30&&r.y1-r.y0>30){
      const km2=boxAreaKm2(r.x0,r.y0,r.x1,r.y1);
      if(km2>MAX_AREA_KM2){
        toast(tx('範圍太大（'+km2.toFixed(1)+' km²），請縮小到 '+MAX_AREA_KM2+' km² 以內',
                 'Area too large ('+km2.toFixed(1)+' km²). Please keep it under '+MAX_AREA_KM2+' km²'),2600);
        return;   // 留在框選模式，直接再框一次
      }
      const p1=map.containerPointToLatLng([r.x0,r.y0]);
      const p2=map.containerPointToLatLng([r.x1,r.y1]);
      setBoxing(false);           // 框好了就離開框選模式，工具列跟著回來
      loadBounds(L.latLngBounds(p1,p2)).catch(()=>{});
    }
    return;
  }
  if(S.mode==='draw'&&S.cur){
    if(S.cur.length>3) S.strokes.push({pts:S.cur,line:S.curLine});
    else{ S.curLine.remove(); toast(tx('筆畫太短，已略過','Stroke too short — ignored'),1200); }
    S.cur=null;S.curLine=null;refresh();
  }
});
/* 指標被系統中斷（手機的返回手勢、拖出視窗外放開…）時，pointerup 不一定會來。
   lostpointercapture 一定會來，而正常收尾時 boxEnd 已經把 boxA 清成 null，
   所以「這時候 boxA 還在」就代表框沒收成，直接清掉免得留下殘影。 */
mc.addEventListener('pointercancel',boxAbort);
mc.addEventListener('lostpointercapture',()=>{ if(boxA) boxAbort(); });

// 起終點標記：綠圈內 ▶＝起點、紅圈內 ■＝終點（比兩個不同色的圓點好辨識）。
// 地圖與匯出圖片用同一套語意（綠=start、紅=stop）。
function seIcon(isStart){
  const P=PC();
  const bg=isStart?P.start:P.finish;
  const fg=P['on-accent'];
  const glyph=isStart
    ? '<path d="M9.5 7 L17 12 L9.5 17 Z" fill="'+fg+'"/>'
    : '<rect x="8.3" y="8.3" width="7.4" height="7.4" rx="1.2" fill="'+fg+'"/>';
  return L.divIcon({className:'',iconSize:[28,28],iconAnchor:[14,14],
    html:'<svg width="28" height="28" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">'
      +'<circle cx="12" cy="12" r="10.4" fill="'+bg+'" stroke="'+fg+'" stroke-width="2.4"/>'+glyph+'</svg>'});
}
/* 起點和終點落在同一個位置時（繞一圈回到原點很常見），兩個圖釘會完全重疊、
   只看得到後畫的那個。改成合成一顆：左半用起點、右半用終點。 */
let _seUid=0;
function seIconMerged(){
  const P=PC(), fg=P['on-accent'];
  const id='se'+(++_seUid);   // clipPath 的 id 在整份文件裡要唯一，否則會references 到別人的
  return L.divIcon({className:'',iconSize:[28,28],iconAnchor:[14,14],
    html:'<svg width="28" height="28" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">'
      +'<defs>'
      +'<clipPath id="'+id+'L"><rect x="0" y="0" width="12" height="24"/></clipPath>'
      +'<clipPath id="'+id+'R"><rect x="12" y="0" width="12" height="24"/></clipPath>'
      +'</defs>'
      +'<g clip-path="url(#'+id+'L)">'
        +'<circle cx="12" cy="12" r="10.4" fill="'+P.start+'" stroke="'+fg+'" stroke-width="2.4"/>'
        +'<path d="M9.5 7 L17 12 L9.5 17 Z" fill="'+fg+'"/></g>'
      +'<g clip-path="url(#'+id+'R)">'
        +'<circle cx="12" cy="12" r="10.4" fill="'+P.finish+'" stroke="'+fg+'" stroke-width="2.4"/>'
        +'<rect x="8.3" y="8.3" width="7.4" height="7.4" rx="1.2" fill="'+fg+'"/></g>'
      +'</svg>'});
}
// 起訖點是否落在同一處（吸附到同一個節點後座標會完全相同）
function seSamePoint(){
  return !!(S.start && S.end && map.distance(S.start,S.end) < 2);
}
/* 重畫起訖點圖釘。重疊時只放一顆合成的，否則各放各的。 */
function refreshSEMarkers(){
  if(startMk){startMk.remove();startMk=null;}
  if(endMk){endMk.remove();endMk=null;}
  const opt={interactive:false,zIndexOffset:900};
  if(seSamePoint()){
    startMk=L.marker(S.start,Object.assign({icon:seIconMerged()},opt)).addTo(map);
    return;
  }
  if(S.start) startMk=L.marker(S.start,Object.assign({icon:seIcon(true)},opt)).addTo(map);
  if(S.end)   endMk  =L.marker(S.end,  Object.assign({icon:seIcon(false)},opt)).addTo(map);
}
/* 把使用者點的位置吸附到最近的路網節點。
   點在建築物或公園中間的話，solve_route 反正也要把它拉到路上；
   當下就吸附的好處是使用者馬上看得到真正的起點在哪，不會以為自己選的是那個點。
   引擎還沒載好或還沒下載路網時就沿用原座標，不擋住操作。 */
async function snapLatLng(ll){
  try{
    const n=await Engine.snapToNode(ll.lat,ll.lng);
    if(n) return L.latLng(n[0],n[1]);
  }catch(_){}
  return ll;
}
map.on('click',async e=>{
  if(S.editing) return;   // 微調模式的點選由 pointerup 處理
  const isStart=S.mode==='start', isEnd=S.mode==='end';
  if(!isStart&&!isEnd) return;
  if(!inArea(e.latlng)){ toast('起點／終點要在藍色框線內');return; }

  const my=S.snapSeq=(S.snapSeq||0)+1;
  const ll=await snapLatLng(e.latlng);
  if(my!==S.snapSeq) return;   // 連點兩下時，先點的那次較晚回來，不能蓋掉後點的
  // 吸附後仍要在範圍內，否則寧可用原座標（邊緣點可能被吸到框外的節點）
  const use=inArea(ll)?ll:e.latlng;
  const moved=map.distance(e.latlng,use);
  if(isStart) S.start=use; else S.end=use;
  refreshSEMarkers();
  toast(moved>=8
    ? tx((isStart?'起點':'終點')+'已吸附到最近的道路（'+Math.round(moved)+' 公尺）',
         (isStart?'Start':'Finish')+' snapped to the nearest road ('+Math.round(moved)+' m)')
    : tx((isStart?'起點':'終點')+'已設定',(isStart?'Start':'Finish')+' set'));
  refresh();
});

$('btnUndo').onclick=()=>{const s=S.strokes.pop();if(s)s.line.remove();refresh();};
function clearAll(){
  S.strokes.forEach(s=>s.line.remove());S.strokes=[];
  S.prevResult=null;   // 不清的話，清空後還能按「取消修改」叫回一條沒有手繪線的舊路線
  // 清空畫布時，起點與終點也一併清掉
  if(startMk){startMk.remove();startMk=null;} S.start=null;
  if(endMk){endMk.remove();endMk=null;} S.end=null;
  dropRoute();
  refresh();
}
/* 丟掉生成結果，回到可編輯狀態（手繪線保留） */
function dropRoute(){
  if(routeLayer){routeLayer.remove();routeLayer=null;}
  pvClear();S.path=null;S.result=null;
  S.elevGain=null;S.elevLoss=null;$('sElev').textContent='–';
  S.generated=false;S.locked=false;
  S.sheetUp=false;el.sheet.classList.remove('up');
}
$('btnClear').onclick=clearAll;

