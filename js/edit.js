/* Running Art — 微調路徑：選取／刪除節點、拖曳節點改道。
   index.html 依序載入 js/theme.js → ui.js → route.js → edit.js → export.js → init.js，
   它們是一般的 <script>（不是 module），共用同一個全域範圍。 */
/* ---------- 微調路徑 ---------- */
/* 節點畫在 canvas 上（幾百個 SVG 圓在手機上會很鈍），指定 pane: 'markerPane' 確保於路線上層 */
let nodeRenderer=null;
const NODE_R=4, NODE_SEL_R=9, NODE_TURN_R=7.5, PICK_TOL_PX=24;
const TURN_DEG=28;   // 轉多少度才算「轉彎點」
let nodeLayer=null, nodeMks=[];

/* 找出一串節點裡哪些是「轉彎點」：用投影後的平面角度，避免 Mercator 拉伸。
   回傳與 latlngs 等長的布林陣列。 */
function turnFlags(latlngs){
  const f=new Array(latlngs.length).fill(false);
  const pr=ll=>map.project(ll,18);
  for(let i=1;i<latlngs.length-1;i++){
    const a=latlngs[i-1],b=latlngs[i],c=latlngs[i+1];
    if(!a||!b||!c) continue;
    const pa=pr(a),pb=pr(b),pc=pr(c);
    let d=Math.abs(Math.atan2(pc.y-pb.y,pc.x-pb.x)-Math.atan2(pb.y-pa.y,pb.x-pa.x))*180/Math.PI;
    if(d>180) d=360-d;
    if(d>=TURN_DEG) f[i]=true;
  }
  return f;
}
// 一個節點沒被選取時該有的樣式（轉彎點醒目、其餘小而淡）
function nodeStyle(turn){
  const P=PC();
  return turn
    ? {radius:NODE_TURN_R,color:P['on-accent'],weight:2,fillColor:P['node-turn'],fillOpacity:1}
    : {radius:NODE_R,color:P.node,weight:1,fillColor:P.node,fillOpacity:.55};
}
function editBuild(){
  if(nodeLayer) nodeLayer.remove();
  nodeMks=[];S.sel.clear();
  if(!nodeRenderer){
    try { nodeRenderer = L.canvas({padding:.3, pane:'markerPane'}); }
    catch(_) { nodeRenderer = L.canvas({padding:.3}); }
  }
  const marks=[];
  for(const sg of S.result.segments){
    const flags=turnFlags(sg.nodes||[]);   // 只把轉彎點標出來
    (sg.nodes||[]).forEach((ll,n)=>{
      if(!ll) return;   // null 佔位：這個節點不在路網裡，不能編輯
      const turn=!!flags[n];
      // 指定 pane: 'markerPane' 讓節點永遠顯示於路線 Layer 之上
      const mk=L.circleMarker(ll,{pane:'markerPane',renderer:nodeRenderer,interactive:false,...nodeStyle(turn)});
      nodeMks.push({si:sg.si,n,ll,mk,turn});
      marks.push(mk);
    });
  }
  nodeLayer=L.layerGroup(marks,{pane:'markerPane'}).addTo(map);
  /* 疊在路線之上靠的是 pane：markerPane(600) 本來就高於路線的 overlayPane(400)，
     再用 renderer container 的 z-index 壓過 markerPane 內的起訖點圖釘。
     這裡不要呼叫 nodeLayer.bringToFront() —— L.layerGroup 沒有這個方法（只有
     L.featureGroup 有），會丟 TypeError。而且 editBuild 是在 Engine.editDelete()
     的 .then() 裡呼叫的，丟出來的錯會被同一條 promise 的 .catch 接走，
     於是「刪除其實成功了」卻跳出「刪除失敗」的提示，選取還被清掉。 */
  if(nodeRenderer && nodeRenderer._container) nodeRenderer._container.style.zIndex = '750';
  editUI();
}
function editMark(i,on){
  const d=nodeMks[i];
  if(on) d.mk.setStyle({radius:NODE_SEL_R,color:PC()['node-sel'],weight:1,fillColor:PC()['node-sel'],fillOpacity:1});
  else d.mk.setStyle(nodeStyle(d.turn));
}
function editUI(){
  const n=S.sel.size;
  $('eDel').disabled=!n;$('eNone').disabled=!n;
  $('eUndo').disabled=!(S.result&&S.result.undo);
  el.pill.classList.remove('hide');
  el.pill.textContent=n?tx('已選 '+n+' 個節點',n+' selected'):tx(nodeMks.length+' 個可調整的節點',nodeMks.length+' editable nodes');
  updatePillPos();   // editDock 比 mainDock 高，位置要重算才不會壓到按鈕
}
/* ---- 拖曳節點改路徑 ----
   只在「按住某個節點」時才去查它 20m 內的路口當候選點。
   實測台北路網 4670 節點/km²，若把整條路線 20m 內的節點全部畫出來，
   5km 路線會有約 934 個點——畫面會被蓋死、手指也點不準，所以限定在拖曳當下。
   只取路口（度數>=3）：直路中間的節點只是幾何轉點，移過去不會改變走法。 */
