/* Running Art — 匯出圖片（分享圖）與 GPX。
   index.html 依序載入 js/theme.js → ui.js → route.js → edit.js → export.js → init.js，
   它們是一般的 <script>（不是 module），共用同一個全域範圍。 */
/* ---------- 匯出圖片 ----------
   把底圖 tile 自己抓下來畫進 canvas。CARTO 和 OSM 通常會回 Access-Control-Allow-Origin: *，
   但不能假設一定有（快取層、企業 proxy、離線重送都可能吃掉那個標頭），
   少了它 canvas 就會被「污染 (tainted)」而 toBlob/toDataURL 直接丟 SecurityError。
   所以圖磚一律走 fetch→blob 這條路（見 loadTile），並在匯出時做污染偵測 + 自動降級。
   不依賴任何額外函式庫。 */
const TILE_SIZE=256;          // 一個 tile 代表的「世界像素」
/* 資訊欄的兩列各自可關，所以高度要分開算——兩列都關掉時整塊不佔位，
   不然會留下一條空白。PLACE_ROW_H + STATS_ROW_H = 原本的 250。 */
const PLACE_ROW_H=95;         // 地點 + 日期那一列
const STATS_ROW_H=155;        // 數據那一列
const ELEV_BAND_H=230;        // 資訊欄「高程區」高度。高程圖從地圖搬到這裡，
                              // 地圖區就只剩路線本身（外加可選的比例尺）
// 社群媒體常見比例。寬一律 1080，資訊欄固定在最底部，地圖區 = 寬 × (高−資訊欄)。
const PNG_RATIOS={'1:1':[1080,1080],'4:5':[1080,1350],'9:16':[1080,1920]};

/* 反向地理編碼：把座標變成「中山區, 台北市」。用 OSM 的 Nominatim（有 CORS）。
   結果快取在記憶體，失敗就回空字串、不影響出圖。 */
const _placeCache={};
/* Nominatim 的使用政策：每秒最多 1 次請求。所有查詢（反向地理編碼、地點搜尋）
   都排進同一個佇列，前後至少隔 1.1 秒。 */
let _nomiChain=Promise.resolve(), _nomiLast=0;
function nominatimFetch(url,opt){
  const run=async()=>{
    const wait=_nomiLast+1100-Date.now();
    if(wait>0) await new Promise(r=>setTimeout(r,wait));
    _nomiLast=Date.now();
    return fetch(url,opt);
  };
  const p=_nomiChain.then(run,run);
  _nomiChain=p.catch(()=>{});
  return p;
}
async function getPlaceName(lat,lon){
  const key=lang+':'+lat.toFixed(3)+','+lon.toFixed(3);   // 語言不同要分開快取
  if(key in _placeCache) return _placeCache[key];
  try{
    const ctrl=new AbortController();const tm=setTimeout(()=>ctrl.abort(),7000);
    const u='https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14'+
            '&accept-language='+(EN()?'en':'zh-TW')+'&lat='+lat+'&lon='+lon;
    const r=await nominatimFetch(u,{signal:ctrl.signal});clearTimeout(tm);
    if(!r.ok) throw 0;
    const a=(await r.json()).address||{};
    const district=a.city_district||a.suburb||a.borough||a.district||a.town||a.city_block||a.quarter||a.village||a.neighbourhood||'';
    const city=a.city||a.county||a.state||a.province||'';
    const parts=[];
    if(district) parts.push(district);
    if(city&&city!==district) parts.push(city);
    // 臺→台：Nominatim 中文回「臺北市」，一般習慣寫「台北市」（英文不用替換）
    const name=EN()?parts.join(', '):parts.join(', ').replace(/臺/g,'台');
    _placeCache[key]=name;
    return name;
  }catch(_){ _placeCache[key]=''; return ''; }
}

/* 本地日期。toISOString() 是 UTC，台灣 +8 在半夜會退成前一天，
   檔名和圖上日期都會顯示昨天。 */
