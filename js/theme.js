/* Running Art — 地圖、底圖來源、深淺主題、配色、方向箭頭的造型。
   index.html 依序載入 js/theme.js → ui.js → route.js → edit.js → export.js → init.js，
   它們是一般的 <script>（不是 module），共用同一個全域範圍。 */
/* localStorage 一律經過 store：瀏覽器封鎖儲存空間時（Chrome「封鎖所有 Cookie」、
   部分 WebView、iframe 嵌入）存取會直接丟 SecurityError，以前會中斷整段主程式，
   畫面只剩地圖、所有按鈕都沒反應。讀不到就當作沒存過。 */
const store={
  get(k){ try{ return localStorage.getItem(k); }catch(_){ return null; } },
  set(k,v){ try{ localStorage.setItem(k,v); }catch(_){} },
  del(k){ try{ localStorage.removeItem(k); }catch(_){} }
};
const map=L.map('map',{zoomControl:false,attributionControl:false}).setView([25.0610,121.5330],16);
L.control.attribution({prefix:false,position:'bottomright'}).addTo(map);


/* Favicon 用 logo_dark.svg：它自己帶深色圓角底，
   在淺色與深色的瀏覽器分頁列上都看得清楚。 */

/* ---------- 深／淺色主題 ---------- */
/* ---------- 底圖圖磚來源 ----------
   CARTO 從 2026-09 起不再提供免金鑰的點陣圖磚：沒帶 key 的請求回 403，
   圖上印滿「API KEY REQUIRED」。到 https://carto.com/basemaps/apikey 免費申請
   （不需要帳號），填進 CARTO_KEY 就會用回原本的 dark_all / light_all。
   申請時把網站限制設成 justin121710.github.io（本機測試再加 localhost），
   這樣 key 就算從原始碼被抄走，在別的網域也不能用。

   沒填 key、或 key 失效（過期、額度用完、網域不符）時，自動改用 OpenStreetMap
   官方圖磚：免金鑰，深色模式用濾鏡反轉。失效是靠啟動時 fetch 一顆圖磚看狀態碼
   判斷的（probeTiles）——<img> 遇到 403 照樣會把浮水印畫出來、不會觸發
   tileerror，只聽 Leaflet 的事件抓不到。 */
const CARTO_KEY='cb1_4t1b_1_44f40e55112b9c2415eb4506';
const TILE_PROVIDERS={
  carto:{
    leaflet:light=>`https://{s}.basemaps.cartocdn.com/${light?'light_all':'dark_all'}/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(CARTO_KEY)}`,
    url:(z,x,y,light,i)=>`https://${'abcd'[i%4]}.basemaps.cartocdn.com/${light?'light_all':'dark_all'}/${z}/${x}/${y}@2x.png?key=${encodeURIComponent(CARTO_KEY)}`,
    hd:true, maxNativeZoom:19,
    // CARTO dark_all 的道路偏暗，提亮讓街道看得清楚；light_all 本來就亮
    filter:{light:'none', dark:'brightness(2.3) contrast(0.92)'},
    emul:{light:null, dark:{bright:2.3}},     // 不支援 ctx.filter 時的替代畫法（見 paintTiles）
    attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
    credit:'© OpenStreetMap contributors © CARTO'
  },
  osm:{
    leaflet:()=>'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    url:(z,x,y)=>`https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    hd:false, maxNativeZoom:19,               // 沒有 @2x，匯出時改抓下一級縮放補清晰度
    filter:{light:'none', dark:'invert(1) hue-rotate(180deg) brightness(0.95) contrast(0.9)'},
    emul:{light:null, dark:{invert:true}},
    attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    credit:'© OpenStreetMap contributors'
  }
};
let tileProvider=CARTO_KEY?'carto':'osm';
const TP=()=>TILE_PROVIDERS[tileProvider];
/* 只有 CARTO 需要驗：OSM 不用 key。網路錯誤也當成失敗——
   CARTO 的 403 不一定帶 CORS 標頭，那時 fetch 會直接丟 TypeError、看不到狀態碼；
   反正 OSM 一定能用，誤判的代價只是底圖換一種樣式。 */