/* 先找 20m 內的路口；台北實測「真的在路上的節點」有 65% 在 20m 內一個路口都沒有，
   所以找不到就自動放寬到 60m（實測 60m 時中位數 4 個、不會落空）。
   一次最多顯示 12 個，免得路口密集處糊成一片。 */
const GHOST_R=20, GHOST_R_MAX=60, GHOST_MAX=12;
let ghostLayer=null, ghostList=[], ghostBest=-1, ghostSeq=0;
let ghostPreview=null, previewSeq=0;   // 拖曳中的路徑預覽線

function editHitNode(ll){
  const p0=map.latLngToContainerPoint(ll);
  let best=-1,bd=1e9;
  nodeMks.forEach((d,i)=>{
    const p=map.latLngToContainerPoint(d.ll);
    const dist=Math.hypot(p.x-p0.x,p.y-p0.y);
    if(dist<bd){bd=dist;best=i;}
  });
  return bd<=PICK_TOL_PX?best:-1;
}
function ghostStyle(on){
  const P=PC();
  return on
    ? {radius:11,color:P['on-accent'],weight:2.5,fillColor:P.done,fillOpacity:1}
    : {radius:7,color:P.done,weight:2,fillColor:P['on-accent'],fillOpacity:.55};
}
function ghostClear(){
  if(ghostLayer){ghostLayer.remove();ghostLayer=null;}
  previewClear();
  ghostList=[];ghostBest=-1;
}
function previewClear(){
  previewSeq++;                      // 讓還在路上的預覽請求作廢
  if(ghostPreview){ghostPreview.remove();ghostPreview=null;}
}
/* 把「放開手之後路徑會變成什麼樣」畫出來。
   只有在高亮的候選點換掉時才重算（拖曳中每個 pointermove 都算太浪費），
   而且走的是 previewMove——它不會動到真正的路線。 */