function localDate(){
  const d=new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')
         +'-'+String(d.getDate()).padStart(2,'0');
}
function lonToWorld(lon,z){return (lon+180)/360*TILE_SIZE*Math.pow(2,z);}
function latToWorld(lat,z){
  const r=lat*Math.PI/180;
  return (1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*TILE_SIZE*Math.pow(2,z);
}
/* 算出要抓哪些圖磚、各自畫在哪（匯出與預覽共用）。
   有 @2x 的來源（CARTO）在縮放 z 抓 512px 圖磚；沒有的（OSM）改抓 z+1，
   每格 256px 只佔一半的世界像素，清晰度才跟 @2x 一樣。 */
function tilePlan(z,K,cxZ,cyZ,mapW,mapH){
  const tp=TP();
  const zt=Math.min(tp.maxNativeZoom, z+(tp.hd?0:1));
  const ws=TILE_SIZE/Math.pow(2,zt-z);        // 一格 zt 圖磚在 z 世界像素裡的寬
  const n=Math.pow(2,zt);
  const tx0=Math.floor((cxZ-(mapW/2)/K)/ws), tx1=Math.floor((cxZ+(mapW/2)/K)/ws);
  const ty0=Math.max(0,Math.floor((cyZ-(mapH/2)/K)/ws)), ty1=Math.min(n-1,Math.floor((cyZ+(mapH/2)/K)/ws));
  const jobs=[];let ji=0;
  for(let tx=tx0;tx<=tx1;tx++) for(let ty=ty0;ty<=ty1;ty++)
    jobs.push({tx,ty,x:((tx%n)+n)%n,i:ji++});   // x 繞回 0..n-1，跨換日線也抓得到
  return {zt,jobs,rectOf:j=>({x:mapW/2+(j.tx*ws-cxZ)*K, y:mapH/2+(j.ty*ws-cyZ)*K, w:ws*K+1, h:ws*K+1})};
}
function tileURL(z,x,y,i,light){ return TP().url(z,x,y,light,i); }
/* 第一順位：fetch → blob → 解碼。blob 是同源資料，畫進 canvas 永遠不會污染它，
   所以只要這條路走得通，匯出就一定不會踩到 tainted canvas。 */
async function fetchTileBitmap(url){
  const ctrl=new AbortController();
  const tm=setTimeout(()=>ctrl.abort(),12000);   // 沒有 timeout 的話單顆慢 tile 會卡住整張圖
  try{
    const r=await fetch(url,{mode:'cors',credentials:'omit',signal:ctrl.signal});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const blob=await r.blob();
    if(window.createImageBitmap) return await createImageBitmap(blob);
    // 舊 Safari 沒有 createImageBitmap：改用 blob: URL 的 <img>，一樣是同源不污染
    const u=URL.createObjectURL(blob);
    try{
      return await new Promise((res,rej)=>{
        const im=new Image();
        im.onload=()=>res(im);im.onerror=()=>rej(new Error('decode failed'));
        im.src=u;
      });
    }finally{ setTimeout(()=>URL.revokeObjectURL(u),20000); }   // 太早 revoke 會讓還沒畫完的圖變空白
  }finally{ clearTimeout(tm); }
}
// 第二順位：<img crossOrigin>。伺服器有回 ACAO 就同樣安全，順便繞過 fetch 被擋的情況。
function corsTileImage(url){
  return new Promise((res,rej)=>{
    const im=new Image();
    im.crossOrigin='anonymous';
    im.onload=()=>res(im);im.onerror=()=>rej(new Error('img failed'));
    im.src=url;
  });
}
/* 兩段式備援；兩條都失敗就回 null，那一格留底色。
   刻意不退回「不設 crossOrigin 的 <img>」——那雖然畫得出來，但會污染 canvas
   讓整張圖匯不出去。缺一格 tile 遠比整張匯出失敗好。 */
async function loadTile(z,x,y,i,light){
  const url=tileURL(z,x,y,i,light);
  try{ return await fetchTileBitmap(url); }catch(_){}
  try{ return await corsTileImage(url); }catch(_){}
  return null;
}

/* ctx.filter 在舊版 Safari 沒有實作（設了會被無聲忽略），深色圖磚就不會被調色。
   偵測一次，不支援時改用合成模式模擬（見 paintTiles）：
   · brightness(k)：正常畫 1 次 + 用 'lighter' 再疊 (k−1) 次，等於逐通道乘 k 後截斷。
   · invert(1)：疊一層白色 'difference'，等於逐通道 255−v。hue-rotate 模擬不了，
     色相會偏，但明暗是對的。 */
const CTX_FILTER_OK=(()=>{
  try{
    const c=document.createElement('canvas').getContext('2d');
    c.filter='brightness(2)';
    return c.filter==='brightness(2)';
  }catch(_){ return false; }
})();
/* 把圖磚畫上去並依「來源 × 主題」調色，和地圖上 tilePane 的濾鏡一致。
   rectOf(job) 要回 {x,y,w,h}。呼叫端要先把 ctx clip 在地圖區。 */
function paintTiles(ctx,jobs,imgs,rectOf,light){
  const tp=TP(), th=light?'light':'dark', filter=tp.filter[th], emu=tp.emul[th];
  const pass=(alpha,mode)=>{
    ctx.save();
    ctx.globalAlpha=alpha;ctx.globalCompositeOperation=mode;
    jobs.forEach((j,n)=>{
      if(!imgs[n]) return;                       // 這格載入失敗，留底色
      const r=rectOf(j);
      ctx.drawImage(imgs[n],r.x,r.y,r.w,r.h);
    });
    ctx.restore();
  };
  if(!filter||filter==='none'){ pass(1,'source-over'); return; }
  if(CTX_FILTER_OK){
    ctx.save();
    ctx.filter=filter;
    pass(1,'source-over');
    ctx.restore();
    return;
  }
  pass(1,'source-over');
  if(emu&&emu.bright){
    for(let left=emu.bright-1;left>0.001;){
      const a=Math.min(1,left);
      pass(a,'lighter');
      left-=a;
    }
  }else if(emu&&emu.invert){
    /* 一次蓋滿整個 clip 區，不逐格畫——圖磚的矩形有 1px 重疊，
       逐格 difference 的話重疊那條會被反轉兩次，變成一條條亮縫。 */
    ctx.save();
    ctx.globalCompositeOperation='difference';ctx.fillStyle='#fff';
    ctx.fillRect(0,0,ctx.canvas.width,ctx.canvas.height);
    ctx.restore();
  }
}
/* 圖磚來源的版權標示，畫在地圖區底邊正中（比例尺在左下、logo 在右下）。 */
function drawTileCredit(ctx,mapW,mapH,sc,TH,F){
  ctx.save();
  ctx.font=`400 ${Math.max(6,Math.round(16*sc))}px ${F}`;
  ctx.textAlign='center';ctx.textBaseline='alphabetic';
  ctx.lineWidth=3*sc;ctx.strokeStyle=TH.overlayStroke;ctx.globalAlpha=.8;
  ctx.strokeText(TP().credit,mapW/2,mapH-8*sc);
  ctx.fillStyle=TH.overlay;ctx.fillText(TP().credit,mapW/2,mapH-8*sc);
  ctx.restore();
}
// 匯出圖片的地圖大頭針（畫在資訊欄地點名稱左邊）
function drawPin(ctx,cx,tipY,h,color,inner){
  const r=h*0.34, cy=tipY-h+r;
  ctx.save();
  ctx.fillStyle=color;
  ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx-r*0.72,cy+r*0.52);ctx.lineTo(cx+r*0.72,cy+r*0.52);ctx.lineTo(cx,tipY);
  ctx.closePath();ctx.fill();
  ctx.fillStyle=inner||'#fff';ctx.beginPath();ctx.arc(cx,cy,r*0.42,0,Math.PI*2);ctx.fill();
  ctx.restore();
}

// 匯出圖上的小人（canvas 版，對應地圖上的 personSVG）：本體＋反差色外框，
// footY 是腳底、對準路線上的當前位置。
function drawRunnerCanvas(ctx,x,footY,u,light,active){
  const P=PC(), BODY=P.runner, OUT=P['runner-out'];
  const g=runnerParts(x,footY,u,active);   // 幾何和地圖上的 personSVG 同一份
  const layer=(color,extra)=>{
    ctx.strokeStyle=color;
    g.parts.forEach(p=>{
      ctx.lineCap=p.cap;   // 軀幹必須 butt，否則圓端會把頭下方的空隙填掉
      ctx.lineWidth=(p.w+extra)*u;
      ctx.beginPath();
      ctx.moveTo(p.seg[0][0],p.seg[0][1]);
      ctx.lineTo(p.seg[1][0],p.seg[1][1]);
      ctx.stroke();
    });
    ctx.beginPath();ctx.arc(x,g.headY,g.hr+extra*u/2,0,Math.PI*2);
    ctx.fillStyle=color;ctx.fill();
  };
  ctx.save();ctx.lineJoin='round';ctx.setLineDash([]);
  layer(OUT,2.4);   // 外框整個加粗一圈墊底
  layer(BODY,0);
  ctx.restore();
}

/* 起訖點標記（匯出／預覽共用）。start 和 end 重疊時畫成一顆：
   左半邊是起點、右半邊是終點，和地圖上的 seIconMerged 同一個語彙。 */
function drawSEMarks(ctx,X,Y,r,lw,P){
  const glyphStart=(x,y)=>{ctx.beginPath();
    ctx.moveTo(x-r*0.30,y-r*0.42);ctx.lineTo(x+r*0.48,y);ctx.lineTo(x-r*0.30,y+r*0.42);
    ctx.closePath();ctx.fill();};
  const glyphEnd=(x,y)=>{const s2=r*0.66;ctx.fillRect(x-s2/2,y-s2/2,s2,s2);};
  const disc=(x,y,fill,glyph)=>{
    ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);
    ctx.fillStyle=fill;ctx.fill();
    ctx.lineWidth=3*lw;ctx.strokeStyle=P['on-accent'];ctx.stroke();
    ctx.fillStyle=P['on-accent'];glyph(x,y);
  };
  const same=S.start&&S.end&&map.distance(S.start,S.end)<2;
  if(same){
    const x=X(S.start.lng), y=Y(S.start.lat);
    [['l',P.start,glyphStart],['r',P.finish,glyphEnd]].forEach(([side,fill,glyph])=>{
      ctx.save();
      ctx.beginPath();
      // 多留 2*lw 讓外框描邊不會被裁掉
      ctx.rect(side==='l'?x-r-2*lw:x, y-r-2*lw, r+2*lw, (r+2*lw)*2);
      ctx.clip();
      disc(x,y,fill,glyph);
      ctx.restore();
    });
    return;
  }
  if(S.start) disc(X(S.start.lng),Y(S.start.lat),P.start,glyphStart);
  if(S.end)   disc(X(S.end.lng),  Y(S.end.lat),  P.finish,glyphEnd);
}