async function probeTiles(){
  if(tileProvider!=='carto') return;
  let ok=false;
  try{
    const ctrl=new AbortController(); const tm=setTimeout(()=>ctrl.abort(),8000);
    const r=await fetch(TP().url(2,3,1,isLight(),0),{mode:'cors',credentials:'omit',signal:ctrl.signal});
    clearTimeout(tm);
    ok=r.ok;
  }catch(_){ ok=!navigator.onLine; }   // 離線時哪家都抓不到，不必換
  if(ok) return;
  console.warn('CARTO 圖磚驗證失敗（key 無效、過期或網域不符），改用 OpenStreetMap 圖磚');
  tileProvider='osm';
  applyBaseLayer();
}
let baseLayer=null, areaMask=null, areaRect=null;
function isLight(){return document.body.classList.contains('light');}

/* ---------- 配色 ----------
   顏色只定義在 CSS 的 --rt-* 變數裡（見檔頭），這裡把它讀出來給 Canvas 和 Leaflet 用，
   免得同一個顏色在 CSS 和 JS 各寫一份、改配色時漏掉一邊。
   getComputedStyle 不便宜，所以快取起來，只在換主題時失效重讀。 */
const RT_KEYS=['done','pending','connector','draw','guide','arrow','runner','runner-out',
               'start','finish','elev','elev-dim','node','node-turn','node-sel',
               'ui','ui-text','ui-ink','on-accent'];
let _pal=null;
function PC(){
  if(!_pal){
    const cs=getComputedStyle(document.body);
    _pal={};
    RT_KEYS.forEach(k=>{ _pal[k]=cs.getPropertyValue('--rt-'+k).trim()||'#888'; });
  }
  return _pal;
}
function palInvalidate(){ _pal=null; }
/* #RRGGBB → rgba(...)。Canvas 的漸層要帶透明度，但配色是用 hex 存的。 */
function hexA(hex,a){
  const h=(hex||'').trim().replace('#','');
  if(h.length<6) return 'rgba(128,128,128,'+a+')';
  return 'rgba('+parseInt(h.slice(0,2),16)+','+parseInt(h.slice(2,4),16)+','
         +parseInt(h.slice(4,6),16)+','+a+')';
}

/* ---------- 方向箭頭造型 ----------
   幾何只寫一次，地圖的 SVG 圖示和匯出的 Canvas 都從這裡長出來——
   以前兩邊各寫一份，結果地圖是青色的 >、匯出卻是金色的，形狀和顏色都對不起來。
   座標是正規化的：箭頭指向 +X，大致落在 ±1 之內，實際大小由 base 決定。
   w 是描邊粗細，同樣以 base 為單位。 */
const ARROW_STYLES={
  chevron:{ name:'單箭頭', en:'Chevron', shapes:[
    {pts:[[-0.70,-0.70],[0.70,0],[-0.70,0.70]], closed:false, mode:'stroke', w:0.42}]},
  double:{ name:'雙箭頭', en:'Double', shapes:[
    {pts:[[-0.98,-0.60],[-0.20,0],[-0.98,0.60]], closed:false, mode:'stroke', w:0.34},
    {pts:[[-0.05,-0.60],[0.73,0],[-0.05,0.60]], closed:false, mode:'stroke', w:0.34}]},
  triangle:{ name:'實心三角', en:'Triangle', shapes:[
    {pts:[[-0.55,-0.76],[0.86,0],[-0.55,0.76]], closed:true, mode:'fill'}]},
  dart:{ name:'後掠飛鏢', en:'Dart', shapes:[
    {pts:[[0.95,0],[-0.72,-0.84],[-0.34,0],[-0.72,0.84]], closed:true, mode:'fill'}]},
  streak:{ name:'速度尾線', en:'Streak', shapes:[
    {pts:[[-0.22,-0.66],[0.64,0],[-0.22,0.66]], closed:false, mode:'stroke', w:0.40},
    {pts:[[-1.02,0],[-0.56,0]], closed:false, mode:'stroke', w:0.26}]}
};
/* 轉角圓角半徑（正規化單位，箭頭本身大約 ±1）。
   小 = 銳利。用「幾何上把轉角換成一段二次貝茲」來做，而不是靠 lineJoin:'round'
   —— 後者的圓角半徑等於線寬的一半，改不動，箭頭尖端會鈍掉。 */
