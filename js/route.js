/* Running Art — 路線預覽（跑者、箭頭、高程圖拉桿）、配速、生成與生成後的動作。
   index.html 依序載入 js/theme.js → ui.js → route.js → edit.js → export.js → init.js，
   它們是一般的 <script>（不是 module），共用同一個全域範圍。 */
/* ---------- 生成（原型：假資料） ---------- */
/* ---------- 路線預覽（拉桿 + 方向） ---------- */
let pvDone=null,pvHead=null,pvArrows=null,pvTimer=null,poseT=null;
/* 預覽的「跑者」圖示：靜止＝站立、拖曳／播放中＝雙手舉高。SVG 自己畫，深淺底圖都清楚。 */
/* ---- 跑者小人的幾何（地圖 SVG 與匯出 Canvas 共用同一份）----
   單位 u，總高 24u（頭心到腳底）。採用「粗壯」比例。

   幾個刻意的設計：
   · 沒有脖子。圓頭 → 一段空隙（headGap）→ 平的軀幹頂，
     所以軀幹一定要用 butt cap；用 round 的話圓端會往上凸出半個線寬（3.2u），
     直接把空隙填滿、頭和身體會黏成一塊。
   · 手臂接在軀幹頂面的肩膀處，而且**兩種姿勢共用同一個肩膀支點**——
     跑步舉手就是繞著這個點轉，不會有手臂憑空長在腰上的感覺。
   · 手臂用 round cap，端點是半圓，所以肩膀是圓的、不會出現尖角。
     支點刻意比軀幹頂低 shoulderDrop，圓端才不會凸得太高。
   · 兩腿：legX ± legW/2 的外緣正好是 ±3.2u ＝ 軀幹半寬，
     中間縫隙 2×legX − legW = 0.8u。 */
const RUNNER={
  headR:3.2, headFromFoot:24, headGap:1.8,
  hipFromFoot:10.5, torsoW:6.4,
  /* shoulderDrop 要夠深：手臂的圓端會往上凸出半個線寬（1.5u），
     太淺的話圓端會伸進頭下方的空隙裡，把「沒有脖子」的縫隙填掉。
     1.3 之後實際空白帶還有 1.6u，縮到圖示大小仍看得見。 */
  shoulderX:2.6, shoulderDrop:1.3, armW:3.0,
  /* 立正的手要離身體夠遠才看得出來：軀幹半寬 3.2u、手臂半寬 1.5u，
     手心距 4.2u 時手臂外緣在 5.7u，露出軀幹外 2.5u。
     原本 2.8u 只露出 1.1u，遠看像沒有手臂。 */
  armHandXStand:4.2, armHandYStand:1.2,
  /* 跑步的手臂加長：沿著和原本幾乎相同的斜率（約 -0.76）往外延伸，
     所以手臂變長但不會更靠近頭。長度 3.78u → 5.78u。 */
  armHandXRun:6.8, armHandRiseRun:3.5,
  legW:2.8, legX:1.8, legXRun:3.8
};
/* 回傳畫這個小人需要的所有線段（每段各自有線寬與端點樣式）＋頭的位置。 */
function runnerParts(x,footY,u,active){
  const R=RUNNER;
  const headY=footY-R.headFromFoot*u, hr=R.headR*u;
  const torsoTop=headY+hr+R.headGap*u;      // 空隙之後才是平的身體頂
  const hipY=footY-R.hipFromFoot*u;
  const shY=torsoTop+R.shoulderDrop*u;      // 肩膀支點
  const sx=R.shoulderX*u;
  const arms=active
    ? [[[x-sx,shY],[x-R.armHandXRun*u,shY-R.armHandRiseRun*u]],
       [[x+sx,shY],[x+R.armHandXRun*u,shY-R.armHandRiseRun*u]]]
    : [[[x-sx,shY],[x-R.armHandXStand*u,hipY+R.armHandYStand*u]],
       [[x+sx,shY],[x+R.armHandXStand*u,hipY+R.armHandYStand*u]]];
  const lx=R.legX*u, ly=hipY+0.4*u;
  const legs=active
    ? [[[x-lx,ly],[x-R.legXRun*u,footY]],[[x+lx,ly],[x+R.legXRun*u,footY]]]
    : [[[x-lx,ly],[x-lx,footY]],[[x+lx,ly],[x+lx,footY]]];
  return {headY,hr,parts:[
    {w:R.torsoW, cap:'butt',  seg:[[x,torsoTop],[x,hipY]]},
    {w:R.armW,   cap:'round', seg:arms[0]},
    {w:R.armW,   cap:'round', seg:arms[1]},
    {w:R.legW,   cap:'round', seg:legs[0]},
    {w:R.legW,   cap:'round', seg:legs[1]}
  ]};
}