/* 匯出／預覽的方向箭頭：在已 translate+rotate 的座標系畫指向 +X 的箭頭。
   形狀讀 ARROW_STYLES（和地圖圖示同一份幾何），顏色吃 --rt-arrow
   ——以前地圖上是青色、匯出卻寫死金色，兩邊對不起來。 */
function drawChevron(ctx,base){
  const col=PC().arrow;
  ctx.save();
  // 轉角是幾何倒角做的，lineJoin 保持 miter 才不會又被圓一次
  ctx.lineCap='round'; ctx.lineJoin='miter'; ctx.setLineDash([]);
  arrowShapes().forEach(sh=>{
    const path=()=>{
      ctx.beginPath();
      arrowGeom(sh,arrowRadius).forEach(g=>{
        if(g.t==='M') ctx.moveTo(g.p[0]*base,g.p[1]*base);
        else if(g.t==='L') ctx.lineTo(g.p[0]*base,g.p[1]*base);
        else if(g.t==='Q') ctx.quadraticCurveTo(g.c[0]*base,g.c[1]*base,g.p[0]*base,g.p[1]*base);
        else if(g.t==='Z') ctx.closePath();
      });
    };
    /* 先帶陰影畫一次，把箭頭從底下的路線襯出來。
       地圖上的箭頭是 SVG 的 drop-shadow，匯出這邊得自己補，
       否則淺色模式的白箭頭疊在未跑路線上只有 1.84:1，等於看不見。 */
    // 強度依主題（見 ARROW_SHADOW）：淺色模式要深很多，因為白箭頭全靠它才看得見
    const shc=ARROW_SHADOW[isLight()?'light':'dark'];
    for(let i=0;i<shc.passes;i++){
      ctx.shadowColor=shc.color;
      ctx.shadowBlur=Math.max(2, base*shc.blurK);
      path();
      if(sh.mode==='fill'){ ctx.fillStyle=col; ctx.fill(); }
      else { ctx.strokeStyle=col; ctx.lineWidth=Math.max(2, sh.w*base); ctx.stroke(); }
    }
    // 第二次不帶陰影，免得補的描邊又疊一層陰影把顏色壓暗
    ctx.shadowColor='transparent'; ctx.shadowBlur=0;
    path();
    if(sh.mode==='fill'){
      ctx.fillStyle=col; ctx.fill();
      // 補一圈細描邊，讓填色造型在縮圖尺寸下不會被抗鋸齒吃掉
      ctx.strokeStyle=col; ctx.lineWidth=Math.max(1,0.08*base); ctx.stroke();
    }else{
      ctx.strokeStyle=col; ctx.lineWidth=Math.max(2, sh.w*base); ctx.stroke();
    }
  });
  ctx.restore();
}

/* 匯出圖片與對話框預覽共用的主題色：圖片跟著 App 的深／淺色主題走 */
function exportTheme(light){
  return light?{
    mapBg:'#e8ecf1',
    infoBg:'#ffffff', infoLine:'#dfe4ea', textMain:'#1a1d22', textDim:'#6b727d',
    overlay:'#1a1d22', overlayStroke:'rgba(255,255,255,.85)'
  }:{
    mapBg:'#262a30',
    infoBg:'#14171c', infoLine:'#2b313b', textMain:'#f4f6f8', textDim:'#8b929c',
    overlay:'#fff', overlayStroke:'rgba(0,0,0,.75)'
  };
}
const EXPORT_FONT='"Microsoft JhengHei","PingFang TC",system-ui,sans-serif';

/* 畫整張分享圖。匯出（1080 寬）與對話框預覽（300 寬）都呼叫這一個函式，
   差別只有縮放 sc 與 preview 旗標——以前兩邊各寫一份，主題色、箭頭大小、
   浮水印好幾次對不起來。
   preview=true 時：圖磚走快取、底圖關閉畫棋盤格示意透明、地點名稱用呼叫端給的
   （不等網路）；stale() 回 true 代表已經有更新的重畫請求，這次直接放棄（回傳 null）。 */
