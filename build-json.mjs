// scripts/build-json.mjs
// Chế độ: nếu giờ GMT+7 < 08:00 → ANALYZE (tính dự đoán & FROZEN cho cả ngày)
//         nếu >= 08:00 → RESULTS (giữ nguyên dự đoán, chỉ cập nhật kết quả)
// Lưu JSON vào data/predictions.json

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.GITHUB_WORKSPACE || process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, {recursive:true});
const HIST_DIR = path.join(DATA_DIR, 'hist');
fs.mkdirSync(HIST_DIR, {recursive:true});
const FILE_JSON = path.join(DATA_DIR, 'predictions.json');

const SRC = {
  xsmb: [
    'https://ketqua.net/',
    'https://xoso.com.vn/xsmb-xo-so-mien-bac.html',
    'https://www.minhngoc.net.vn/ket-qua-xo-so/mien-bac.html'
  ],
  mega: [
    'https://xoso.com.vn/kqxs-vietlott-mega-6-45.html',
    'https://vietlott.vn/vi/ket-qua-trung-thuong/mega-6-45'
  ],
  power: [
    'https://xoso.com.vn/kqxs-vietlott-power-6-55.html',
    'https://vietlott.vn/vi/ket-qua-trung-thuong/power-6-55'
  ],
  max3d: [
    'https://xoso.com.vn/vietlott-max-3d.html',
    'https://xoso.com.vn/vietlott-max-3d-plus.html',
    'https://vietlott.vn/vi/ket-qua-trung-thuong/max-3d'
  ],
  // 5/35: tách riêng 13h & 21h để lấy outcome chuẩn
  l535_13: [
    'https://xskt.com.vn/xslotto-13h',
    'https://www.minhchinh.com/truc-tiep-xo-so-tu-chon-lotto-535.html'
  ],
  l535_21: [
    'https://xskt.com.vn/xslotto-21h',
    'https://www.minhchinh.com/xo-so-dien-toan-lotto-535.html'
  ],
  l535_any: [
    'https://xskt.com.vn/xslotto-5-35',
    'https://www.minhchinh.com/xo-so-dien-toan-lotto-535.html'
  ]
};
const PROXY = (url) => 'https://r.jina.ai/http://' + url.replace(/^https?:\/\//,'');

function nowGMT7(){ const d=new Date(); const t=d.getTime(); const off=d.getTimezoneOffset(); return new Date(t + (7*60 + off)*60000); }
function todayISO(){ return nowGMT7().toISOString().slice(0,10); }
function pad2(n){ return ('0'+n).slice(-2); }
function pad3(n){ return ('00'+n).slice(-3); }
function uniq(arr){ return Array.from(new Set(arr)); }
function loadJson(file){ try{ return JSON.parse(fs.readFileSync(file,'utf8')); }catch(_){ return null; } }
function saveJson(file, obj){ fs.writeFileSync(file, JSON.stringify(obj,null,2)); }

async function fetchText(urls){
  for(const u of urls){
    try{
      const r = await fetch(PROXY(u), {cache:'no-store'});
      if(r.ok){ return {text: await r.text(), source: u}; }
    }catch(e){}
  }
  return {text:'', source: urls[0]||''};
}

// ===== Parsers
function parseXsmbTwos(text){
  const all=(text.match(/\b\d{2,6}\b/g)||[]);
  const twos=all.map(s=>s.slice(-2)).filter(s=>/^\d{2}$/.test(s));
  let out = uniq(twos);
  if(out.length>60) out=out.slice(0,60);
  if(out.length<20) out=twos.slice(0,60);
  return out;
}
function parseRangeGroup(text, max, k){
  const rx = new RegExp(`\\b(0?[1-9]|${max<50?'[1-3]':'[1-7]'}\\d|${max})\\b`,'g');
  const nums=(text.match(rx)||[]).map(n=>pad2(n)).filter(n=>parseInt(n,10)>=1 && parseInt(n,10)<=max);
  const groups=[]; let cur=[]; for(const n of nums){ cur.push(n); if(cur.length===k){ groups.push(cur); cur=[]; } } return groups.length? groups[groups.length-1] : [];
}
function parse3D(text){ return uniq((text.match(/\b\d{3}\b/g)||[]).map(x=>pad3(x))).slice(-60); }
function parseL535(text){
  const nums=(text.match(/\b\d{2}\b/g)||[]).map(x=>x.trim());
  let best=null;
  for(let i=0;i+5<nums.length;i++){
    const g=nums.slice(i,i+6).map(s=>parseInt(s,10));
    const main=g.slice(0,5), sp=g[5];
    const ok=main.every(v=>v>=1&&v<=35) && (sp>=1&&sp<=12);
    if(ok){ best = {main: main.map(x=>pad2(x)), sp: pad2(sp)}; }
  }
  return best || {main:[], sp:''};
}

// ===== History files
const HIST = {
  xsmb: path.join(HIST_DIR, 'xsmb.json'),
  mega: path.join(HIST_DIR, 'mega.json'),
  power: path.join(HIST_DIR, 'power.json'),
  max3d: path.join(HIST_DIR, 'max3d.json'),
  l535: path.join(HIST_DIR, 'l535.json')  // lưu cả 13 & 21
};
function loadHist(file){ try{ return JSON.parse(fs.readFileSync(file,'utf8')); }catch(_){ return []; } }
function saveHist(file, data){ fs.writeFileSync(file, JSON.stringify(data,null,2)); }

// ===== Scoring & Picks
function scoreLo(xsmbHist){
  const alpha=0.2;
  const f7=new Map(),f14=new Map(),f30=new Map(), ema=new Map();
  const now=nowGMT7();
  for(const r of xsmbHist){
    const d=new Date(r.date+'T00:00:00+07:00');
    const diff=(now-d)/86400000;
    for(const n of r.twos){
      if(diff<=7) f7.set(n,(f7.get(n)||0)+1);
      if(diff<=14) f14.set(n,(f14.get(n)||0)+1);
      if(diff<=30) f30.set(n,(f30.get(n)||0)+1);
      ema.set(n,(ema.get(n)||0)*(1-alpha)+alpha);
    }
  }
  const all=[...Array(100)].map((_,i)=>pad2(i));
  return all.map(n=>({n, s:(f30.get(n)||0)*1 + (f14.get(n)||0)*0.6 + (f7.get(n)||0)*0.4 + (ema.get(n)||0)*2}));
}
function bestAndXien(scored){
  const sorted=[...scored].sort((a,b)=>b.s-a.s);
  const best=sorted[0]?.n||'—';
  const denom=sorted[Math.min(9,sorted.length-1)]?.s||1;
  const conf=Math.min(0.99,(sorted[0]?.s||0)/denom);
  const top4=sorted.slice(0,4).map(o=>o.n);
  const xien=[[top4[0],top4[1]],[top4[2],top4[3]]];
  const top10=sorted.slice(0,10).map(o=>o.n);
  return {best,conf,xien,top10};
}
function stableSeed(seed){ let h=2166136261>>>0; for(let i=0;i<seed.length;i++){ h^=seed.charCodeAt(i); h=(h>>>0)*16777619>>>0; } return function(){h^=h<<13; h^=h>>>17; h^=h<<5; return (h>>>0)/0xFFFFFFFF;}; }
function wsample(probArr, k, noRepeat=true, rng=Math.random){
  const out=[]; const arr=probArr.map(x=>({val:x.val,p:x.p}));
  for(let i=0;i<k;i++){
    const sum=arr.reduce((s,x)=>s+x.p,0); if(sum<=0) break;
    let r=rng()*sum, j=0; for(; j<arr.length; j++){ r-=arr[j].p; if(r<=0) break; } j=Math.min(j,arr.length-1);
    out.push(arr[j].val); if(noRepeat){ arr.splice(j,1); }
  } return out;
}
function probsFromHist(hist, max, windowK=30, decayAlpha=0.15){
  const tail=hist.slice(-windowK); const counts=new Array(max+1).fill(0); const ema=new Array(max+1).fill(0);
  for(const r of tail){ const set=new Set(r.nums); for(let i=1;i<=max;i++){ const has=set.has(pad2(i)); if(has) counts[i]++; ema[i]=ema[i]*(1-decayAlpha)+(has?decayAlpha:0); } }
  const arr=[]; for(let i=1;i<=max;i++){ const p=counts[i]*1 + ema[i]*5; arr.push({val:pad2(i), p}); } const sum=arr.reduce((s,x)=>s+x.p,0)||1; arr.forEach(o=>o.p=o.p/sum); return arr;
}
function fiveSets(probArr, k, seed){
  const rng=stableSeed(seed); const orig=Math.random; Math.random=rng;
  const sorted=[...probArr].sort((a,b)=>b.p-a.p);
  const hot=sorted.slice(0,k).map(x=>x.val);
  const cold=sorted.slice(-k).map(x=>x.val);
  const mid=sorted.slice(Math.floor(sorted.length*0.3), Math.floor(sorted.length*0.7));
  const mixed=Array.from(new Set([...sorted.slice(0,3).map(x=>x.val), ...wsample(mid, k-3, true, Math.random)])).slice(0,k);
  const emaW=wsample(probArr, k, true, Math.random);
  const random=wsample(probArr.map(x=>({val:x.val,p:1})), k, true, Math.random);
  Math.random=orig; return [hot,cold,mixed,emaW,random];
}
function threeDFromHist(hist){
  const tail=hist.slice(-30);
  const cH=new Array(10).fill(0.1), cT=new Array(10).fill(0.1), cU=new Array(10).fill(0.1);
  for(const r of tail){ for(const n of r.nums){ const h=+n[0],t=+n[1],u=+n[2]; cH[h]+=0.02; cT[t]+=0.02; cU[u]+=0.02; } }
  function pick(seed){ const rng=stableSeed(seed); function wp(ps){ const a=ps.map((p,i)=>({i,p})); const s=a.reduce((x,y)=>x+y.p,0); let r=rng()*s; for(const o of a){ r-=o.p; if(r<=0) return o.i; } return a[a.length-1].i; } return ''+wp(cH)+''+wp(cT)+''+wp(cU); }
  return (label)=>[0,1,2,3,4].map(i=>pick(label+'|'+i));
}

// ===== Lịch quay
function isDrawDayMega(d){ const dow=d.getDay(); return (dow===3||dow===5||dow===0); } // Wed, Fri, Sun
function isDrawDayPower(d){ const dow=d.getDay(); return (dow===2||dow===4||dow===6); } // Tue, Thu, Sat
function isDrawDayMax3D(d){ const dow=d.getDay(); return (dow===1||dow===3||dow===5); } // Mon, Wed, Fri

async function build(){
  const now=nowGMT7();
  const hour=now.getHours();
  const date=todayISO();
  const mode = (hour<8) ? 'ANALYZE' : 'RESULTS';

  const prev = loadJson(FILE_JSON) || {};
  let predictions = prev.predictions || {};

  // ===== Histories =====
  const xsmbHist = loadHist(HIST.xsmb);
  try{ const {text,source}=await fetchText(SRC.xsmb); const twos=parseXsmbTwos(text); const idx=xsmbHist.findIndex(r=>r.date===date); if(idx>=0) xsmbHist[idx].twos=twos; else xsmbHist.push({date, twos, source}); }catch(e){}
  xsmbHist.sort((a,b)=>a.date<b.date?-1:1); if(xsmbHist.length>120) xsmbHist.splice(0, xsmbHist.length-120); saveHist(HIST.xsmb, xsmbHist);

  const megaHist = loadHist(HIST.mega);
  try{ const {text,source}=await fetchText(SRC.mega); const latest=parseRangeGroup(text,45,6); if(latest.length===6){ const key=date+'|'+latest.join('-'); if(!megaHist.find(r=>r.key===key)) megaHist.push({key, nums: latest, source}); } }catch(e){}
  if(megaHist.length>400) megaHist.splice(0, megaHist.length-400); saveHist(HIST.mega, megaHist);

  const powerHist = loadHist(HIST.power);
  try{ const {text,source}=await fetchText(SRC.power); const latest=parseRangeGroup(text,55,6); if(latest.length===6){ const key=date+'|'+latest.join('-'); if(!powerHist.find(r=>r.key===key)) powerHist.push({key, nums: latest, source}); } }catch(e){}
  if(powerHist.length>400) powerHist.splice(0, powerHist.length-400); saveHist(HIST.power, powerHist);

  const max3dHist = loadHist(HIST.max3d);
  try{ const {text,source}=await fetchText(SRC.max3d); const list=parse3D(text); if(list.length){ const key=date+'|'+list.join('-'); if(!max3dHist.find(r=>r.key===key)) max3dHist.push({key, nums:list, source}); } }catch(e){}
  if(max3dHist.length>400) max3dHist.splice(0, max3dHist.length-400); saveHist(HIST.max3d, max3dHist);

  const l535Hist = loadHist(HIST.l535);
  // Lấy riêng outcome 13h
  let out13='—', out21='—', src535='—';
  try{ const {text,source}=await fetchText(SRC.l535_13); const obj=parseL535(text); if(obj.main.length){ out13 = obj.main.join(' ')+' | SB '+obj.sp; const key=date+'|13|'+obj.main.join('-')+'|'+obj.sp; if(!l535Hist.find(r=>r.key===key)) l535Hist.push({key, when:'13', nums: obj.main, sp: obj.sp, source}); src535 = source; } }catch(e){}
  // Lấy riêng outcome 21h
  try{ const {text,source}=await fetchText(SRC.l535_21); const obj=parseL535(text); if(obj.main.length){ out21 = obj.main.join(' ')+' | SB '+obj.sp; const key=date+'|21|'+obj.main.join('-')+'|'+obj.sp; if(!l535Hist.find(r=>r.key===key)) l535Hist.push({key, when:'21', nums: obj.main, sp: obj.sp, source}); if(src535==='—') src535 = source; } }catch(e){}
  // Nếu chưa bắt được kỳ nào hôm nay, dùng trang tổng hợp làm lịch sử
  if(out13==='—' && out21==='—'){
    try{ const {text,source}=await fetchText(SRC.l535_any); const obj=parseL535(text); if(obj.main.length){ const key=date+'|??|'+obj.main.join('-')+'|'+obj.sp; if(!l535Hist.find(r=>r.key===key)) l535Hist.push({key, when:'?', nums: obj.main, sp: obj.sp, source}); src535 = source; } }catch(e){}
  }
  if(l535Hist.length>600) l535Hist.splice(0, l535Hist.length-600); saveHist(HIST.l535, l535Hist);

  // ===== Predictions (ANALYZE or first-time) =====
  if(mode==='ANALYZE' || (predictions.date !== date)){
    const xsmbScore = scoreLo(xsmbHist);
    const {best,conf,xien,top10} = bestAndXien(xsmbScore);
    const dObj = now;
    const predMega = isDrawDayMega(dObj)? fiveSets(probsFromHist(megaHist,45),6,'mega|'+date) : [];
    const predPower= isDrawDayPower(dObj)? fiveSets(probsFromHist(powerHist,55),6,'power|'+date) : [];
    const predMax3D= isDrawDayMax3D(dObj)? threeDFromHist(max3dHist)('max3d|'+date) : [];
    const probL = probsFromHist(l535Hist.map(r=>({nums:r.nums})), 35);
    const sets13 = fiveSets(probL, 5, 'l535|13|'+date).map(main=>{ // thêm SB 01..12
      const sc=new Array(13).fill(1); for(const r of l535Hist){ const s=parseInt(r.sp,10); if(s>=1&&s<=12) sc[s]+=1; }
      let sum=sc.slice(1).reduce((a,b)=>a+b,0); let r=Math.random();
      for(let i=1;i<=12;i++){ r-=sc[i]/sum; if(r<=0) return [...main, pad2(i)]; } return [...main, '01'];
    });
    const sets21 = fiveSets(probL, 5, 'l535|21|'+date).map(main=>{ // thêm SB 01..12
      const sc=new Array(13).fill(1); for(const r of l535Hist){ const s=parseInt(r.sp,10); if(s>=1&&s<=12) sc[s]+=1; }
      let sum=sc.slice(1).reduce((a,b)=>a+b,0); let r=Math.random();
      for(let i=1;i<=12;i++){ r-=sc[i]/sum; if(r<=0) return [...main, pad2(i)]; } return [...main, '01'];
    });

    predictions = {
      date,
      xsmb: {best, conf: +conf.toFixed(2), xien, top10, notes:'Điểm = f30*1 + f14*0.6 + f7*0.4 + EMA*2. Xiên: 2 cặp từ Top4.'},
      mega: {date: isDrawDayMega(dObj)? date : '—', sets: predMega},
      power:{date: isDrawDayPower(dObj)? date : '—', sets: predPower},
      max3d:{date: isDrawDayMax3D(dObj)? date : '—', sets: predMax3D},
      l535: {date, sets13, sets21}
    };
  }

  // ===== Outcomes (luôn cập nhật sau 08:00, và cả trước đó nếu có)
  const outcomes = {};
  const xs = xsmbHist.find(r=>r.date===date) || xsmbHist.slice(-1)[0] || {};
  outcomes.xsmb = {date: xs?.date||date, twos: xs?.twos||[], source: xs?.source||'—'};
  const mh = megaHist.slice(-1)[0]; outcomes.mega = {nums: mh?.nums||[], source: mh?.source||'—'};
  const ph = powerHist.slice(-1)[0]; outcomes.power= {nums: ph?.nums||[], source: ph?.source||'—'};
  const m3 = max3dHist.slice(-1)[0]; outcomes.max3d = {latest: (m3?.nums||[]).slice(-6), source: m3?.source||'—'};
  outcomes.l535 = {k13: out13, k21: out21, source: (src535||'—')};

  const out = { updated_at: new Date().toISOString(), mode, predictions, outcomes };
  saveJson(FILE_JSON, out);
  console.log('Saved', FILE_JSON, 'mode', mode, 'at', out.updated_at);
}

await build().catch(e=>{ console.error(e); process.exit(1); });
