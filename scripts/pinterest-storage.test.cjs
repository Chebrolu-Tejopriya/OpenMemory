const assert=require('node:assert/strict');
const esbuild=require('esbuild');
const clean='https://in.pinterest.com/Tejopriya_Chebrolu/tracker/';
const tracked=clean+'?request_params=tracking';
const canonical='https://www.pinterest.com/tejopriya_chebrolu/tracker/';
const makePin=i=>({id:String(i),pin_url:`https://www.pinterest.com/pin/${i}/`,pin_id:String(i),image_url:`https://i.pinimg.com/${i}.jpg`,title:`Title ${i}`,description:`Description ${i}`,board_name:'tracker',board_url:i<=121?clean:tracked,embedding:[i,1]});
const rows=Array.from({length:620},(_,i)=>makePin(i+1));
const snapshot=structuredClone(rows);
const boards=[{board_url:clean},{board_url:tracked},{board_url:'https://www.pinterest.com/test/other/'}];
let transient=true;
const client={from(table){
 const q={action:'select',filters:[],payload:null,count:false,embeddingQuery:false,
  select(fields,opts){this.count=!!opts?.count;return this;},
  in(key,values){this.filters.push(row=>values.includes(row[key]));return this;},
  eq(key,value){this.filters.push(row=>row[key]===value);return this;},
  is(){this.embeddingQuery=true;return this;},
  update(payload){this.action='update';this.payload=payload;return this;},
  upsert(payload,opts){this.action='upsert';this.payload=payload;if(table==='pinterest_pins') assert.deepEqual(opts,{onConflict:'pin_url',ignoreDuplicates:true});return this;},
  delete(){this.action='delete';return this;},
  then(resolve,reject){try{
   const target=table==='pinterest_pins'?rows:boards;
   const matched=target.filter(row=>this.filters.every(filter=>filter(row)));
   if(this.embeddingQuery)return Promise.resolve({data:[],error:null}).then(resolve,reject);
   if(this.action==='update'){if(table==='pinterest_pins')assert.deepEqual(Object.keys(this.payload),['board_url']);matched.forEach(row=>Object.assign(row,this.payload));}
   if(this.action==='delete')matched.forEach(row=>target.splice(target.indexOf(row),1));
   if(this.action==='upsert'){
    if(table==='pinterest_pins'&&transient){transient=false;return Promise.resolve({error:{code:'PGRST000',message:'Temporary offline fixture'}}).then(resolve,reject);}
    const written=[];
    for(const item of Array.isArray(this.payload)?this.payload:[this.payload]){
     const key=table==='pinterest_pins'?'pin_url':'board_url',existing=target.find(row=>row[key]===item[key]);
     if(existing){if(table==='pinterest_boards')Object.assign(existing,item);continue;}
     const row={...item,id:item.pin_id||item.board_url};target.push(row);written.push({id:row.id});
    }
    return Promise.resolve({data:written,error:null}).then(resolve,reject);
   }
   return Promise.resolve({data:matched,count:this.count?matched.length:null,error:null}).then(resolve,reject);
  }catch(error){return Promise.reject(error).then(resolve,reject);}}
 };return q;
}};
global.chrome={storage:{local:{get:async()=>({supabaseUrl:'https://fixture.supabase.co',supabaseAnonKey:'fixture'})}}};
const output=esbuild.buildSync({entryPoints:['src/extension/supabase.ts'],bundle:true,platform:'node',format:'cjs',external:['@supabase/supabase-js'],write:false});
const mod={exports:{}};
new Function('module','exports','require',output.outputFiles[0].text)(mod,mod.exports,name=>name==='@supabase/supabase-js'?{createClient:()=>client}:require(name));
(async()=>{
 const incoming=Array.from({length:637},(_,i)=>({...makePin(i+1),embedding:undefined}));
 const result=await mod.exports.resyncPinterestBoard(tracked,incoming,'tracker',637);
 assert.deepEqual(result,{added:17,total:637,failed:0,alreadyStored:620});
 assert.equal(rows.length,637);
 for(let i=0;i<620;i++)assert.deepEqual(rows[i],{...snapshot[i],board_url:canonical});
 assert.equal(boards.filter(b=>b.board_url===canonical).length,1);
 assert.equal(boards.find(b=>b.board_url===canonical).imported_pins,637);
 assert.ok(!boards.some(b=>[clean,tracked].includes(b.board_url)));
 assert.ok(boards.some(b=>b.board_url.includes('/test/other/')));
 const again=await mod.exports.resyncPinterestBoard(clean,incoming,'tracker',637);
 assert.deepEqual(again,{added:0,total:637,failed:0,alreadyStored:637});
 console.log('Passed: 121 + 499 URL aliases reconcile, 17 new pins insert after transient retry, embeddings/metadata preserved, repeated resync adds zero duplicates.');
})().catch(error=>{console.error(error);process.exitCode=1});