async function renderScene(ctx,W,H,sc,opt,{preview=false,stale=()=>false,place=null}={}){
  const P=PC(), light=isLight(), TH=exportTheme(light), F=EXPORT_FONT;
  const dats=(opt.dats||['dist','pace','time','elev']).filter(Boolean);
  const showStats=dats.length>0;
  const showPlace=opt.place!==false, showDate=opt.date!==false;
  const placeRowOn=showPlace||showDate;
  const elevOn=!!(opt.elevchart && elevChartData);
  const statsH=(placeRowOn?PLACE_ROW_H*sc:0)+(showStats?STATS_ROW_H*sc:0);
  const elevBandH=elevOn?ELEV_BAND_H*sc:0;
  const infoH=statsH+elevBandH;      // 兩塊都關＝不畫資訊欄、地圖佔滿整張（配合透明背景做純路線圖）
  const showInfo=infoH>0;
  const mapW=W, mapH=H-infoH;
  const frac=(opt.frac!=null)?opt.frac:1;
  let tilesFailed=false;

  const info=pl=>drawInfoPanel(ctx,{mapW,mapH,statsH,elevBandH,infoH,sc,TH,P,F,
    dats,place:pl,light,frac,showStats,elevOn,showInfo,showPlace,showDate,placeRowOn});

  ctx.clearRect(0,0,W,H);
  // 地圖區底色：basemap 開＝純色(稍後 tile 蓋滿)、關＝保持透明(做去背 PNG)
  if(opt.basemap){ ctx.fillStyle=TH.mapBg;ctx.fillRect(0,0,mapW,mapH); }
  const pts=pngCollectPts(opt);
  if(!pts.length){ info(place||''); return {tilesFailed}; }

  // 在「世界像素(z0)」裡算，避免經緯度在 Mercator 上被拉伸；路線置中、保留真實比例
  const lats=pts.map(p=>p[0]), lons=pts.map(p=>p[1]);
  const wx0=lonToWorld(Math.min(...lons),0), wx1=lonToWorld(Math.max(...lons),0);
  const wy0=latToWorld(Math.max(...lats),0), wy1=latToWorld(Math.min(...lats),0);
  const cx=(wx0+wx1)/2, cy=(wy0+wy1)/2;
  const dx=Math.max(wx1-wx0,1e-9)*1.16, dy=Math.max(wy1-wy0,1e-9)*1.16;  // 8% 邊界
  const s=Math.min(mapW/dx, mapH/dy)*0.9;    // canvas px / z0世界px；0.9 留邊
  const z=Math.max(1,Math.min(19,Math.floor(Math.log2(s))));
  const K=s/Math.pow(2,z);                    // 落在 [1,2)，@2x tile 縮小繪製最清晰
  const cxZ=cx*Math.pow(2,z), cyZ=cy*Math.pow(2,z);
  const X=lon=>mapW/2+(lonToWorld(lon,z)-cxZ)*K;
  const Y=lat=>mapH/2+(latToWorld(lat,z)-cyZ)*K;
  const cLat=(Math.min(...lats)+Math.max(...lats))/2, cLon=(Math.min(...lons)+Math.max(...lons))/2;

  ctx.save();ctx.beginPath();ctx.rect(0,0,mapW,mapH);ctx.clip();
  if(opt.basemap){
    const plan=tilePlan(z,K,cxZ,cyZ,mapW,mapH);
    if(!preview) busy('下載底圖…');
    const imgs=await Promise.all(plan.jobs.map(j=>preview
      ? loadTileCached(plan.zt,j.x,j.ty,light) : loadTile(plan.zt,j.x,j.ty,j.i,light)));
    if(stale()){ ctx.restore(); return null; }
    paintTiles(ctx,plan.jobs,imgs,plan.rectOf,light);
    // 一格都沒抓到就等於沒有底圖：回報給呼叫端，讓它能提醒使用者而不是默默給張空白底
    if(plan.jobs.length && imgs.every(im=>!im)) tilesFailed=true;
    if(!preview) busy('產生圖片…');
  }else if(preview){
    const gs=Math.max(12,mapW/14);
    ctx.fillStyle='rgba(128,128,128,.12)';
    for(let yy=0;yy<mapH;yy+=gs)for(let xx=0;xx<mapW;xx+=gs)
      if(((xx/gs|0)+(yy/gs|0))%2) ctx.fillRect(xx,yy,gs,gs);
  }

  // 手繪線：路線通常正好貼著它跑，所以畫得比路線寬，當成路線底下透出來的光暈
  ctx.lineJoin=ctx.lineCap='round';
  if(opt.draw){
    ctx.strokeStyle=P.guide; ctx.lineWidth=(opt.route?15:5)*sc; ctx.globalAlpha=.9;
    S.strokes.forEach(st=>{
      ctx.beginPath();
      st.pts.forEach((p,k)=>{const x=X(p.lng),y=Y(p.lat);k?ctx.lineTo(x,y):ctx.moveTo(x,y);});
      ctx.stroke();
    });
    ctx.globalAlpha=1;
  }
  // 路線：先畫完整路線當「未走過」底層，再把走過的部分（到 frac）蓋上去，小人站在分界
  let runnerHead=null;
  if(opt.route){
    S.result.segments.forEach(sg=>{
      const draw=sg.kind==='draw';
      ctx.strokeStyle=draw?P.pending:P.connector;
      ctx.lineWidth=(draw?10.5:2.5)*sc;
      ctx.setLineDash(draw?[]:[10*sc,9*sc]);
      ctx.beginPath();
      sg.pts.forEach((p,k)=>{const x=X(p[1]),y=Y(p[0]);k?ctx.lineTo(x,y):ctx.moveTo(x,y);});
      ctx.stroke();
    });
    ctx.setLineDash([]);
    if(S.path&&S.path.length>1&&S.totalM>0&&frac>0){
      const target=S.totalM*frac, idx=pvIndexAt(target);
      const shown=S.path.slice(0,Math.max(idx+1,1)).map(p=>[p[0],p[1]]);
      let head=S.path[Math.max(idx,0)];
      if(idx>0){
        const seg=S.cum[idx]-S.cum[idx-1],t=seg>0?(target-S.cum[idx-1])/seg:0;
        const a=S.path[idx-1],b=S.path[idx];
        head=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
        shown[shown.length-1]=head;
      }
      ctx.strokeStyle=P.done;ctx.lineWidth=8*sc;
      ctx.beginPath();
      shown.forEach((p,k)=>{const x=X(p[1]),y=Y(p[0]);k?ctx.lineTo(x,y):ctx.moveTo(x,y);});
      ctx.stroke();
      if(frac<1) runnerHead=head;   // 跑完(100%)就不畫小人，避免杵在終點
    }
  }
  // 方向箭頭：每 200m 一個、兩節點 <30m 跳過、走過的路段不顯示
  if(opt.arrows && S.path && S.path.length>=2 && S.totalM>0){
    const curD=S.totalM*frac;
    for(let targetD=200; targetD<S.totalM-20; targetD+=200){
      if(targetD<=curD) continue;
      const i=pvIndexAt(targetD);
      if(i<1) continue;
      const a=S.path[i-1], b=S.path[i];
      if(S.cum[i]-S.cum[i-1]<30) continue;
      const ax=X(a[1]), ay=Y(a[0]), bx=X(b[1]), by=Y(b[0]);
      if(ax===bx && ay===by) continue;
      ctx.save();
      ctx.translate((ax+bx)/2,(ay+by)/2);
      ctx.rotate(Math.atan2(by-ay,bx-ax));
      drawChevron(ctx,Math.max(4,6*sc));
      ctx.restore();
    }
  }
  if(opt.marks) drawSEMarks(ctx,X,Y,15*sc,sc,P);
  if(runnerHead) drawRunnerCanvas(ctx,X(runnerHead[1]),Y(runnerHead[0]),1.69*sc,light,false);
  ctx.restore();

  if(opt.scale!==false) drawScaleBar(ctx,{mapW,mapH,sc,z,K,cLat,TH,F});
  if(opt.basemap&&!tilesFailed) drawTileCredit(ctx,mapW,mapH,sc,TH,F);
  if(opt.logo!==false){
    const lg=await loadLogoBitmap(light);
    if(stale()) return null;
    drawExportLogo(ctx,lg,mapW,mapH,sc);
  }
  // 沒有資訊欄、又把 logo 關掉時，才用文字浮水印墊底——否則會和右下角的 logo 疊在一起
  if(!showInfo && opt.logo===false){
    ctx.font=`600 ${Math.round(24*sc)}px ${F}`;ctx.textAlign='right';ctx.textBaseline='alphabetic';
    ctx.lineWidth=4*sc;ctx.strokeStyle=TH.overlayStroke;
    ctx.strokeText('RUNNING ART',mapW-26*sc,mapH-24*sc);
    ctx.globalAlpha=.92;ctx.fillStyle=TH.overlay;ctx.fillText('RUNNING ART',mapW-26*sc,mapH-24*sc);
    ctx.globalAlpha=1;
  }
  let pl=place;
  if(pl==null){
    if(showInfo&&showPlace){ busy('查詢地點…'); pl=await getPlaceName(cLat,cLon); }
    else pl='';
  }
  if(stale()) return null;
  info(pl);
  return {tilesFailed,cLat,cLon};
}