async function previewShow(idx,cand){
  const seq=++previewSeq;
  const d=nodeMks[idx];
  let res=null;
  try{ res=await Engine.previewMove(d.si,d.n,cand.id); }catch(_){}
  if(seq!==previewSeq||S.eDragIdx==null) return;   // 已放開或又換了候選
  if(ghostPreview){ghostPreview.remove();ghostPreview=null;}
  if(!res||!res.ok||!res.pts||res.pts.length<2) return;
  const P=PC();
  ghostPreview=L.polyline(res.pts,{color:P.done,weight:7,opacity:.95,
    dashArray:'10 8',lineCap:'round',pane:'markerPane'}).addTo(map);
}
async function ghostLoad(node){
  ghostClear();
  const seq=++ghostSeq;
  let js=[];
  try{
    js=await Engine.nearbyJunctions(node.ll[0],node.ll[1],GHOST_R,60);
    // 濾掉「就是這個節點本身」的候選（距離幾乎為 0）
    if(!js.filter(j=>j.d>1.5).length)
      js=await Engine.nearbyJunctions(node.ll[0],node.ll[1],GHOST_R_MAX,60);
  }catch(_){}
  if(seq!==ghostSeq||S.eDragIdx==null) return;   // 已經放開或換了節點
  ghostList=js.filter(j=>j.d>1.5).slice(0,GHOST_MAX);
  if(!ghostList.length) return;
  const marks=ghostList.map(j=>
    L.circleMarker([j.lat,j.lon],Object.assign({pane:'markerPane',interactive:false},ghostStyle(false))));
  ghostLayer=L.layerGroup(marks,{pane:'markerPane'}).addTo(map);
  ghostList.forEach((j,i)=>{j.mk=marks[i];});
}
// 把最靠近指標的候選點放大，讓使用者知道放開會接到哪
function ghostHighlight(ll){
  if(!ghostList.length) return;
  const p0=map.latLngToContainerPoint(ll);
  let best=-1,bd=1e9;
  ghostList.forEach((j,i)=>{
    const p=map.latLngToContainerPoint([j.lat,j.lon]);
    const d=Math.hypot(p.x-p0.x,p.y-p0.y);
    if(d<bd){bd=d;best=i;}
  });
  if(bd>PICK_TOL_PX*1.6) best=-1;
  if(best===ghostBest) return;
  if(ghostBest>=0&&ghostList[ghostBest]) ghostList[ghostBest].mk.setStyle(ghostStyle(false));
  if(best>=0) ghostList[best].mk.setStyle(ghostStyle(true));
  ghostBest=best;
  if(best>=0) previewShow(S.eDragIdx,ghostList[best]);
  else previewClear();
}
function editDropNode(idx,ll){
  const target=ghostBest>=0?ghostList[ghostBest]:null;
  ghostClear();
  if(!target){ toast(tx('沒有可以接的路口，位置不變','No junction to snap to — unchanged'),1800); return; }
  const d=nodeMks[idx];
  busy('重新接路中…');
  Engine.editMove(d.si,d.n,target.id)
    .then(res=>{
      busy('');
      if(!res.ok){
        toast(res.reason==='unreachable'
          ? tx('接不過去（中間沒有可走的路）','No road connects to that junction')
          : tx('這樣改會讓路線斷掉，已取消','That would break the route — cancelled'),3000);
        return;
      }
      applyResult(res,false);
      editBuild();
      refresh();updateElevation();
      toast(tx('路徑已改道','Path re-routed'),1500);
    })
    .catch(err=>{busy('');toast(tx('改道失敗：','Re-route failed: ')+err.message,3000);});
}