/* 地圖上的跑者圖示。viewBox 用 1u = 1 單位，腳底放在 y=30 ＝ iconAnchor 的位置。 */
function personSVG(active){
  const P=PC();
  const g=runnerParts(15,30,1,active);
  const layer=(color,extra)=>g.parts.map(p=>
      '<path d="M'+p.seg[0][0]+' '+p.seg[0][1]+' L'+p.seg[1][0]+' '+p.seg[1][1]
      +'" fill="none" stroke="'+color+'" stroke-width="'+(p.w+extra)
      +'" stroke-linecap="'+p.cap+'" stroke-linejoin="round"/>').join('')
    +'<circle cx="15" cy="'+g.headY+'" r="'+(g.hr+extra/2)+'" fill="'+color+'"/>';
  return '<svg width="30" height="34" viewBox="0 0 30 34" style="filter:drop-shadow(0 0 1.4px rgba(0,0,0,.5))">'
    +layer(P['runner-out'],2.4)     // 外框：整個人加粗一圈墊在底下
    +layer(P.runner,0)
    +'</svg>';
}
function personIcon(active){
  // viewBox 維持 30×34，直接把渲染尺寸乘 1.3 就等於整個人放大 30%
  return L.divIcon({className:'',iconSize:[39,44],iconAnchor:[19.5,39],html:personSVG(active)});
}
function pvPose(active){ S.pvActive=active; if(pvHead) pvHead.setIcon(personIcon(active)); }
let S_arrowList = [];

function pvBuild(res){
  // 把所有分段串成一條連續路徑，並累計距離
  S.path=[];
  res.segments.forEach(sg=>sg.pts.forEach(p=>{
    const last=S.path.length?S.path[S.path.length-1]:null;
    if(!last||last[0]!==p[0]||last[1]!==p[1]) S.path.push(p);
  }));
  S.cum=[0];
  for(let i=1;i<S.path.length;i++)
    S.cum.push(S.cum[i-1]+map.distance(S.path[i-1],S.path[i]));
  S.totalM=S.cum[S.cum.length-1]||0;

  [pvDone,pvHead,pvArrows].forEach(l=>{if(l)l.remove();});
  pvDone=L.polyline([],{color:PC().done,weight:8,opacity:.95}).addTo(map);
  pvHead=L.marker(S.path[0],{icon:personIcon(false),interactive:false,zIndexOffset:1000}).addTo(map);

  // 箭頭規則：每 200m 一個。若相鄰兩點距離 < 30m 則跳過改到下一段。走過的路段自動隱藏。
  // 顏色吃 --rt-arrow，和匯出圖用同一個值
  const arrows = [];
  S_arrowList = [];
  const step = 200;
  for(let targetD = step; targetD < S.totalM - 20; targetD += step){
    const i = pvIndexAt(targetD);
    if(i < 1) continue;
    const a = S.path[i-1], b = S.path[i];
    const segLen = S.cum[i] - S.cum[i-1];
    if(segLen < 30) continue;   // 小於 30m 跳過

    const mid = [(a[0] + b[0])/2, (a[1] + b[1])/2];
    const pa = map.project(a, 18), pb = map.project(b, 18);
    if(pa.x === pb.x && pa.y === pb.y) continue;
    const dir = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI;

    const mk = L.marker(mid, { interactive:false, icon: arrowIcon(dir) });
    arrows.push(mk);
    S_arrowList.push({ d: targetD, dir, mk });
  }

  pvArrows = L.layerGroup(arrows).addTo(map);
  pvSet(0);
}
const PV_PROJ_Z=18;
function pvHeading(d){
  if(!S.path||S.path.length<2) return null;
  const a=S.path[pvIndexAt(Math.max(0,d-20))];
  const b=S.path[Math.min(pvIndexAt(Math.min(S.totalM,d+20)),S.path.length-1)];
  if(!a||!b||(a[0]===b[0]&&a[1]===b[1])) return null;
  const pa=map.project(a,PV_PROJ_Z),pb=map.project(b,PV_PROJ_Z);
  return Math.atan2(pb.y-pa.y,pb.x-pa.x)*180/Math.PI;
}
function pvIndexAt(dist){
  let lo=0,hi=S.cum.length-1;
  while(lo<hi){const mid=(lo+hi)>>1; if(S.cum[mid]<dist) lo=mid+1; else hi=mid;}
  return lo;
}
/* 進度的唯一真實來源。以前存在 #pvSlider.value（0..1000）裡，
   拉桿被高程圖取代後改存這裡，其他地方一律讀 S.pvFrac。 */