async function renderExportCanvas(opt){
  const [W,H]=PNG_RATIOS[opt.ratio]||PNG_RATIOS['1:1'];
  const cv=document.createElement('canvas');
  cv.width=W;cv.height=H;
  const r=await renderScene(cv.getContext('2d'),W,H,W/1080,opt);
  return {canvas:cv, w:W, h:H, tilesFailed:r.tilesFailed};
}

/* canvas → Blob。canvas 若被跨域圖磚污染，toBlob 會丟 SecurityError
   （有些瀏覽器是把 null 傳進 callback），兩種都要當成失敗。 */
function canvasToBlob(cv){
  return new Promise((resolve,reject)=>{
    let done=false;
    try{
      cv.toBlob(b=>{
        if(done) return;
        done=true;
        b?resolve(b):reject(new Error('toBlob returned null'));
      },'image/png');
    }catch(e){ if(!done){ done=true; reject(e); } }
  });
}
/* 真正判斷 canvas 有沒有被污染。只讀 1 個 pixel，成本可忽略，
   而且比等 toBlob 失敗更早、更明確。 */
function canvasIsTainted(cv){
  try{ cv.getContext('2d').getImageData(0,0,1,1); return false; }
  catch(_){ return true; }
}

let _shotUrl='';      // 目前結果對話框正在顯示的 blob: URL
let _shotBlob=null;   // 同一張圖的 Blob，分享用
let _shotName='';
async function exportPNG(opt){
  busy('產生圖片…');
  try{
    let out=await renderExportCanvas(opt);
    let degraded='';

    // 降級 1：底圖污染了 canvas → 拿掉底圖重畫一次，仍然給得出一張純向量 PNG
    if(opt.basemap && canvasIsTainted(out.canvas)){
      busy('底圖受限，改產生無底圖版本…');
      out=await renderExportCanvas(Object.assign({},opt,{basemap:false}));
      degraded=tx('底圖被瀏覽器的跨域限制擋住，已改成無底圖的透明背景版本。',
                  'The base map was blocked by browser cross-origin rules, so this is the transparent no-basemap version.');
    }else if(opt.basemap && out.tilesFailed){
      degraded=tx('底圖圖磚下載失敗（可能是網路問題），路線本身不受影響。',
                  'Base map tiles failed to download (network issue). The route itself is unaffected.');
    }

    let blob;
    try{
      blob=await canvasToBlob(out.canvas);
    }catch(e){
      // 降級 2：toBlob 掛了但畫面沒被污染（記憶體不足等），退回 toDataURL
      let durl='';
      try{ durl=out.canvas.toDataURL('image/png'); }catch(_){}
      if(!durl) throw new Error(tx('這張圖無法轉存，請取消勾選「地圖底圖」後再試一次。',
                                   'This image could not be encoded. Try turning off the base map layer.'));
      blob=await (await fetch(durl)).blob();
    }

    showExportResult(blob,out.w,out.h,degraded);
  }catch(err){
    toast(tx('產生圖片失敗：','Image export failed: ')+err.message,3600);
  }finally{ busy(''); }
}

/* 把成品交給使用者。關鍵是「不在這裡自動觸發下載」：
   非同步結束後的 a.click() 在 Safari／iOS 會被當成非使用者手勢的彈窗而靜默擋掉。
   由使用者按「儲存圖片」，那個 click 才是有效手勢。 */
function showExportResult(blob,w,h,note){
  if(_shotUrl) URL.revokeObjectURL(_shotUrl);
  _shotBlob=blob;
  _shotUrl=URL.createObjectURL(blob);
  _shotName='RunningArt_'+localDate()+'.png';
  $('pngShot').src=_shotUrl;
  const size=w+'×'+h;
  const canShare=!!(navigator.canShare&&navigator.share&&
    (()=>{ try{ return navigator.canShare({files:[new File([blob],_shotName,{type:'image/png'})]}); }
           catch(_){ return false; } })());
  $('pngShare').hidden=!canShare;
  const hints=[size];
  hints.push(canShare?tx('可按「分享」存到相簿，或長按圖片儲存。',
                         'Use Share to save to your photos, or long-press the image.')
                    :tx('手機也可以長按上面的圖片儲存。',
                         'On a phone you can also long-press the image to save it.'));
  if(note) hints.push('⚠ '+note);
  $('pngHint').textContent=hints.join('　·　');
  $('pngResult').hidden=false;
}
function closeExportResult(){
  $('pngResult').hidden=true;
  $('pngShot').removeAttribute('src');
  if(_shotUrl) URL.revokeObjectURL(_shotUrl);
  _shotUrl='';_shotBlob=null;
}
let pngRatio='1:1';
// 要涵蓋的地理範圍：勾了哪些圖層就把哪些點算進來（全沒勾時至少用路線）
function pngCollectPts(opt){
  const pts=[];
  if(opt.route&&S.result) S.result.segments.forEach(sg=>sg.pts.forEach(p=>pts.push(p)));
  if(opt.draw) S.strokes.forEach(s=>s.pts.forEach(p=>pts.push([p.lat,p.lng])));
  if(!pts.length&&S.result) S.result.segments.forEach(sg=>sg.pts.forEach(p=>pts.push(p)));
  if(opt.marks){ if(S.start)pts.push([S.start.lat,S.start.lng]); if(S.end)pts.push([S.end.lat,S.end.lng]); }
  return pts;
}
// 圖層是「填色多選按鈕」（同比例按鈕樣式），選取＝加上 .on。狀態直接讀 class。
const layerOn=name=>{const b=document.querySelector('.lyr[data-layer="'+name+'"]');return !!(b&&b.classList.contains('on'));};
// 資訊欄數據項也是填色多選按鈕（與圖層區分開）
const datOn=name=>{const b=document.querySelector('.dat[data-dat="'+name+'"]');return b&&b.classList.contains('on')?name:null;};
// 匯出預覽的底圖 tile 快取：同一顆 tile 只抓一次，之後 toggle/拖桿都用快取重畫。
const _tileCache={};
async function loadTileCached(z,x,y,light){
  const k=tileProvider+'/'+(light?'l':'d')+'/'+z+'/'+x+'/'+y;
  if(k in _tileCache) return _tileCache[k];
  const img=await loadTile(z,x,y,(x%4)+(y%4),light);   // 與匯出共用同一套安全載入
  _tileCache[k]=img;
  return img;
}
let _prevToken=0;
let _previewPlace='', _previewPlaceKey='';   // 預覽用的地點名稱（非同步查回來後重畫）
function collectExportOpt(){
  return {ratio:pngRatio,route:layerOn('route'),arrows:layerOn('arrows'),draw:layerOn('draw'),
          marks:layerOn('marks'),basemap:layerOn('basemap'),elevchart:layerOn('elevchart'),
          scale:layerOn('scale'),place:layerOn('place'),date:layerOn('date'),logo:layerOn('logo'),
          dats:['dist','pace','time','elev','fit'].filter(n=>datOn(n)),
          frac:+$('pngProg').value/1000};
}
/* 對話框的即時預覽：和匯出同一個 renderScene，先畫在離屏畫布、畫完才貼上，
   避免抓圖磚的空檔讓預覽閃一下空白。 */