function editPick(ll){
  const p0=map.latLngToContainerPoint(ll);
  let best=-1,bd=1e9;
  nodeMks.forEach((d,i)=>{
    const p=map.latLngToContainerPoint(d.ll);
    const dist=Math.hypot(p.x-p0.x,p.y-p0.y);
    if(dist<bd){bd=dist;best=i;}
  });
  if(best<0||bd>PICK_TOL_PX) return;
  if(S.sel.has(best)) S.sel.delete(best); else S.sel.add(best);
  editMark(best,S.sel.has(best));editUI();
}
function editBoxSelect(r){
  if(r.x1-r.x0<6&&r.y1-r.y0<6) return;
  nodeMks.forEach((d,i)=>{
    if(S.sel.has(i)) return;
    const p=map.latLngToContainerPoint(d.ll);
    if(p.x>=r.x0&&p.x<=r.x1&&p.y>=r.y0&&p.y<=r.y1){S.sel.add(i);editMark(i,true);}
  });
  editUI();
}
$('aEdit').onclick=()=>{
  if(!S.result) return;
  S.editing=true;S.ebox=false;$('eBox').classList.remove('on');
  S.sheetUp=false;el.sheet.classList.remove('up');
  pvClear();
  $('mainDock').hidden=true;$('editDock').hidden=false;
  setMode('pan');map.dragging.enable();
  editBuild();
  toast(tx('點一下節點可選取；直接拖曳節點可以把路徑改走附近的路口','Tap a node to select it; drag a node to re-route through a nearby junction'),3200);
};
$('eBox').onclick=()=>{
  S.ebox=!S.ebox;
  $('eBox').classList.toggle('on',S.ebox);
  map.dragging[S.ebox?'disable':'enable']();
  toast(S.ebox?tx('拖曳框住要刪除的節點','Drag a box over the nodes to delete'):tx('改回點擊選取，可拖曳地圖','Back to tap-select; you can pan the map'),1600);
};
$('eNone').onclick=()=>{
  S.sel.forEach(i=>editMark(i,false));S.sel.clear();editUI();
};
$('eDel').onclick=()=>{
  if(!S.sel.size) return;
  const picks=[...S.sel].map(i=>({si:nodeMks[i].si,n:nodeMks[i].n}));
  Engine.editDelete(picks)
    .then(res=>{
      if(!res.ok){
        S.sel.forEach(i=>editMark(i,false));
        S.sel.clear();
        editUI();
        toast(res.reason==='break'
          ? tx('刪掉這些節點後找不到別條路繞過去，已自動取消選取。請嘗試框選整段路徑。',
               'No other road goes around these nodes, so the selection was cleared. Try box-selecting the whole detour.')
          : tx('無法刪除（該段剩餘節點太少），已自動取消選取。',
               'Cannot delete: too few nodes would be left in this segment. Selection cleared.'),3400);
        return;
      }
      applyResult(res,false);editBuild();
      toast(tx('已重新沿道路接好','Re-routed along the roads'),1400);
    })
    .catch(err=>{
      busy('');
      S.sel.forEach(i=>editMark(i,false));
      S.sel.clear();
      editUI();
      toast(tx('刪除失敗：','Delete failed: ')+err.message,3000);
    });
};
$('eUndo').onclick=()=>{
  Engine.editUndo()
    .then(res=>{
      if(!res.ok){toast(tx('沒有可復原的步驟','Nothing to undo'));return;}
      applyResult(res,false);editBuild();
    })
    .catch(err=>toast(tx('復原失敗：','Undo failed: ')+err.message,3000));
};
$('eDone').onclick=()=>{
  S.editing=false;S.ebox=false;$('eBox').classList.remove('on');
  map.dragging.enable();
  if(nodeLayer){nodeLayer.remove();nodeLayer=null;}
  ghostClear();
  nodeMks=[];S.sel.clear();
  $('mainDock').hidden=false;$('editDock').hidden=true;
  updatePillPos();
  pvBuild(S.result);
  S.sheetUp=true;el.sheet.classList.add('up');
  el.pill.classList.add('hide');
  refresh();updateElevation();   // 路徑被改過，重新估爬升下降
};
$('aGpx').onclick=()=>{
  if(!S.result) return;
  // 有高程資料就沿距離內插寫進 <ele>；沒有就不寫（不能寫 0，平台會當成真的海拔）
  let elevAt=null;
  if(elevChartData&&elevChartData.elevations&&elevChartData.elevations.length>1&&S.totalM>0){
    const E=elevChartData.elevations, N=E.length;
    elevAt=d=>{
      const f=Math.max(0,Math.min(1,d/S.totalM))*(N-1), i=Math.floor(f), t=f-i;
      return E[Math.min(i,N-1)]+(E[Math.min(i+1,N-1)]-E[Math.min(i,N-1)])*t;
    };
  }
  const blob=new Blob([Engine.toGPX(S.result.segments,elevAt)],{type:'application/gpx+xml'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='RunningArt_'+localDate()+'.gpx';
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),4000);
  toast(tx('GPX 已下載','GPX downloaded'));
};