S.pvFrac=0;
function pvSet(frac){
  frac=Math.max(0,Math.min(1,frac));
  S.pvFrac=frac;
  const area=$('elevChartArea');
  if(area) area.setAttribute('aria-valuenow',Math.round(frac*100));
  if(!S.path||!S.path.length){ updateElevRunnerDot(frac); return; }
  const target=S.totalM*frac;
  const i=pvIndexAt(target);
  const shown=S.path.slice(0,Math.max(i+1,1));
  let head=S.path[Math.max(i,0)];
  if(i>0){
    const seg=S.cum[i]-S.cum[i-1];
    const t=seg>0?(target-S.cum[i-1])/seg:0;
    const a=S.path[i-1],b=S.path[i];
    head=[a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t];
    shown[shown.length-1]=head;
  }
  pvDone.setLatLngs(shown);
  pvHead.setLatLng(head);
  $('pvAt').textContent=(target/1000).toFixed(2)+' km';
  $('pvPct').textContent=Math.round(frac*100)+'%';

  // 已走過路段動態隱藏箭頭，僅保留前景路段箭頭
  S_arrowList.forEach(item => {
    if(!item.mk || !item.mk.getElement()) return;
    item.mk.getElement().style.display = (item.d <= target) ? 'none' : '';
  });

  updateElevRunnerDot(frac);
}

/* ---- 在高程圖上拖曳＝拉時間軸 ---- */
function pvFracFromEvent(e){
  const r=$('elevChartArea').getBoundingClientRect();
  if(!r.width) return 0;
  return Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
}
(()=>{
  const area=$('elevChartArea');
  let dragging=false;
  const scrub=e=>{
    pvSet(pvFracFromEvent(e));
    pvPose(true); clearTimeout(poseT); poseT=setTimeout(()=>pvPose(false),320);
  };
  area.addEventListener('pointerdown',e=>{
    if(!S.result) return;
    dragging=true;
    pvStop();                       // 拖曳優先於播放
    // 抓不到指標就算了，照樣要能拖——不能讓它擋掉後面的 scrub
    try{ area.setPointerCapture(e.pointerId); }catch(_){}
    scrub(e);
    e.preventDefault();             // 避免手機上變成選取／捲動
  });
  area.addEventListener('pointermove',e=>{ if(dragging) scrub(e); });
  const end=e=>{
    if(!dragging) return;
    dragging=false;
    try{ area.releasePointerCapture(e.pointerId); }catch(_){}
    pvPose(false);
  };
  area.addEventListener('pointerup',end);
  area.addEventListener('pointercancel',end);
  // 鍵盤操作：原本用原生 range 時免費得到的，換成自訂控制項後要自己補回來
  area.addEventListener('keydown',e=>{
    if(!S.result) return;
    const step=e.shiftKey?0.1:0.02;
    let f=S.pvFrac;
    if(e.key==='ArrowRight'||e.key==='ArrowUp') f+=step;
    else if(e.key==='ArrowLeft'||e.key==='ArrowDown') f-=step;
    else if(e.key==='Home') f=0;
    else if(e.key==='End') f=1;
    else return;
    e.preventDefault(); pvStop(); pvSet(f);
  });
})();