let arrowRadius=parseFloat(store.get('runart_arrow_r'));
if(!(arrowRadius>=0)) arrowRadius=0.10;

/* 白箭頭完全靠陰影襯出輪廓，而淺色模式的需求比深色高得多：
   白箭頭疊在淺色未跑路線（#B6C0CB，亮度 192）上只有 1.84:1，
   深色的未跑路線本來就暗，陰影只是輔助。

   實測在 12px 的匯出箭頭上，陰影讓周圍最暗降到：
     .70 / blur 0.60 / 1 次 → 150（只比底色暗 42，幾乎看不出暈）
     .85 / blur 0.75 / 2 次 →  98（明顯的暗暈）
   **兩次是關鍵**：只畫一次的話，alpha 調到 1.0 也只到 132——
   陰影的最深值受限於單次繪製的衰減，疊第二次才會加深。 */
const ARROW_SHADOW={
  dark : {color:'rgba(0,0,0,.70)', blurK:0.60, passes:1},
  light: {color:'rgba(0,0,0,.85)', blurK:0.75, passes:2}
};

let arrowStyle=store.get('runart_arrow')||'dart';
if(!ARROW_STYLES[arrowStyle]) arrowStyle='dart';

/* 把折點換成小圓角。回傳一串 {t:'M'|'L'|'Q'|'Z'} 指令，
   Canvas 和 SVG 共用同一份結果，兩邊才不會長得不一樣。
   開放折線的頭尾不倒角（那是端點不是轉角）。 */
function arrowGeom(shape,r){
  const pts=shape.pts, n=pts.length, closed=!!shape.closed, out=[];
  const sub=(a,b)=>[a[0]-b[0],a[1]-b[1]];
  const len=v=>Math.hypot(v[0],v[1])||1e-9;
  const at=(b,v,k)=>[b[0]+v[0]/len(v)*k, b[1]+v[1]/len(v)*k];
  let started=false;
  for(let i=0;i<n;i++){
    const B=pts[i];
    const corner=closed || (i>0 && i<n-1);
    if(!corner){ out.push({t:started?'L':'M',p:B}); started=true; continue; }
    const A=pts[(i-1+n)%n], C=pts[(i+1)%n];
    const vA=sub(A,B), vC=sub(C,B);
    const d=Math.min(r, len(vA)/2, len(vC)/2);
    out.push({t:started?'L':'M', p:at(B,vA,d)}); started=true;
    out.push({t:'Q', c:B, p:at(B,vC,d)});
  }
  if(closed) out.push({t:'Z'});
  return out;
}
function arrowShapes(){ return (ARROW_STYLES[arrowStyle]||ARROW_STYLES.chevron).shapes; }
function arrowSVGPath(shape,r){
  return arrowGeom(shape,r).map(g=>
    g.t==='Z' ? 'Z'
    : g.t==='Q' ? `Q ${g.c[0].toFixed(4)} ${g.c[1].toFixed(4)} ${g.p[0].toFixed(4)} ${g.p[1].toFixed(4)}`
    : `${g.t} ${g.p[0].toFixed(4)} ${g.p[1].toFixed(4)}`).join(' ');
}


