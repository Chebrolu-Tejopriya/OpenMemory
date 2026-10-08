const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const board='https://www.pinterest.com/test/tracker/';
const vector=dim=>Array.from({length:dim},(_,i)=>i===0?1:0);
const existing={id:'1',title:'Existing',board_name:'tracker',board_url:board,embedding:vector(384),image_embedding:vector(512),image_url:'https://i.pinimg.com/existing.jpg'};
const rows=[structuredClone(existing),{id:'2',title:'Imported earlier',board_name:'tracker',board_url:board,embedding:null,image_embedding:null,image_url:'https://i.pinimg.com/good.jpg'},
 {id:'3',title:'Unavailable image',board_name:'tracker',board_url:board,embedding:null,image_embedding:null,image_url:'https://i.pinimg.com/unavailable.jpg'}];
process.env.SUPABASE_URL='https://fixture.supabase.co';process.env.SUPABASE_ANON_KEY='fixture';
let textRequests=0;
global.fetch=async(url,init={})=>{
 const u=new URL(url);
 if(u.pathname==='/health')return {ok:true};
 if(u.pathname==='/embed/texts'){textRequests++;return {ok:true,json:async()=>({embeddings:JSON.parse(init.body).texts.map(()=>vector(384))})};}
 if(u.pathname==='/embed/images')return {ok:true,json:async()=>({embeddings:JSON.parse(init.body).urls.map(url=>url.includes('unavailable')?null:vector(512))})};
 assert.equal(u.hostname,'fixture.supabase.co');
 let filtered=rows.filter(row=>row.board_url===u.searchParams.get('board_url').slice(3));
 // PATCH has an exact ID and a NULL guard; existing vectors cannot be overwritten.
 if(init.method==='PATCH'){
  const row=rows.find(row=>row.id===u.searchParams.get('id').slice(3));
  const changes=JSON.parse(init.body);
  assert.equal(Object.keys(changes).length,1);
  const column=Object.keys(changes)[0];assert.equal(u.searchParams.get(column),'is.null');assert.equal(row[column],null);
  Object.assign(row,changes);return {ok:true};
 }
 for(const col of ['embedding','image_embedding'])if(u.searchParams.has(col))filtered=filtered.filter(row=>row[col]===null);
 if(init.method==='HEAD')return {ok:true,headers:{get:()=>`0-0/${filtered.length}`}};
 if(u.searchParams.has('id'))filtered=filtered.filter(row=>row.id>u.searchParams.get('id').slice(3));
 return {ok:true,json:async()=>structuredClone(filtered)};
};
const output=esbuild.buildSync({entryPoints:['backend/src/pinterest-embeddings.ts'],bundle:true,platform:'node',format:'cjs',write:false});
const mod={exports:{}};new Function('module','exports',output.outputFiles[0].text)(mod,mod.exports);
(async()=>{
 const result=await mod.exports.runPinterestEmbeddingJob(board);
 assert.equal(result.textGenerated,2);assert.equal(result.imageGenerated,1);assert.equal(result.failed,1);
 assert.equal(textRequests,1);
 assert.deepEqual(rows[0],existing);
 assert.equal(rows[2].image_embedding,null);
 assert.deepEqual(await mod.exports.pinterestEmbeddingCounts(board),{total:3,textMissing:0,imageMissing:1});
 console.log('Passed: old NULL rows get embeddings, batched text inference, existing vectors preserved, failed image stays NULL, accurate progress counts.');
})().catch(error=>{console.error(error);process.exitCode=1});