/* 播放／暫停圖示（實心圓角）。地圖上的高程圖標籤也從這裡拿山峰／山谷造型。 */
const PV_ICON={
  play:'<svg viewBox="0 0 24 24"><path d="M8 5.6a1 1 0 011.5-.86l9.6 6.4a1 1 0 010 1.7l-9.6 6.4A1 1 0 018 18.4z"/></svg>',
  pause:'<svg viewBox="0 0 24 24"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>'
};
/* 高程最高＝山峰、最低＝山谷。匯出圖片（js/export.js）用同一組路徑畫在 canvas 上。 */
const ELEV_PEAK='M2.5 19.5L10 6.5l3.5 6 2-3 6 10z', ELEV_VALLEY='M2.5 4.5h19l-6 10-2-3-3.5 6z';
const elevIcon=d=>'<svg viewBox="0 0 24 24"><path d="'+d+'"/></svg>';
function pvPlayIcon(playing){
  $('pvPlay').innerHTML=playing?PV_ICON.pause:PV_ICON.play;
  $('pvPlay').setAttribute('aria-label',playing?'pause':'play');
}
pvPlayIcon(false);
function pvStop(){if(pvTimer){clearInterval(pvTimer);pvTimer=null;pvPlayIcon(false);} pvPose(false);}
$('pvPlay').onclick=()=>{
  if(pvTimer){pvStop();return;}
  if(S.pvFrac>=1) pvSet(0);
  pvPlayIcon(true);
  pvPose(true);   // 播放中＝奔跑（雙手舉高）
  pvTimer=setInterval(()=>{
    // 前進速度跟著配速：配速越慢（S.pace 越大）小人跑越慢。
    // 等於把真實跑步時間壓縮成固定比例（約 1/120）播放。
    const vMps = S.pace>0 ? 1000/(S.pace*60) : 2.8;   // 真實跑步 m/s
    const stepM = vMps * 120 * 0.04;                   // 每 40ms 前進的公尺
    const inc = S.totalM>0 ? stepM/S.totalM : 0.008;
    let f=S.pvFrac+inc;
    if(f>=1){f=1;pvSet(f);pvStop();return;}
    pvSet(f);
  },40);
};

/* ---------- 配速（可調，會記住） ---------- */
S.pace=parseFloat(store.get('runart_pace'))||6;   // 分鐘/公里
S.km=0;
function paceName(p){
  const i = p<=4.5?0 : p<=6.5?1 : p<=9?2 : 3;
  return PACE_NAMES[lang][i];
}
function paceUI(){
  const m=Math.floor(S.pace), sec=Math.round((S.pace-m)*60);
  $('pVal').textContent=m+':'+String(sec).padStart(2,'0');
  if($('pHint')) $('pHint').textContent=paceName(S.pace);
  const t=S.km*S.pace;
  let txt='–';
  if(S.km){
    if(t<60) txt=Math.round(t)+tx(' 分',' min');
    else{
      const h=Math.floor(t/60), mm=Math.round(t%60);
      txt = mm ? h+tx(' 小時 ',' h ')+mm+tx(' 分',' min') : h+tx(' 小時',' h');
    }
  }
  $('sTime').textContent=txt;
  store.set('runart_pace',S.pace);
}
$('pDn').onclick=()=>{S.pace=Math.min(15,+(S.pace+0.5).toFixed(1));paceUI();};
$('pUp').onclick=()=>{S.pace=Math.max(3,+(S.pace-0.5).toFixed(1));paceUI();};
paceUI();

/* ---------- 生成（真實運算） ---------- */
/* 套用一份運算結果（生成與微調共用）。微調時不重建預覽，
   否則預覽圖層會蓋住要點選的節點。 */