// 地圖上的箭頭圖示：viewBox 用正規化座標，所以 d 不用重算，換大小只改 size
function arrowIcon(dir,size){
  const s=size||26, col=PC().arrow;
  const inner=arrowShapes().map(sh=>{
    const d=arrowSVGPath(sh,arrowRadius);
    return sh.mode==='fill'
      ? '<path d="'+d+'" fill="'+col+'" stroke="'+col+'" stroke-width="0.08" stroke-linejoin="miter"/>'
      : '<path d="'+d+'" fill="none" stroke="'+col+'" stroke-width="'+sh.w+'"'
        +' stroke-linecap="round" stroke-linejoin="miter"/>';
  }).join('');
  return L.divIcon({className:'',iconSize:[s,s],iconAnchor:[s/2,s/2],
    html:'<svg width="'+s+'" height="'+s+'" viewBox="-1.5 -1.5 3 3" '
        +'style="transform:rotate('+dir+'deg);overflow:visible;'
        +'filter:'+(isLight()
            ? 'drop-shadow(0 0 1.4px rgba(0,0,0,.85)) drop-shadow(0 0 2.6px rgba(0,0,0,.6))'
            : 'drop-shadow(0 0 1.6px rgba(0,0,0,.7))')+'">'+inner+'</svg>'});
}
// 換配色或換造型後，把已經放在地圖上的箭頭重畫（它們是建立時就固定的 divIcon）
function pvRestyleArrows(){
  if(!S_arrowList) return;
  S_arrowList.forEach(a=>{ if(a.mk&&a.dir!=null) a.mk.setIcon(arrowIcon(a.dir)); });
}
function applyBaseLayer(){
  if(baseLayer) baseLayer.remove();
  const tp=TP(), light=isLight();
  baseLayer=L.tileLayer(tp.leaflet(light),{maxZoom:19,maxNativeZoom:tp.maxNativeZoom,
    subdomains:'abcd',attribution:tp.attribution}).addTo(map);
  baseLayer.bringToBack();
  // 濾鏡跟著「來源 × 主題」走，直接寫在 pane 上，蓋過 CSS 的 --tile-filter
  map.getPane('tilePane').style.filter=tp.filter[light?'light':'dark'];
  // 已下載範圍的遮罩顏色也要隨主題（淺色用淺灰遮罩、深色用近黑）
  if(areaMask) areaMask.setStyle({fillColor:isLight()?'#8a96a6':'#05070a'});
  // 範圍框虛線：亮色底圖用黑、深色底圖用白
  if(areaRect) areaRect.setStyle({color:isLight()?'#000':'#fff'});
}
function setTheme(light,save=true){
  document.body.classList.toggle('light',light);
  palInvalidate();          // --rt-* 換了一組值，快取要丟掉
  try{ $('brandLogo').src = light ? 'logo_bright.svg' : 'logo_dark.svg'; }catch(_){}
  if(save) store.set('runart_theme',light?'light':'dark');
  applyBaseLayer();
  // 小人外框跟主題重繪。try 包住：初始化時本函式會在 pvHead（let）
  // 宣告前被呼叫，落在暫時死區（TDZ）—— 連 typeof 都會拋 ReferenceError、
  // 中斷整個 script。那時還沒有小人，跳過即可。
  try{ if(pvHead) pvPose(!!S.pvActive); }catch(_){}
  // 已經畫在地圖上的圖層不會自己跟著 CSS 變數走，要手動重上色
  const P=PC();
  try{ if(S.strokes) S.strokes.forEach(st=>st.line&&st.line.setStyle({color:P.draw})); }catch(_){}
  try{ if(S.curLine) S.curLine.setStyle({color:P.draw}); }catch(_){}
  try{ if(pvDone) pvDone.setStyle({color:P.done}); }catch(_){}
  try{ if(S.result) applyResult(S.result,false); }catch(_){}
  try{ refreshSEMarkers(); }catch(_){}
  try{ if(S.editing) editBuild(); }catch(_){}
  try{ if(elevChartData) renderElevChart(elevChartData); }catch(_){}
  try{ pvRestyleArrows(); }catch(_){}   // 箭頭是固定的 divIcon，不重設就會留著舊配色
}
// 初始主題：記住的優先，否則跟隨系統設定
(function(){
  const saved=store.get('runart_theme');
  const light=saved?saved==='light':window.matchMedia('(prefers-color-scheme: light)').matches;
  setTheme(light,false);
})();
document.getElementById('btnTheme').onclick=()=>setTheme(!isLight());
probeTiles();

