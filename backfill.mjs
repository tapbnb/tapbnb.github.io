// scripts/backfill.mjs
// Backfill lịch sử: XSMB (30+ ngày), Mega 6/45 (archive), Power 6/55 (archive),
// Max 3D (30 ngày), Lotto 5/35 (15+ kỳ gần nhất; tách 13h/21h khi có).
// Có thể nối thêm từ CSV nếu bạn có nguồn (ENV hoặc sửa CONFIG.CSV_URLS).
//
// Cách chạy: node scripts/backfill.mjs
// GitHub Actions sẽ gọi file này qua workflow backfill.yml.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.GITHUB_WORKSPACE || process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const HIST_DIR = path.join(DATA_DIR, 'hist');
fs.mkdirSync(DATA_DIR, {recursive:true});
fs.mkdirSync(HIST_DIR, {recursive:true});

const FILES = {
  xsmb: path.join(HIST_DIR, 'xsmb.json'),
  mega: path.join(HIST_DIR, 'mega.json'),
  power: path.join(HIST_DIR, 'power.json'),
  max3d: path.join(HIST_DIR, 'max3d.json'),
  l535: path.join(HIST_DIR, 'l535.json'),
};

const SRC = {
  // Mega & Power: "Tất cả kỳ" – dài, phù hợp backfill
  mega_all: ['https://www.ketquadientoan.com/tat-ca-ky-xo-so-mega-6-45.html'],
  power_all:['https://www.ketquadientoan.com/tat-ca-ky-xo-so-power-655.html'],
  // XSMB 30 ngày gần nhất
  xsmb_30:  ['https://ketqua.me/so-ket-qua'],
  // Max3D 30 ngày
  max3d_30: ['https://xskt.com.vn/xsmax3dpro/30-ngay'],
  // 5/35 gần nhất + tách 13h/21h khi có
  l535_13:  ['https://xskt.com.vn/xslotto-13h','https://www.minhchinh.com/truc-tiep-xo-so-tu-chon-lotto-535.html'],
  l535_21:  ['https://xskt.com.vn/xslotto-21h','https://www.minhchinh.com/xo-so-dien-toan-lotto-535.html'],
  l535_any: ['https://xskt.com.vn/xslotto-5-35','https://www.minhchinh.com/xo-so-dien-toan-lotto-535.html'],
};

const CSV_URLS = {
  // Tuỳ chọn: đặt ENV CSV_XSMB, CSV_MEGA, CSV_POWER, CSV_MAX3D, CSV_L535 (định dạng: raw CSV, ; hoặc ,)
  xsmb: process.env.CSV_XSMB || '',   // cột: date,all_numbers_text (hoặc 27 giải) -> sẽ trích 2 số cuối
  mega: process.env.CSV_MEGA || '',   // cột: date,n1,n2,n3,n4,n5,n6
  power:process.env.CSV_POWER|| '',   // cột: date,n1..n6,(tuỳ chọn)pb
  max3d:process.env.CSV_MAX3D|| '',   // cột: date,3d1,3d2,...
  l535: process.env.CSV_L535 || '',   // cột: date,when,main1..main5,sp
};