function applyResult(res,withPreview=true){
  S.result=res;
  if(routeLayer) routeLayer.remove();
  const layers=[];
  res.segments.forEach(sg=>{
    if(sg.kind==='draw'){
      layers.push(L.polyline(sg.pts,{color:PC().pending,weight:9,opacity:.95}));
    }else{
      // 連接段（起點→路線、路線→終點、筆畫之間）：細的淺灰虛線，和道路(路網)顏色區分。
      layers.push(L.polyline(sg.pts,{color:PC().connector,weight:2.5,opacity:.95,dashArray:'7 6'}));
    }
  });
  routeLayer=L.layerGroup(layers).addTo(map);
  /* 「已跑」那條是獨立圖層，剛剛才重建底層的未跑路線 → 它現在壓在上面。
     不拉回最前面的話，拖進度條會看起來完全沒反應（顏色被蓋掉）。
     只有 withPreview=false 這條路徑會踩到：那時不會重建 pvDone，
     所以順序不會自己修正。注意 pvDone 是 Polyline（有 bringToFront），
     不是 LayerGroup（沒有）。 */
  try{ if(pvDone && map.hasLayer(pvDone)) pvDone.bringToFront(); }catch(_){}
  S.km=res.total_m/1000;
  $('sDist').textContent=S.km.toFixed(2)+' km';
  $('sFit').textContent=Math.round(res.fit)+'%';
  // 吻合度 = 準確率與覆蓋率的調和平均；兩個分項放在提示裡
  if(res.precision!=null) $('sFit').title=tx('路線貼著圖案 '+Math.round(res.precision)+'%・圖案被跑到 '+Math.round(res.recall)+'%',
    'On the drawing '+Math.round(res.precision)+'% · drawing covered '+Math.round(res.recall)+'%');
  paceUI();
  if(withPreview) pvBuild(res);
}
function pvClear(){
  pvStop();
  [pvDone,pvHead,pvArrows].forEach(l=>{if(l)l.remove();});
  pvDone=pvHead=pvArrows=null;
}
/* ---------- 預估爬升／下降 ----------
   用 Open-Meteo 免費高程 API（有 CORS，一次最多 100 點）查整條路線的高度，
   加總正的落差＝爬升、負的＝下降。DEM 解析度較粗，城市路線通常起伏不大屬正常。 */
let elevChartData = null;

/* 高程折線圖的座標系。SVG 是 preserveAspectRatio="none" 拉伸的，
   所以這些是「虛擬單位」，不是像素——疊層用百分比換算回來（見 renderElevChart）。
   上下各留 EL_PADT / EL_PADB 的空白帶，專門給最高／最低標籤站，
   這樣「最高一定在上、最低一定在下」才不會頂到邊界被裁掉。
   改動這裡的話 updateElevRunnerDot 會跟著走（它讀同一組常數）。 */
/* EL_LBL_GAP 是標籤離點多遠；EL_LBL_EDGE 是標籤最少離上下緣多遠。
   兩個要分開，否則「離點遠一點」會被「不要超出邊界」的夾擠回來——
   上下的 PAD 就是專門空出來讓標籤站的，所以要比 GAP 大。 */
const EL_W = 340, EL_H = 92, EL_PADT = 28, EL_PADB = 28,
      EL_LBL_GAP = 15, EL_LBL_EDGE = 10;

