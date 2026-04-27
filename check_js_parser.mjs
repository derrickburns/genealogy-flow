import { readFileSync } from "node:fs";

const EVENT_TAGS = new Set(["BIRT","DEAT","RESI","MARR","EMIG","IMMI","CENS","BAPM","BURI","CHR"]);
const DATE_RE = /(?:(?:ABT|BEF|AFT|EST|CAL|FROM|TO|BET|AND)\s+)?(?:\d{1,2}\s+)?(?:(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+)?(\d{3,4})/i;

function parseYear(d){if(!d) return null;const m=d.match(DATE_RE);if(!m) return null;const y=+m[2];return y>=1000&&y<=2100?y:null;}

function parseGedcom(text) {
  const lines = text.split(/\r?\n/);
  const individuals = [];
  const families = new Map();
  let mode = null, cur = null;
  let curEvent=null,curDate=null,curPlace=null;
  let curName=null,curSex=null,curBirth=null,curDeath=null,curFamc=null;

  function flushEvent(){
    if(cur&&mode==="INDI"&&curEvent){
      const y=parseYear(curDate);
      if(y!==null&&curPlace) cur.events.push({type:curEvent,year:y,place:curPlace.trim()});
      if(curEvent==="BIRT"&&y!==null&&curBirth===null) curBirth=y;
      if(curEvent==="DEAT"&&y!==null&&curDeath===null) curDeath=y;
    }
    curEvent=null;curDate=null;curPlace=null;
  }
  function flushRecord(){
    flushEvent();
    if(cur&&mode==="INDI"){
      cur.name=curName||cur.id; cur.sex=curSex||"U";
      cur.birth_year=curBirth; cur.death_year=curDeath; cur.famc=curFamc;
      individuals.push(cur);
    } else if(cur&&mode==="FAM") families.set(cur.id, cur);
    cur=null; mode=null;
    curName=null; curSex=null; curBirth=null; curDeath=null; curFamc=null;
  }

  for(const raw of lines){
    if(!raw) continue;
    const sp=raw.indexOf(" "); if(sp<0) continue;
    const lvl=parseInt(raw.slice(0,sp),10); if(Number.isNaN(lvl)) continue;
    const rest=raw.slice(sp+1);
    if(lvl===0){
      flushRecord();
      const mi=rest.match(/^(@[^@]+@)\s+INDI/);
      const mf=rest.match(/^(@[^@]+@)\s+FAM/);
      if(mi){cur={id:mi[1],events:[]}; mode="INDI";}
      else if(mf){cur={id:mf[1],husb:null,wife:null,chil:[]}; mode="FAM";}
      continue;
    }
    if(!cur) continue;
    const sp2=rest.indexOf(" ");
    const tag=sp2>=0?rest.slice(0,sp2):rest;
    const value=sp2>=0?rest.slice(sp2+1):"";
    if(lvl===1){
      flushEvent();
      if(mode==="INDI"){
        if(EVENT_TAGS.has(tag)) curEvent=tag;
        else if(tag==="NAME"&&curName===null) curName=value.replace(/\//g,"").trim();
        else if(tag==="SEX"&&curSex===null) curSex=(value.trim()[0]||"U").toUpperCase();
        else if(tag==="FAMC"&&curFamc===null) curFamc=value.trim();
      } else if(mode==="FAM"){
        if(tag==="HUSB") cur.husb=value.trim();
        else if(tag==="WIFE") cur.wife=value.trim();
        else if(tag==="CHIL") cur.chil.push(value.trim());
      }
    } else if(lvl===2&&mode==="INDI"&&curEvent){
      if(tag==="DATE") curDate=value;
      else if(tag==="PLAC") curPlace=value;
    }
  }
  flushRecord();
  return { individuals, families };
}

const text = readFileSync(process.argv[2], "utf-8");
const { individuals, families } = parseGedcom(text);
console.log(`individuals: ${individuals.length}`);
console.log(`families:    ${families.size}`);

function status(ind){
  if(!ind.famc) return 0;
  const f = families.get(ind.famc);
  if(!f) return 0;
  const n = (f.husb?1:0) + (f.wife?1:0);
  return n;
}

const buckets = {all:[0,0,0], withEvents:[0,0,0], dated:[0,0,0]};
for(const ind of individuals){
  const n = status(ind);
  buckets.all[n]++;
  if(ind.events && ind.events.length){
    buckets.withEvents[n]++;
    if(ind.events.some(e=>e.year)) buckets.dated[n]++;
  }
}
console.log("\nDistribution of parent counts:");
console.log(`               none   one    both`);
console.log(`all:           ${buckets.all[0].toString().padStart(5)}  ${buckets.all[1].toString().padStart(5)}  ${buckets.all[2].toString().padStart(5)}`);
console.log(`with events:   ${buckets.withEvents[0].toString().padStart(5)}  ${buckets.withEvents[1].toString().padStart(5)}  ${buckets.withEvents[2].toString().padStart(5)}`);
console.log(`dated events:  ${buckets.dated[0].toString().padStart(5)}  ${buckets.dated[1].toString().padStart(5)}  ${buckets.dated[2].toString().padStart(5)}`);

// Year-by-year breakdown
const byYear = new Map();
for (const ind of individuals) {
  const n = status(ind);
  for (const e of (ind.events || [])) {
    if (!e.year) continue;
    if (!byYear.has(e.year)) byYear.set(e.year, [0,0,0]);
    byYear.get(e.year)[n]++;
  }
}
// Simulate exact buildTimeline+parentStatus pipeline
const parentsOf = new Map();
for (const ind of individuals) {
  if (ind.famc && families.has(ind.famc)) {
    const f = families.get(ind.famc);
    parentsOf.set(ind.id, [f.husb, f.wife]);
  }
}
function parentStatus(id) {
  const p = parentsOf.get(id);
  if (!p) return 2;
  const c = (p[0] ? 1 : 0) + (p[1] ? 1 : 0);
  return c === 2 ? 0 : c === 1 ? 1 : 2;
}

// What does dwellSrc end up looking like at year 1979?
const at1979 = [0,0,0];
for (const ind of individuals) {
  for (const e of (ind.events || [])) {
    if (e.year === 1979) at1979[parentStatus(ind.id)]++;
  }
}
console.log(`\nSimulated dwellSrc at year 1979: status0=${at1979[0]}, status1=${at1979[1]}, status2=${at1979[2]}`);
const targetYears = [1900, 1920, 1940, 1950, 1960, 1970, 1979, 1980, 1990, 2000];
console.log("\nYear   none    one   both    pct-incomplete");
for (const y of targetYears) {
  const b = byYear.get(y) || [0,0,0];
  const t = b[0]+b[1]+b[2];
  const pct = t ? Math.round((b[0]+b[1])/t*100) : 0;
  console.log(`${y}   ${b[0].toString().padStart(4)}   ${b[1].toString().padStart(4)}   ${b[2].toString().padStart(4)}     ${pct}%`);
}

// Sample a few "no parents but is a parent themselves" with events
const parentsRef = new Set();
for(const f of families.values()){
  if(f.chil && f.chil.length){
    if(f.husb) parentsRef.add(f.husb);
    if(f.wife) parentsRef.add(f.wife);
  }
}
console.log("\nAmong dated-event individuals with no recorded parents:");
let isParent=0, notParent=0;
for(const ind of individuals){
  if(status(ind) !== 0) continue;
  if(!ind.events || !ind.events.length) continue;
  if(parentsRef.has(ind.id)) isParent++;
  else notParent++;
}
console.log(`  ARE recorded as parent: ${isParent}`);
console.log(`  NOT a parent:           ${notParent}`);