async function renderPreview(){
  const cv=$('pngPrev'); if(!cv||!S.result) return;
  const myTok=++_prevToken;
  const opt=collectExportOpt();
  const [RW,RH]=PNG_RATIOS[pngRatio]||PNG_RATIOS['1:1'];
  const W=cv.width, sc=W/RW, H=Math.round(RH*sc);
  const off=document.createElement('canvas'); off.width=W; off.height=H;
  const r=await renderScene(off.getContext('2d'),W,H,sc,opt,
    {preview:true,stale:()=>myTok!==_prevToken,place:_previewPlace});
  if(!r||myTok!==_prevToken) return;
  cv.height=H; cv.getContext('2d').drawImage(off,0,0);

  /* 地點名稱要連網查（Nominatim）。預覽不能等它，所以先用快取的值畫，
     查回來之後再重畫一次。getPlaceName 自己有記憶體快取，不會重複請求。 */
  if(opt.place!==false && r.cLat!=null){
    const key=lang+':'+r.cLat.toFixed(3)+','+r.cLon.toFixed(3);
    if(_previewPlaceKey!==key){
      _previewPlaceKey=key;
      getPlaceName(r.cLat,r.cLon).then(n=>{
        if(_previewPlaceKey!==key || n===_previewPlace) return;
        _previewPlace=n;
        renderPreview();
      }).catch(()=>{});
    }
  }
}
/* ---------- 匯出圖片用的 Logo ----------
   兩個檔案的 <svg> 是 width="100%" height="100%"，當成 <img> 載入時沒有明確的
   內在尺寸，某些瀏覽器會算成 0 而畫不出來。所以先把文字抓下來、把百分比換成
   viewBox 的實際尺寸，再包成 blob——blob 是同源的，畫進 canvas 也不會污染它
   （和圖磚走同一套安全路徑）。 */
const _logoCache={};
async function loadLogoBitmap(light){
  const file=light?'logo_bright.svg':'logo_dark.svg';
  if(file in _logoCache) return _logoCache[file];
  let out=null;
  try{
    const r=await fetch(file,{cache:'force-cache'});
    if(r.ok){
      let txt=await r.text();
      const vb=(txt.match(/viewBox="([\d.\s-]+)"/)||[])[1];
      const wh=vb?vb.trim().split(/\s+/):null;
      if(wh&&wh.length===4)
        txt=txt.replace(/(<svg[^>]*?)width="[^"]*"\s*height="[^"]*"/,
                        '$1width="'+wh[2]+'" height="'+wh[3]+'"');
      const blob=new Blob([txt],{type:'image/svg+xml'});
      if(window.createImageBitmap){
        try{ out=await createImageBitmap(blob); }catch(_){}
      }
      if(!out){
        const u=URL.createObjectURL(blob);
        try{
          out=await new Promise((res,rej)=>{
            const im=new Image();
            im.onload=()=>res(im); im.onerror=()=>rej(new Error('svg decode'));
            im.src=u;
          });
        }catch(_){}
        finally{ setTimeout(()=>URL.revokeObjectURL(u),20000); }
      }
    }
  }catch(_){}
  _logoCache[file]=out;
  return out;
}
/* 畫在地圖區右下角，和比例尺同一個 26u 邊距。
   比例尺在左下（最寬到 mapW*0.3），logo 在右下，兩者不會撞到。 */
function drawExportLogo(ctx,img,mapW,mapH,sc){
  if(!img) return;
  const size=84*sc, pad=26*sc;
  ctx.save();
  ctx.globalAlpha=.95;
  ctx.drawImage(img, mapW-pad-size, mapH-pad-size, size, size);
  ctx.restore();
}

/* 比例尺。匯出和預覽共用——預覽以前根本沒畫，所以「比例尺」這個選項
   在預覽上看不出任何差別。sc 是縮放係數，z/K 是該畫面的縮放層級與係數。 */
function drawScaleBar(ctx,o){
  const {mapW,mapH,sc,z,K,cLat,TH,F}=o;
  const mPerPx=156543.03392*Math.cos(cLat*Math.PI/180)/Math.pow(2,z)/K;
  const NICE=[10,20,50,100,200,500,1000,2000,5000];
  let barM=NICE[0];
  for(const v of NICE) if(v/mPerPx<=mapW*0.3) barM=v;
  const barPx=barM/mPerPx, bx=26*sc, tick=6*sc, by=mapH-26*sc;
  ctx.save();
  ctx.textBaseline='alphabetic'; ctx.textAlign='center'; ctx.setLineDash([]);
  const drawBar=()=>{ctx.beginPath();ctx.moveTo(bx,by);ctx.lineTo(bx+barPx,by);
    ctx.moveTo(bx,by-tick);ctx.lineTo(bx,by+tick);
    ctx.moveTo(bx+barPx,by-tick);ctx.lineTo(bx+barPx,by+tick);ctx.stroke();};
  ctx.strokeStyle=TH.overlayStroke;ctx.lineWidth=6*sc;drawBar();
  ctx.strokeStyle=TH.overlay;ctx.lineWidth=2.5*sc;drawBar();
  ctx.font=`600 ${Math.max(7,Math.round(30*sc))}px ${F}`;
  const barTxt=barM>=1000?(barM/1000)+' km':barM+' m';
  const barMid=bx+barPx/2;   // 距離文字置中於線段中間
  ctx.lineWidth=5*sc;ctx.strokeStyle=TH.overlayStroke;
  ctx.strokeText(barTxt,barMid,by-14*sc);
  ctx.fillStyle=TH.overlay;ctx.fillText(barTxt,barMid,by-14*sc);
  ctx.restore();
}

/* 資訊欄：地點/日期 + 數據 + 高程圖。
   匯出（1080px）和對話框預覽（300px 縮圖）呼叫同一份，差別只在 sc 這個縮放係數，
   所以預覽看到的排版、字級比例、每個東西的位置就是成品的樣子。
   以前預覽只畫幾個灰色方塊示意，跟成品對不起來。 */