function renderElevChart(data){
  const P = PC();
  const area = $('elevChartArea');
  if(!area) return;
  /* 高程 API 失敗時「不能」把整塊藏起來——它現在同時是路線預覽的拉桿，
     藏掉就等於連預覽都不能拖了。改成退化為一條普通軌道，照樣可以拖。 */
  if(!data || !data.elevations || data.elevations.length < 2){
    elevChartData = null;
    if($('elevRangeText')) $('elevRangeText').textContent = '–';
    area.innerHTML = `
      <div class="elev-track"><div class="elev-track-run" id="elevTrackRun"></div></div>
      <div id="elevRunnerDot"></div>`;
    updateElevRunnerDot(S.pvFrac || 0);
    return;
  }
  elevChartData = data;

  const elevations = data.elevations;
  let minE = Infinity, maxE = -Infinity, minIdx = 0, maxIdx = 0;
  elevations.forEach((e, i) => {
    if(e < minE){ minE = e; minIdx = i; }
    if(e > maxE){ maxE = e; maxIdx = i; }
  });
  const rangeE = Math.max(10, maxE - minE);

  if($('elevRangeText')) $('elevRangeText').textContent = tx('最高 ','Max ') + Math.round(maxE) + tx(' m / 最低 ',' m / Min ') + Math.round(minE) + ' m';

  const W = EL_W, H = EL_H, padT = EL_PADT, padB = EL_PADB;
  const chartW = W, chartH = H - padT - padB;

  const pts = elevations.map((e, idx) => {
    const x = (idx / (elevations.length - 1)) * chartW;
    const y = padT + chartH - ((e - minE) / rangeE) * chartH;
    return { x, y, e, idx };
  });

  const pathStr = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  const lineD = 'M ' + pathStr.join(' L ');
  const areaD = `M 0,${H - padB} L ` + pathStr.join(' L ') + ` L ${W},${H - padB} Z`;

  const minPt = pts[minIdx];
  const maxPt = pts[maxIdx];

  /* 疊層用百分比定位，和 SVG 被拉伸後的位置完全對齊（同一個 viewBox 比例）。
     標籤預設放在點的外側，太靠邊界就翻到另一側，避免被裁掉。
     水平方向用 min()/max() 夾住，讓標籤貼著點但不會突出圖表左右緣。 */
  const pctX = p => (p.x / W) * 100;
  const pctY = y => (y / H) * 100;
  const lblX = p => `max(30px, min(calc(100% - 30px), ${pctX(p).toFixed(2)}%))`;
  /* 最高固定在點的上方、最低固定在下方。上下各留了 EL_PADT/EL_PADB
     的空白帶，所以就算峰頂剛好頂到繪圖區上緣，標籤還是塞得下不會被裁。 */
  const maxLblY = Math.max(EL_LBL_EDGE, maxPt.y - EL_LBL_GAP);
  const minLblY = Math.min(H - EL_LBL_EDGE, minPt.y + EL_LBL_GAP);

  /* 已跑／未跑用一個 clipPath 切開，和地圖上的路線同一套語彙（暗＝還沒跑到）。
     只更新那個 rect 的寬度就能重畫進度，不必每次重建整段 SVG。 */
  area.innerHTML = `
    <svg class="elev-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="elevGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${P.elev}" stop-opacity="0.45"/>
          <stop offset="100%" stop-color="${P.elev}" stop-opacity="0.03"/>
        </linearGradient>
        <clipPath id="elevRunClip">
          <rect id="elevRunRect" x="0" y="0" width="0" height="${H}"/>
        </clipPath>
      </defs>
      <path d="${areaD}" fill="url(#elevGrad)" opacity="0.28"/>
      <path d="${lineD}" fill="none" stroke="${P['elev-dim']}" stroke-width="2.2"
            vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
      <g clip-path="url(#elevRunClip)">
        <path d="${areaD}" fill="url(#elevGrad)"/>
        <path d="${lineD}" fill="none" stroke="${P.elev}" stroke-width="2.2"
              vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
    </svg>
    <div class="elev-pt max" style="left:${pctX(maxPt).toFixed(2)}%;top:${pctY(maxPt.y).toFixed(2)}%"></div>
    <div class="elev-pt min" style="left:${pctX(minPt).toFixed(2)}%;top:${pctY(minPt.y).toFixed(2)}%"></div>
    <div class="elev-lbl max" style="left:${lblX(maxPt)};top:${pctY(maxLblY).toFixed(2)}%">${elevIcon(ELEV_PEAK)}${Math.round(maxE)} m</div>
    <div class="elev-lbl min" style="left:${lblX(minPt)};top:${pctY(minLblY).toFixed(2)}%">${elevIcon(ELEV_VALLEY)}${Math.round(minE)} m</div>
    <div id="elevRunnerDot"></div>
  `;

  updateElevRunnerDot(S.pvFrac || 0);
}

function updateElevRunnerDot(frac){
  frac = Math.max(0, Math.min(1, frac || 0));
  const dot = $('elevRunnerDot');
  if(!dot) return;
  const W = EL_W;
  // 沒有高程資料時只推進純軌道的進度條，跑者點壓在軌道正中央
  if(!elevChartData || !elevChartData.elevations){
    const run = $('elevTrackRun');
    if(run) run.style.width = (frac * 100).toFixed(2) + '%';
    dot.style.left = (frac * 100).toFixed(2) + '%';
    dot.style.top = '50%';
    return;
  }
  const runRect = document.getElementById('elevRunRect');
  if(runRect) runRect.setAttribute('width', (frac * W).toFixed(2));
  const elevations = elevChartData.elevations;
  let minE = Infinity, maxE = -Infinity;
  elevations.forEach(e => {
    if(e < minE) minE = e;
    if(e > maxE) maxE = e;
  });
  const rangeE = Math.max(10, maxE - minE);

  /* 必須用和 renderElevChart 完全相同的 viewBox 幾何（H=60，不是容器的 58px），
     否則跑者點會固定偏離折線約 1px——之前就是拿 offsetHeight 當 H 才對不準。
     改用百分比後也不必再讀 offsetWidth，視窗縮放時位置自動跟著對。 */
  const H = EL_H, padT = EL_PADT, padB = EL_PADB;
  const chartH = H - padT - padB;

  const idxFloat = Math.max(0, Math.min(1, frac)) * (elevations.length - 1);
  const idx = Math.floor(idxFloat);
  const t = idxFloat - idx;
  const e1 = elevations[Math.min(idx, elevations.length - 1)];
  const e2 = elevations[Math.min(idx + 1, elevations.length - 1)];
  const e = e1 + (e2 - e1) * t;

  const y = padT + chartH - ((e - minE) / rangeE) * chartH;

  dot.style.left = (Math.max(0, Math.min(1, frac)) * 100).toFixed(2) + '%';
  dot.style.top = ((y / H) * 100).toFixed(2) + '%';
}