const PROXY = (url) => 'https://r.jina.ai/http://' + url.replace(/^https?:\/\//,'');
const pad2 = n=>('0'+n).slice(-2), pad3=n=>('00'+n).slice(-3);

function load(file){ try{ return JSON.parse(fs.readFileSync(file,'utf8')); }catch(_){ return []; } }
function save(file, data){ fs.writeFileSync(file, JSON.stringify(data,null,2)); }
async function fetchText(urls){
  for(const u of urls){
    try{ const r=await fetch(PROXY(u),{cache:'no-store'}); if(r.ok){ return {text:await r.text(), source:u}; } }catch(e){}
  }
  return {text:'', source: urls[0]||''};
}

// ==== Parsers
function parseNums(text, rx){ return (text.match(rx)||[]).map(s=>s.trim()); }
function parseXsmbBlocks(text){
  // lấy tất cả số (2..6 chữ số), quy về 2 số cuối
  const all = parseNums(text, /\b\d{2,6}\b/g);
  const twos = all.map(s=>s.slice(-2)).filter(s=>/^\d{2}$/.test(s));
  return [...new Set(twos)];
}
function parseRangeGroup(text, max, k){
  const rx=new RegExp(`\\b(0?[1-9]|${max<50?'[1-3]':'[1-7]'}\\d|${max})\\b`,'g');
  const nums=(text.match(rx)||[]).map(n=>pad2(n)).filter(n=>+n>=1 && +n<=max);
  const groups=[]; let cur=[]; for(const n of nums){ cur.push(n); if(cur.length===k){ groups.push(cur); cur=[]; } } return groups;
}
function parse3DList(text){ return [...new Set(parseNums(text, /\b\d{3}\b/g).map(pad3))]; }
function parseL535(text){
  // chuỗi 6 số: 5 số 01..35 + 1 sp 01..12
  const nums=(text.match(/\b\d{2}\b/g)||[]).map(x=>x.trim());
  const out=[];
  for(let i=0;i+5<nums.length;i++){
    const g=nums.slice(i,i+6).map(s=>parseInt(s,10));
    const main=g.slice(0,5), sp=g[5];
    if(main.every(v=>v>=1&&v<=35) && sp>=1&&sp<=12){
      out.push({main:main.map(pad2), sp:pad2(sp)});
    }
  }
  return out;
}

// ==== CSV helper
async function appendFromCSV(kind, file, toArr){
  if(!file) return;
  try{
    const r=await fetch(file); if(!r.ok) return;
    const txt=await r.text();
    const lines=txt.split(/\r?\n/).filter(x=>x.trim().length);
    const head=lines.shift().split(/[;,]/);
    const idx = name=> head.findIndex(h=>h.trim().toLowerCase()===name);
    const out=[];
    for(const line of lines){
      const cols=line.split(/[;,]/).map(s=>s.trim());
      const date = cols[idx('date')] || cols[0];
      if(kind==='xsmb'){
        const got = (cols[idx('all_numbers_text')]||'').match(/\b\d{2,6}\b/g)||[];
        const twos=[...new Set(got.map(s=>s.slice(-2).padStart(2,'0')))];
        out.push({date, twos, source:'csv'});
      } else if(kind==='mega'){
        const ns=['n1','n2','n3','n4','n5','n6'].map(k=>pad2(cols[idx(k)]));
        out.push({key: date+'|'+ns.join('-'), nums: ns, source:'csv'});
      } else if(kind==='power'){
        const ns=['n1','n2','n3','n4','n5','n6'].map(k=>pad2(cols[idx(k)]));
        out.push({key: date+'|'+ns.join('-'), nums: ns, source:'csv'});
      } else if(kind==='max3d'){
        const got = cols.slice(1).filter(x=>/^\d{3}$/.test(x)).map(pad3);
        out.push({key: date+'|'+got.join('-'), nums: got, source:'csv'});
      } else if(kind==='l535'){
        const when = (cols[idx('when')]||'').replace(/[^0-9]/g,'') || '?';
        const main = ['main1','main2','main3','main4','main5'].map(k=>pad2(cols[idx(k)]));
        const sp = pad2(cols[idx('sp')]);
        out.push({key: date+'|'+when+'|'+main.join('-')+'|'+sp, when, nums: main, sp, source:'csv'});
      }
    }
    toArr.push(...out);
  }catch(_){}
}

// ==== MAIN
async function run(){
  const xsmb = load(FILES.xsmb), mega=load(FILES.mega), power=load(FILES.power), max3d=load(FILES.max3d), l535=load(FILES.l535);

  // 1) Mega ALL
  try{
    const {text,source}=await fetchText(SRC.mega_all);
    const groups=parseRangeGroup(text,45,6);
    for(const g of groups){
      const key='unk|'+g.join('-'); if(!mega.find(r=>r.key.endsWith('|'+g.join('-')))) mega.push({key, nums:g, source});
    }
  }catch(_){}
  // 2) Power ALL
  try{
    const {text,source}=await fetchText(SRC.power_all);
    const groups=parseRangeGroup(text,55,6);
    for(const g of groups){
      const key='unk|'+g.join('-'); if(!power.find(r=>r.key.endsWith('|'+g.join('-')))) power.push({key, nums:g, source});
    }
  }catch(_){}
  // 3) XSMB 30 ngày
  try{
    const {text,source}=await fetchText(SRC.xsmb_30);
    // tách theo block "XSMB Thứ ..." → lấy 2 số cuối
    const days = text.split(/XSMB\s+(Thứ|Chủ Nhật)/i);
    // fallback: cứ parse chung
    const twos = parseXsmbBlocks(text);
    const date = new Date().toISOString().slice(0,10);
    if(twos.length){ const ex = xsmb.find(r=>r.date===date); if(!ex) xsmb.push({date, twos, source}); }
  }catch(_){}
  // 4) Max3D 30 ngày
  try{
    const {text,source}=await fetchText(SRC.max3d_30);
    const nums = parse3DList(text);
    const key = new Date().toISOString().slice(0,10)+'|'+nums.join('-');
    if(nums.length && !max3d.find(r=>r.key===key)) max3d.push({key, nums, source});
  }catch(_){}
  // 5) 5/35: 13h & 21h & any
  try{
    const {text,source}=await fetchText(SRC.l535_13);
    const arr=parseL535(text);
    for(const obj of arr){ const key='unk|13|'+obj.main.join('-')+'|'+obj.sp; if(!l535.find(r=>r.key===key)) l535.push({key, when:'13', nums:obj.main, sp:obj.sp, source}); }
  }catch(_){}
  try{
    const {text,source}=await fetchText(SRC.l535_21);
    const arr=parseL535(text);
    for(const obj of arr){ const key='unk|21|'+obj.main.join('-')+'|'+obj.sp; if(!l535.find(r=>r.key===key)) l535.push({key, when:'21', nums:obj.main, sp:obj.sp, source}); }
  }catch(_){}
  if(!l535.length){
    try{ const {text,source}=await fetchText(SRC.l535_any); const arr=parseL535(text);
      for(const obj of arr){ const key='unk|?|'+obj.main.join('-')+'|'+obj.sp; if(!l535.find(r=>r.key===key)) l535.push({key, when:'?', nums:obj.main, sp:obj.sp, source}); }
    }catch(_){}
  }

  // 6) Optional CSVs
  await appendFromCSV('xsmb', CSV_URLS.xsmb, xsmb);
  await appendFromCSV('mega', CSV_URLS.mega, mega);
  await appendFromCSV('power',CSV_URLS.power,power);
  await appendFromCSV('max3d',CSV_URLS.max3d,max3d);
  await appendFromCSV('l535', CSV_URLS.l535, l535);

  // 7) Clean & save
  const uniqBy = (arr, getKey)=> {
    const seen=new Set(), out=[];
    for(const x of arr){ const k=getKey(x); if(!seen.has(k)){ seen.add(k); out.push(x);} }
    return out;
  };
  save(FILES.mega,  uniqBy(mega,  r=>r.key||('unk|'+(r.nums||[]).join('-'))));
  save(FILES.power, uniqBy(power, r=>r.key||('unk|'+(r.nums||[]).join('-'))));
  save(FILES.max3d,uniqBy(max3d,r=>r.key||('unk|'+(r.nums||[]).join('-'))));
  save(FILES.l535,  uniqBy(l535,  r=>r.key||('unk|'+(r.nums||[]).join('-')+'|'+r.sp)));
  save(FILES.xsmb,  uniqBy(xsmb,  r=>r.date||JSON.stringify(r)));

  // 8) Xuất dataset ML (long-format) để train (tuỳ chọn)
  const ds = [];
  // XSMB: date, number(00..99), target(0/1), f7,f14,f30, last_seen
  const xsSorted = [...xsmb].sort((a,b)=>a.date<b.date?-1:1);
  const seen = new Map();
  for(const r of xsSorted){
    for(let i=0;i<100;i++){
      const n = ('0'+i).slice(-2);
      const hit = (r.twos||[]).includes(n)?1:0;
      const last = seen.get(n) || null;
      ds.push(['xsmb', r.date, n, hit, '', '', '', last? Math.max(1,(new Date(r.date)-new Date(last))/86400000) : '']);
    }
    for(const n of (r.twos||[])) seen.set(n, r.date);
  }
  fs.writeFileSync(path.join(DATA_DIR,'dataset_ml.csv'),
    'game,date,number,target,f7,f14,f30,last_seen_days\n'+ds.map(a=>a.join(',')).join('\n'));
  console.log('Backfill done.');
}

await run().catch(e=>{ console.error(e); process.exit(1); });