function drawInfoPanel(ctx,o){
  const {mapW,mapH,statsH,elevBandH,infoH,sc,TH,P,F,dats,place,light,frac,
         showStats,elevOn,showInfo,showPlace,showDate,placeRowOn}=o;
  const pad=36*sc;
  if(showInfo){
    ctx.fillStyle=TH.infoBg;ctx.fillRect(0,mapH,mapW,infoH);
    ctx.fillStyle=TH.infoLine;ctx.fillRect(0,mapH,mapW,Math.max(1,2*sc));
  }
  /* 兩列各自可關，所以位置用「絕對位移」算，不能再用 statsH 的比例——
     地點列關掉時 statsH 會變小，用比例的話數據列會跟著跑掉。 */
  if(placeRowOn){
    const rowY=mapH+PLACE_ROW_H*sc*0.605;
    ctx.textBaseline='middle';
    if(showPlace&&place){
      const ph=34*sc;
      drawPin(ctx,pad+ph*0.32,rowY+ph*0.5,ph,P.ui,P['ui-text']);
      ctx.textAlign='left';ctx.fillStyle=TH.textMain;ctx.font=`600 ${Math.round(37*sc)}px ${F}`;
      ctx.fillText(place,pad+ph*0.9,rowY);
    }
    if(showDate){
      ctx.textAlign='right';ctx.fillStyle=TH.textDim;ctx.font=`400 ${Math.round(28*sc)}px ${F}`;
      ctx.fillText(localDate(),mapW-pad,rowY);
    }
  }
  if(showStats){
    const top=mapH+(placeRowOn?PLACE_ROW_H*sc:0);
    ctx.textBaseline='middle';

    const pm=Math.floor(S.pace), ps=Math.round((S.pace-pm)*60);
    const elevTxt=(S.elevGain!=null)?('↑'+S.elevGain+' ↓'+S.elevLoss+' m'):'–';
    const labelMap={dist:tx('距離','Distance'),pace:tx('配速','Pace'),time:tx('時間','Time'),
                    elev:tx('爬升','Elev.'),fit:tx('吻合度','Match')};
    const valMap={dist:$('sDist').textContent, pace:pm+':'+String(ps).padStart(2,'0')+' /km',
                  time:$('sTime').textContent, elev:elevTxt, fit:$('sFit').textContent};
    const cells=dats.map(d=>[labelMap[d],valMap[d]]);
    /* 欄寬按「內容實際多寬」分配，不是平均切。
       平均切的問題：五項全開時每欄只有 201px，而「↑142 ↓138 m」就要 240px，
       於是它被縮到很小、又幾乎頂到隔壁欄，整排看起來黏成一串。 */
    const gap=26*sc;
    const avail=mapW-pad*2-gap*(cells.length-1);
    /* 項目越多，字級起點放低一點。純靠自動縮放的話五項會剛好塞滿整個寬度、
       欄距只剩最低限度，整排還是像一堵字牆。 */
    let valFs=(cells.length>=5?38:cells.length===4?42:46)*sc, labelFs=25*sc;
    ctx.font=`600 ${Math.round(valFs)}px ${F}`;
    let widths=cells.map(c=>ctx.measureText(c[1]).width);
    ctx.font=`400 ${Math.round(labelFs)}px ${F}`;
    widths=widths.map((w,i)=>Math.max(w,ctx.measureText(cells[i][0]).width));
    let total=widths.reduce((a,b)=>a+b,0);
    if(total>avail){                     // 真的塞不下才整排等比例縮小
      const k=avail/total;
      valFs*=k; labelFs*=k; widths=widths.map(w=>w*k); total=avail;
    }
    const extra=cells.length>1?(avail-total)/(cells.length-1):0;
    ctx.textAlign='left';
    let cx=pad;
    cells.forEach((c,n)=>{
      ctx.fillStyle=TH.textDim;ctx.font=`400 ${Math.round(labelFs)}px ${F}`;
      ctx.fillText(c[0],cx,top+STATS_ROW_H*sc*0.306);
      ctx.fillStyle=TH.textMain;ctx.font=`600 ${Math.round(valFs)}px ${F}`;
      ctx.fillText(c[1],cx,top+STATS_ROW_H*sc*0.694);
      cx+=widths[n]+gap+extra;
    });
  }

  /* 高程區：整條寬的折線圖，上面留一行放標題和浮水印。 */
  if(elevOn){
    const bTop=mapH+statsH, headY=bTop+30*sc;
    ctx.textBaseline='middle';
    ctx.textAlign='left';ctx.fillStyle=TH.textDim;
    ctx.font=`400 ${Math.round(25*sc)}px ${F}`;
    ctx.fillText(tx('高程變化','Elevation'),pad,headY);
    ctx.textAlign='right';ctx.globalAlpha=.75;
    ctx.font=`600 ${Math.round(23*sc)}px ${F}`;
    ctx.fillText('RUNNING ART',mapW-pad,headY);
    ctx.globalAlpha=1;
    drawElevProfileCanvas(ctx, pad, bTop+50*sc, mapW-pad*2, elevBandH-50*sc-22*sc, light, frac);
  }else if(showStats){
    // 沒有高程區時，浮水印放數據區右下角（地圖區維持乾淨）
    ctx.textBaseline='alphabetic';ctx.textAlign='right';
    ctx.fillStyle=TH.textDim;ctx.globalAlpha=.75;
    ctx.font=`600 ${Math.round(23*sc)}px ${F}`;
    ctx.fillText('RUNNING ART',mapW-pad,mapH+statsH-18*sc);
    ctx.globalAlpha=1;
  }
}