let elevSeq=0;
async function updateElevation(){
  if(!S.result){renderElevChart(null);return;}
  const path=[];
  S.result.segments.forEach(sg=>sg.pts.forEach(p=>{
    const last=path.length?path[path.length-1]:null;
    if(!last||last[0]!==p[0]||last[1]!==p[1]) path.push(p);
  }));
  if(path.length<2){$('sElev').textContent='–';renderElevChart(null);return;}
  /* 依「距離」等距取樣，不是依索引。
     路網節點的間距差很多（實測同一條路上有 8m 也有 300m 的段），照索引取樣的話
     橫軸就不是距離軸——量過最壞情況：實際在 1283m 處的點會被畫在相當於 993m 的
     位置，偏了 7.4%。而且跑者點是用「距離比例」定位的，兩者對不起來。
     改成沿線等距內插後，橫軸才真的是距離，爬升／下降也不會被密集節點灌水。 */
  const cum=[0];
  for(let i=1;i<path.length;i++) cum.push(cum[i-1]+map.distance(path[i-1],path[i]));
  const totalM=cum[cum.length-1];
  const N=Math.min(100,Math.max(2,path.length));
  const samp=[];
  if(totalM<=0){
    for(let i=0;i<N;i++) samp.push(path[Math.min(i,path.length-1)]);
  }else{
    let j=1;
    for(let i=0;i<N;i++){
      const d=totalM*i/(N-1);
      while(j<cum.length-1 && cum[j]<d) j++;
      const seg=cum[j]-cum[j-1];
      const t=seg>0?(d-cum[j-1])/seg:0;
      const a=path[j-1], b=path[j];
      samp.push([a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t]);
    }
  }
  const seq=++elevSeq;
  $('sElev').textContent=tx('計算中…','Calculating…');
  try{
    const lat=samp.map(p=>p[0].toFixed(5)).join(',');
    const lon=samp.map(p=>p[1].toFixed(5)).join(',');
    const ctrl=new AbortController();const tm=setTimeout(()=>ctrl.abort(),8000);
    const r=await fetch('https://api.open-meteo.com/v1/elevation?latitude='+lat+'&longitude='+lon,{signal:ctrl.signal});
    clearTimeout(tm);
    const e=(await r.json()).elevation;
    if(seq!==elevSeq) return;
    if(!e||!e.length) throw 0;
    /* 爬升／下降用 3m 遲滯門檻累計：落差要累積超過門檻才算一次爬升或下降。
       直接加總每個取樣點的差會把 DEM 的雜訊也算進去，數字會比運動手錶的高。 */
    let up=0,down=0,ref=e[0];
    const HYST=3;
    for(let i=1;i<e.length;i++){
      const d=e[i]-ref;
      if(d>=HYST){up+=d;ref=e[i];}
      else if(d<=-HYST){down-=d;ref=e[i];}
    }
    S.elevGain=Math.round(up); S.elevLoss=Math.round(down);
    $('sElev').textContent='↑'+S.elevGain+' ↓'+S.elevLoss+' m';
    renderElevChart({ elevations: e });
  }catch(_){
    if(seq===elevSeq){ S.elevGain=null;S.elevLoss=null; $('sElev').textContent='–'; renderElevChart(null); }
  }
}
/* 把視野拉到路線上，並讓開結果面板與頂端按鈕 */
function fitRoute(){
  if(!S.result) return;
  const all=[];
  S.result.segments.forEach(sg=>sg.pts.forEach(p=>all.push(p)));
  if(all.length<2) return;
  const sh=S.sheetUp?el.sheet.offsetHeight:0;
  map.fitBounds(L.latLngBounds(all),
    {paddingTopLeft:[24,64],paddingBottomRight:[24,sh+20]});
}
$('btnGo').onclick=()=>{
  const strokes=S.strokes.map(s=>s.pts.map(p=>[p.lat,p.lng]));
  // 路線較長（>10km）分析會比較久，先提示一下
  let drawM=0;
  for(const s of S.strokes) for(let i=1;i<s.pts.length;i++) drawM+=map.distance(s.pts[i-1],s.pts[i]);
  if(drawM>10000) toast(tx('路線較長（'+(drawM/1000).toFixed(1)+' km），分析需要多一點時間…',
                          'Long route ('+(drawM/1000).toFixed(1)+' km), analysis may take a while…'),3000);
  if(S.generating) return;           // 防止連按：上一次還沒算完
  S.generating=true; refresh();
  Engine.generate(strokes,[S.start.lat,S.start.lng],[S.end.lat,S.end.lng])
    .finally(()=>{ S.generating=false; refresh(); })
    .then(res=>{
      applyResult(res);
      S.strokes.forEach(s=>s.line.setStyle({opacity:.25,weight:3}));
      S.generated=true;S.locked=true;
      S.sheetUp=true;el.sheet.classList.add('up');
      refresh();fitRoute();updateElevation();
    })
    .catch(err=>{busy('');
      if(err.cancelled) toast(tx('已取消','Cancelled'),1400);
      else toast(tx('生成失敗：','Generate failed: ')+err.message,3000);});
};

