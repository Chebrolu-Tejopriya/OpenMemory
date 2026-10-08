const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const output = esbuild.buildSync({entryPoints:['src/extension/pinterest-feed.ts'],bundle:true,platform:'node',format:'cjs',write:false});
const mod = {exports:{}};
new Function('module','exports',output.outputFiles[0].text)(mod,mod.exports);
const {fetchBoardFeed, parseFeedPins, mergeFeedPin} = mod.exports;
const url = 'https://in.pinterest.com/test/tracker/';
const pin = id => ({id:String(id),type:'pin',title:'Title '+id,description:'Description '+id,link:'https://external.example/',images:{orig:{url:`https://i.pinimg.com/originals/${id}.jpg`}}});
const response = (data, cursor, normalized = false) => ({ok:true,status:200,json:async()=>({resource_response:{data,...(!normalized && cursor !== undefined ? {bookmark:cursor}: {})},...(normalized ? {resource:{options:{bookmarks:[cursor]}}}: {})})});
const noWait = async () => {};
(async () => {
  const requests = [];
  let transient = true;
  const result = await fetchBoardFeed(url,5000,()=>{},async (endpoint, init) => {
    const u = new URL(endpoint), {options} = JSON.parse(u.searchParams.get('data'));
    assert.equal(u.origin,new URL(url).origin);
    assert.equal(init.credentials,'include');
    requests.push({resource:u.pathname,options});
    if(u.pathname.includes('BoardResource')) return response({id:'99',name:'Tracker',pin_count:637});
    if(u.pathname.includes('BoardSectionsResource')) return response([{id:'88',title:'Section'}]);
    const isSection = u.pathname.includes('BoardSectionPins');
    const start = Number(options.bookmarks[0] || 0);
    assert.equal(options.page_size,50);
    if(!isSection && start === 50 && transient) {transient=false;return {ok:false,status:503};}
    const count = isSection ? 138 : 499;
    const items = Array.from({length:Math.min(50,count-start)},(_,i)=>pin((isSection ? 500 : 1)+start+i));
    if(!isSection && start===0) items[0].images = {}; // Later data must fill this image.
    if(isSection && start===0) items.push(pin(1));
    return response(items,start+50>=count ? '-end-' : String(start+50),true);
  },noWait);
  assert.equal(result.finished,true);
  assert.equal(result.pins.length,637);
  assert.equal(result.expectedCount,637);
  assert.equal(result.pages,13);
  assert.ok(result.pins.every(p=>p.imageUrl));
  assert.equal(result.pins[0].pinUrl,'https://www.pinterest.com/pin/1/');
  assert.equal(result.pins[0].description,'Description 1');
  assert.equal(requests.filter(r=>r.options.bookmarks?.[0]==='50' && r.resource.includes('BoardFeed')).length,2);

  const partial = await fetchBoardFeed(url,5000,()=>{},async endpoint => new URL(endpoint).pathname.includes('BoardResource')
    ? response({id:'99',pin_count:637}) : response([pin(1)],'repeated'),noWait);
  assert.equal(partial.finished,false);
  assert.equal(partial.pins.length,1);
  assert.match(partial.error,/end marker/);
  let emptyRequests=0;
  const empty = await fetchBoardFeed(url,5000,()=>{},async endpoint => {
    if(new URL(endpoint).pathname.includes('BoardResource')) return response({id:'99',pin_count:637});
    emptyRequests++;return response([],'cursor');
  },noWait);
  assert.equal(emptyRequests,3);
  assert.equal(empty.finished,false);
  assert.match(empty.error,/empty page/);
  let authRequests=0;
  const auth = await fetchBoardFeed(url,5000,()=>{},async()=>{authRequests++;return {ok:false,status:403}},noWait);
  assert.equal(authRequests,1);
  assert.match(auth.error,/login/);
  const existing = {...result.pins[0], imageUrl:'',title:'Existing title',description:'Existing description'};
  mergeFeedPin(existing,{...result.pins[0],title:'',description:''});
  assert.ok(existing.imageUrl);
  assert.equal(existing.title,'Existing title');
  assert.equal(existing.description,'Existing description');
  const nested=pin(1);nested.related_pins=[pin(2)];
  assert.equal(parseFeedPins([nested]).length,1);
  console.log('Passed: 637 pins across board/section pages, same-session requests, canonical URLs, metadata enrichment, retries, stalled cursors and authentication errors.');
})().catch(error=>{console.error(error);process.exitCode=1});