/* frac：跑者進度（0..1）。傳了就在折線上標出跑者當前所在的高度點。 */
function drawElevProfileCanvas(ctx, x, y, w, h, light, frac){
  const P = PC();
  if(!elevChartData || !elevChartData.elevations || elevChartData.elevations.length < 2) return;
  const elevations = elevChartData.elevations;
  let minE = Infinity, maxE = -Infinity, minIdx = 0, maxIdx = 0;
  elevations.forEach((e, i) => {
    if(e < minE){ minE = e; minIdx = i; }
    if(e > maxE){ maxE = e; maxIdx = i; }
  });
  const rangeE = Math.max(10, maxE - minE);

  ctx.save();
  ctx.translate(x, y);

  /* 內部尺寸全部跟著方框高度縮放（u=1 對應匯出時的 70px 高）。
     以前是寫死的 10px 字 / 2.2px 線寬，所以同一份程式在 1080px 的匯出圖上細如髮絲、
     在 300px 的預覽縮圖上又大得爆框。 */
  const u = h / 70;

  ctx.fillStyle = light ? 'rgba(255,255,255,0.85)' : 'rgba(20,23,28,0.85)';
  ctx.beginPath();
  if(ctx.roundRect) ctx.roundRect(0, 0, w, h, 8 * u);
  else ctx.rect(0, 0, w, h);
  ctx.fill();

  /* 上下留給最高／最低標籤的空白帶用比例算，方框變高時標籤才不會黏在邊上。
     和 App 內的 EL_PADT/EL_PADB 是同一個用意。 */
  const padL = 12 * u, padR = 12 * u;
  const padT = Math.max(14 * u, h * 0.26), padB = Math.max(12 * u, h * 0.24);
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const lblGap = Math.max(12 * u, h * 0.20);

  ctx.beginPath();
  elevations.forEach((e, idx) => {
    const px = padL + (idx / (elevations.length - 1)) * chartW;
    const py = padT + chartH - ((e - minE) / rangeE) * chartH;
    if(idx === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });

  ctx.strokeStyle = P.elev;
  ctx.lineWidth = Math.max(0.6, 2.2 * u);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.lineTo(w - padR, padT + chartH);
  ctx.lineTo(padL, padT + chartH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
  grad.addColorStop(0, hexA(P.elev, 0.40));
  grad.addColorStop(1, hexA(P.elev, 0.02));
  ctx.fillStyle = grad;
  ctx.fill();

  /* 最高／最低點：以前只有兩行字釘在左上和右上角，跟實際位置無關，
     看不出峰谷落在路線的哪一段。改成在折線上真的標出那兩個點，字跟著點走。 */
  const at = idx => ({
    px: padL + (idx / (elevations.length - 1)) * chartW,
    py: padT + chartH - ((elevations[idx] - minE) / rangeE) * chartH
  });
  const dot = (p, fill) => {
    ctx.beginPath();
    ctx.arc(p.px, p.py, 3.4 * u, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 1.6 * u;
    ctx.strokeStyle = light ? 'rgba(255,255,255,.95)' : 'rgba(20,23,28,.95)';
    ctx.stroke();
  };
  /* 標籤不加底色方塊（那會蓋掉底下的折線），改用描邊當光暈把字襯出來。
     水平位置夾在方框內，貼著點但不會被切掉。 */
  /* 標籤＝山峰／山谷圖示（和 App 內高程圖同一組路徑 ELEV_PEAK／ELEV_VALLEY）＋數字。
     圖示和字一起置中、一起夾在方框內，外面描一圈光暈襯出來。 */
  const label = (p, iconPath, text, color, above) => {
    const fs = Math.max(7, 11 * u);
    ctx.font = `bold ${fs}px sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const isz = fs * 0.95, gap = fs * 0.25;
    const tw = ctx.measureText(text).width, total = isz + gap + tw;
    let cx = Math.max(total / 2 + 3 * u, Math.min(w - total / 2 - 3 * u, p.px));
    let cy = above ? p.py - lblGap : p.py + lblGap;
    cy = Math.max(fs * 0.6 + 1 * u, Math.min(h - fs * 0.6 - 1 * u, cy));
    const x0 = cx - total / 2;
    const halo = light ? 'rgba(255,255,255,0.9)' : 'rgba(10,13,17,0.9)';
    ctx.lineWidth = Math.max(1.4, 2.6 * u);
    ctx.lineJoin = 'round';
    ctx.save();
    ctx.translate(x0, cy - isz / 2);
    ctx.scale(isz / 24, isz / 24);
    const ico = new Path2D(iconPath);
    ctx.lineWidth = Math.max(1.4, 2.6 * u) * 24 / isz;
    ctx.strokeStyle = halo; ctx.stroke(ico);
    ctx.fillStyle = color; ctx.fill(ico);
    ctx.restore();
    ctx.strokeStyle = halo;
    ctx.strokeText(text, x0 + isz + gap, cy);
    ctx.fillStyle = color;
    ctx.fillText(text, x0 + isz + gap, cy);
  };

  const maxP = at(maxIdx), minP = at(minIdx);
  dot(maxP, P.elev);
  dot(minP, P['elev-dim']);

  // 跑者目前的高度：和地圖上的小人、拉桿是同一個 frac，位置才會一致
  if(frac != null && frac > 0 && frac < 1){
    const f = Math.max(0, Math.min(1, frac));
    const idxF = f * (elevations.length - 1);
    const i0 = Math.floor(idxF), t = idxF - i0;
    const e1 = elevations[Math.min(i0, elevations.length - 1)];
    const e2 = elevations[Math.min(i0 + 1, elevations.length - 1)];
    const e = e1 + (e2 - e1) * t;
    const rp = {
      px: padL + f * chartW,
      py: padT + chartH - ((e - minE) / rangeE) * chartH
    };
    ctx.beginPath();
    ctx.arc(rp.px, rp.py, 4 * u, 0, Math.PI * 2);
    ctx.fillStyle = P.runner;
    ctx.fill();
    ctx.lineWidth = 2 * u;
    ctx.strokeStyle = P['runner-out'];
    ctx.stroke();
  }

  // 最高固定在點的上方、最低固定在下方（上下的空白帶就是為此保留的）
  label(maxP, ELEV_PEAK, `${Math.round(maxE)} m`, P.elev, true);
  label(minP, ELEV_VALLEY, `${Math.round(minE)} m`, P['elev-dim'], false);

  ctx.restore();
}
document.querySelectorAll('.rt[data-ratio]').forEach(b=>b.onclick=()=>{
  pngRatio=b.dataset.ratio;
  document.querySelectorAll('.rt[data-ratio]').forEach(x=>x.classList.toggle('on',x===b));
  renderPreview();
});
document.querySelectorAll('.lyr').forEach(b=>b.onclick=()=>{b.classList.toggle('on');renderPreview();});
document.querySelectorAll('.dat').forEach(b=>b.onclick=()=>{b.classList.toggle('on');renderPreview();});
$('pngProg').oninput=()=>{
  const pct=+$('pngProg').value/10;
  $('pngProgTxt').textContent=Math.round(pct)+'%';
  $('pngProg').style.setProperty('--prog',pct+'%');
  renderPreview();
};
$('aPng').onclick=()=>{
  if(!S.result) return;
  $('pngModal').hidden=false;
  // 進度預設跟隨結果面板當前的拉桿位置
  $('pngProg').value=(typeof S.totalM==='number'&&S.totalM>0&&S.pvFrac>0)?Math.round(S.pvFrac*1000):1000;
  $('pngProg').dispatchEvent(new Event('input'));   // 更新百分比文字、拉桿底色、預覽
};
$('pngCancel').onclick=()=>{ $('pngModal').hidden=true; };
$('pngGo').onclick=()=>{
  $('pngModal').hidden=true;
  exportPNG(collectExportOpt());
};
$('pngClose').onclick=closeExportResult;
// 這個 click 本身就是使用者手勢，所以 a.click() 不會被 Safari 的彈窗攔截器擋掉
$('pngSave').onclick=()=>{
  if(!_shotUrl) return;
  const a=document.createElement('a');
  a.href=_shotUrl;a.download=_shotName;
  document.body.appendChild(a);a.click();a.remove();
  toast(tx('圖片已儲存','Image saved'),2000);
};
// iOS 上「分享」才是存進相簿的正規路徑，比下載到「檔案」好用
$('pngShare').onclick=async()=>{
  if(!_shotBlob) return;
  try{
    await navigator.share({files:[new File([_shotBlob],_shotName,{type:'image/png'})],
                           title:'Running Art'});
  }catch(e){
    if(e&&e.name==='AbortError') return;   // 使用者自己取消分享，不是錯誤
    toast(tx('分享失敗，請改用「儲存圖片」或長按圖片。',
             'Share failed — use Save image or long-press the image.'),3000);
  }
};
// 點對話框外的暗色區域＝關閉
$('pngResult').onclick=e=>{ if(e.target===$('pngResult')) closeExportResult(); };
$('pngModal').onclick=e=>{ if(e.target===$('pngModal')) $('pngModal').hidden=true; };

el.sheet.querySelector('.grip').onclick=()=>{S.sheetUp=false;el.sheet.classList.remove('up');refresh();};
el.pill.onclick=()=>{
  if(!S.result||S.sheetUp||S.editing) return;
  S.sheetUp=true;el.sheet.classList.add('up');refresh();fitRoute();
};