/* ---------- 生成後的動作 ---------- */
$('aMod').onclick=()=>{
  S.prevResult = S.result;
  dropRoute();
  S.strokes.forEach(s=>s.line.setStyle({opacity:.95,weight:5}));
  setMode('draw');refresh();
  toast(tx('已進入修改圖案模式，改完按生成，或按「取消修改」回到原路線', 'Edit shape mode. Tap Generate when done or Cancel to revert'),3000);
};
$('btnCancelMod').onclick=()=>{
  if(!S.prevResult) return;
  S.result = S.prevResult;
  S.prevResult = null;
  S.generated = true; S.locked = true;
  applyResult(S.result);
  S.strokes.forEach(s=>s.line.setStyle({opacity:.25,weight:3}));
  S.sheetUp = true; el.sheet.classList.add('up');
  refresh(); fitRoute();
  updateElevation();   // dropRoute() 已經把爬升與高程圖清掉了，要重新查
  toast(tx('已取消修改，恢復原路線', 'Cancelled edits, restored route'), 2000);
};
$('aNew').onclick=()=>{
  if(confirm(tx('確定要重新繪製？目前畫布上的所有內容與路線將會被清空。', 'Are you sure you want to restart? All drawings and route content will be cleared.'))){
    S.prevResult = null;
    clearAll(); setMode('draw');
    toast(tx('已清空畫布，重新開始畫圖', 'Canvas cleared. Start drawing again'), 2000);
  }
};
$('aRev').onclick=()=>{
  if(!S.result) return;
  Engine.reverseRoute()
    .then(res=>{
      applyResult(res);
      // 起終點對調：路線現在從原本的終點跑起
      const s=S.start;S.start=S.end;S.end=s;
      refreshSEMarkers();   // 起訖點對調，重疊時左右半邊也要跟著換
      // 方向反轉＝爬升與下降互換、高程剖面左右翻轉，不必再打一次 API。
      // 剖面不翻的話，跑者從另一頭出發，高程圖上的點卻還照舊方向走（匯出圖也是反的）。
      const g=S.elevGain;S.elevGain=S.elevLoss;S.elevLoss=g;
      if(S.elevGain!=null) $('sElev').textContent='↑'+S.elevGain+' ↓'+S.elevLoss+' m';
      if(elevChartData&&elevChartData.elevations){
        elevChartData={elevations:elevChartData.elevations.slice().reverse()};
        renderElevChart(elevChartData);
      }
      saveSession();
      toast(tx('已反轉方向','Direction reversed'),1600);
    })
    .catch(err=>{busy('');toast(tx('反轉失敗：','Reverse failed: ')+err.message,3000);});
};

