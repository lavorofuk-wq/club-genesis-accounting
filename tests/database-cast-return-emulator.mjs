import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeApp, deleteApp } from 'firebase/app';
import { connectDatabaseEmulator, get, getDatabase, goOffline, ref, serverTimestamp, update } from 'firebase/database';
const port=9107, ns='demo-gms-cast-return';
const url=`http://127.0.0.1:${port}`;
assert.equal(new URL(url).hostname,'127.0.0.1');
assert.ok(ns.startsWith('demo-'));
const apps=[], dbs=[];
async function admin(path='',method='GET',body) { const response=await fetch(`${url}/${path}.json?ns=${ns}`,{method,headers:{Authorization:'Bearer owner','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();if(!response.ok)throw new Error(JSON.stringify(result));return result; }
function client(uid){const app=initializeApp({projectId:ns,databaseURL:`https://${ns}.firebaseio.com`,apiKey:'demo-only'},uid);const db=getDatabase(app);connectDatabaseEmulator(db,'127.0.0.1',port,{mockUserToken:{sub:uid,user_id:uid,email:`${uid}@example.test`}});apps.push(app);dbs.push(db);return db;}
let count=0;
async function explain(patch, uid) {
 const root = await admin(); const next = structuredClone(root);const timestamp=Date.now();
 function resolve(v){if(v&&typeof v==='object'){if(v['.sv']==='timestamp')return timestamp;return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,resolve(x)]));}return v;}
 for(const [key,value]of Object.entries(patch)){const keys=['accounting-dev',...key.split('/')];let node=next;for(const key of keys.slice(0,-1))node=node[key]??={};if(value===null)delete node[keys.at(-1)];else node[keys.at(-1)]=resolve(value);}
 class Snap {constructor(tree,path=[]){this.tree=tree;this.path=path;}val(){return this.path.reduce((v,k)=>v?.[k],this.tree)??null;}child(path){return new Snap(this.tree,[...this.path,...String(path).split('/')]);}parent(){return new Snap(this.tree,this.path.slice(0,-1));}exists(){return this.val()!==null;}isString(){return typeof this.val()==='string';}isNumber(){return typeof this.val()==='number';}isBoolean(){return typeof this.val()==='boolean';}hasChildren(keys=[]){const v=this.val();return v&&typeof v==='object'&&Object.keys(v).length>0&&keys.every(k=>this.child(k).exists());}}
 const tree=JSON.parse(await readFile(new URL('../database.rules.json',import.meta.url),'utf8')).rules;
 const walk=(rule,path=[],vars={})=>{for(const [key,value]of Object.entries(rule)){if(key==='.validate'||key==='.write'){if(!(path[1]==='history'||path[1]==='cashRevisions'))continue;if(key==='.validate'&&!new Snap(next,path).exists())continue;try{const names=['root','data','newData','auth','now',...Object.keys(vars)];const result=new Function(...names,`return Boolean(${String(value).replaceAll('.matches(','.match(').replaceAll('.beginsWith(','.startsWith(')});`)(new Snap(root),new Snap(root,path),new Snap(next,path),{uid},timestamp,...Object.values(vars));if(!result)console.log('RULE FAIL',key,path.join('/'));}catch(e){console.log('RULE ERROR',path.join('/'),e.message);} }else if(!key.startsWith('.')){if(key.startsWith('$')){const keys=Object.keys(new Snap(next,path).val()||{});for(const actual of keys){if(Object.hasOwn(rule,actual))continue;walk(value,[...path,actual],{...vars,[key]:actual});}}else walk(value,[...path,key],vars);}}};walk(tree);
}
async function allow(label,db,patch){await update(ref(db,'accounting-dev'),patch);count++;console.log(`PASS allow ${label}`);}
async function deny(label,db,patch){await assert.rejects(update(ref(db,'accounting-dev'),patch),/permission/i);count++;console.log(`PASS deny ${label}`);}
const stamp='2026-09-01T12:00:00.000Z', returnedAt='2026-09-20T01:00:00.000Z';
const checksum='a'.repeat(64), id='source', handoffId='11111111-1111-4111-8111-111111111111';
const sales={cashSales:100000,cardSales:0,totalSales:100000};
const cash={...sales,cashFloat:200000,expenseAndPaymentTotal:0,expectedClosingCash:300000,cashProfit:100000,actualClosingCash:300000,difference:0,
 funding:{schema:2,previousClosingId:'',previousBusinessDate:'',previousClosingCash:200000,openingShortfall:0,openingPersonalDebt:0,companyReplenishment:0,personalReplenishment:0,companyTransfer:0,personalRepayment:0,closingPersonalDebt:0,confirmed:true}};
const customers={groupCount:0,totalCustomers:0}, nominations={honShimeiCount:0,jonaiCount:0};
const source={id,businessDate:'2026-09-01',businessMonth:'2026-09',status:'approved',updatedAt:stamp,approvedAt:stamp,approvedBy:'accounting',submittedAt:stamp,submittedAtMs:1000,submittedBy:'shop',submissionId:'submission-source',checksum,sales,cash,customers,nominations,
  posSnapshot:{schema:'club-genesis-pos-closing',schemaVersion:3,businessDate:'2026-09-01',submissionId:'submission-source',checksum,sales,customers,nominations}};
const draft={sourceClosingId:id,sourceUpdatedAt:stamp,sourceChecksum:checksum,sourceSubmissionId:'submission-source',entries:[{id:'pos1',originalPosCastId:'pos1',targetClosingId:id,businessDate:'2026-09-01',masterId:'cast1',name:'合成キャスト',kind:'regular',startTime:'20:00',endTime:'01:00',breakMinutes:0,hourlyRate:3000,honShimeiCount:2,banaiShimeiCount:0,honShimeiSales:100000,jonaiExtensionSales:0,beautyAllowance:0,deleted:false}],products:[{id:'bottle',name:'合成シャンパン',kind:'champagneWine',unitPrice:35000,unitCost:12500,quantity:1,classification:'honShimei',targets:['pos1'],externalTargetCount:0}]};
draft.entries=Array.from({length:3},(_,i)=>({...draft.entries[0],id:`pos${i+1}`,originalPosCastId:`pos${i+1}`,masterId:`cast${i+1}`,name:`合成キャスト${i+1}`,dohan:Array.from({length:3},()=>({arrivalTime:'20:00',extended:false,quantity:1}))}));
draft.products=Array.from({length:3},(_,i)=>({...draft.products[0],id:`product${i}`,targets:['pos1','pos2','pos3']}));
source.casts=draft.entries.map(e=>({posCastId:e.id,masterId:e.masterId,name:e.name,kind:e.kind,startTime:'20:00',endTime:'01:00',hours:5,hourlyRate:3000,honShimeiCount:0,banaiShimeiCount:0,dohanCount:0,dohanBack:0,honShimeiSales:0,jonaiExtensionSales:0,drinkSales:0,liquorCost:0,beautyAllowance:0,dailyPayment:0,advancePayment:0,transportFee:0}));
const originalCasts=source.casts.map(({posCastId,masterId,name,kind,honShimeiCount,banaiShimeiCount,dohanCount})=>({posCastId,masterId,name,kind,honShimeiCount,banaiShimeiCount,dohanCount}));
const correction={sourceClosingId:id,revision:1,active:true,current:draft,history:{1:{revision:1,active:true,draft,reason:'売上訂正',createdAt:stamp,createdBy:'accounting'}}};
const handoff={schema:1,id:handoffId,sourceClosingId:id,sourceUpdatedAt:stamp,sourceChecksum:checksum,sourceSubmissionId:'submission-source',sourceCorrectionRevision:1,returnedAt,reason:'日払い確認',createdAt:returnedAt,createdBy:'accounting',draft,sourceRecordJson:JSON.stringify(source),originalCasts,draftShape:{entries:3,products:3,originalCasts:3,dohan:{0:3,1:3,2:3},targets:{0:3,1:3,2:3},indices:{0:0,1:1,2:2}}};
const patch={castDailyCorrectionRevision:2,'castDailyCorrections/source/revision':2,'castDailyCorrections/source/active':false,'castDailyCorrections/source/current':null,'castDailyCorrections/source/history/2':{revision:2,active:false,reason:'店舗へ引継ぎ：日払い確認',createdAt:returnedAt,createdBy:'accounting'},'castDailyCorrectionClaims/source/source':null,
 [`castReturnHandoffs/source/${handoffId}`]:handoff,'history/source/status':'returned','history/source/updatedAt':returnedAt,'history/source/returnedAt':returnedAt,'history/source/returnedBy':'accounting','history/source/returnedFromStatus':'approved','history/source/returnReason':'日払い確認','history/source/castReturnHandoffId':handoffId};
try {
 const text=await readFile(new URL('../database.rules.json',import.meta.url),'utf8');
 await admin('.settings/rules','PUT',JSON.parse(text.replaceAll('[\\\\s\\\\S]','(.|\\\\n|\\\\r)').replaceAll('\\\\S','[^ ]')));
 await admin('','PUT',{users:{accounting:{role:'accounting'},shop:{role:'shop'},op:{role:'op'}},'accounting-dev':{history:{source},castDailyCorrectionRevision:1,castDailyCorrections:{source:correction},castDailyCorrectionClaims:{source:{source:{sourceClosingId:id,revision:1}}}}});
 const accounting=client('accounting'),shop=client('shop');
 await deny('shop cannot return or archive',shop,patch);
 const missing=structuredClone(patch);delete missing[`castReturnHandoffs/source/${handoffId}`];await deny('no archive',accounting,missing);
 const stale=structuredClone(patch);stale[`castReturnHandoffs/source/${handoffId}`].sourceUpdatedAt='old';await deny('stale source',accounting,stale);
 const changed=structuredClone(patch);changed[`castReturnHandoffs/source/${handoffId}`].draft.entries[0].honShimeiSales=999990;await deny('changed handoff draft',accounting,changed);
 const claims=structuredClone(patch);delete claims['castDailyCorrectionClaims/source/source'];await deny('claim retained',accounting,claims);
 for(const [label,mutate]of [
  ['archive missing last entry',h=>h.draft.entries.pop()],['archive missing middle entry',h=>{delete h.draft.entries[1];}],
  ['archive missing product',h=>h.draft.products.pop()],['archive missing middle product',h=>{delete h.draft.products[1];}],
  ['archive missing dohan',h=>h.draft.entries[0].dohan.pop()],['archive missing middle dohan',h=>{delete h.draft.entries[0].dohan[1];}],
  ['archive missing target',h=>h.draft.products[0].targets.pop()],['archive missing middle target',h=>{delete h.draft.products[0].targets[1];}],
  ['archive missing original cast',h=>h.originalCasts.pop()],['archive missing middle original cast',h=>{delete h.originalCasts[1];}],
 ]){const attempt=structuredClone(patch);mutate(attempt[`castReturnHandoffs/source/${handoffId}`]);await deny(label,accounting,attempt);}
 await allow('atomic return with immutable handoff',accounting,patch);
 const returned=await admin('accounting-dev/history/source');assert.deepEqual(returned.cash,cash);assert.deepEqual(returned.posSnapshot,source.posSnapshot);
 assert.equal((await get(ref(shop,`accounting-dev/castReturnHandoffs/source/${handoffId}`))).val().sourceCorrectionRevision,1);count++;console.log('PASS shop reads handoff');
 await deny('immutable archive',accounting,{[`castReturnHandoffs/source/${handoffId}/reason`]:'rewrite'});
 const token='submit-token', operationId='22222222-2222-4222-8222-222222222222';
 await allow('shop submit lock',shop,{cashManagementLock:{id:'source',operation:'submit',token,owner:'shop',acquiredAtMs:serverTimestamp(),expiresAt:Date.now()+120000}});
 const submitted={...returned,status:'submitted',updatedAt:'2026-09-20T02:00:00.000Z',submittedAt:'2026-09-20T02:00:00.000Z',submittedAtMs:serverTimestamp(),submittedBy:'shop',cashManagementToken:token,cashRevisionId:operationId,previousUpdatedAt:returnedAt,cashRevisionReason:'店舗データ再送',castInputRevision:{schema:1,handoffId,sourceCorrectionRevision:1,draft,originalCasts}};
 for(const key of ['returnedAt','returnedBy','returnedFromStatus','returnReason','approvedAt','approvedBy','castReturnHandoffId'])delete submitted[key];
 const cashRevision={schema:1,dailyId:'source',businessDate:source.businessDate,operationId,cashManagementToken:token,beforeCash:cash,beforeRecordJson:JSON.stringify(returned),beforeUpdatedAt:returnedAt,beforeStatus:'returned',actor:'shop',createdAtMs:serverTimestamp(),reason:'店舗データ再送'};
 const submitPlan={'history/source':submitted,[`cashRevisions/source/${operationId}`]:cashRevision};
 const dropped=structuredClone(submitPlan);delete dropped['history/source'].castInputRevision;await deny('same POS cannot silently drop handoff',shop,dropped);
 const spoofed=structuredClone(submitPlan);spoofed['history/source'].castInputRevision.draft.products[0].unitPrice=999;await deny('shop cannot rewrite accepted correction',shop,spoofed);
 const mixed=structuredClone(submitPlan);mixed['history/source'].checksum='b'.repeat(64);mixed['history/source'].submissionId='submission-new';mixed['history/source'].posSnapshot.checksum=mixed['history/source'].checksum;mixed['history/source'].posSnapshot.submissionId='submission-new';await deny('new POS cannot reuse old accepted input',shop,mixed);
 for(const [label,mutate]of [
  ['input missing last entry',v=>v.draft.entries.pop()],['input missing middle entry',v=>{delete v.draft.entries[1];}],
  ['input missing product',v=>v.draft.products.pop()],['input missing middle product',v=>{delete v.draft.products[1];}],
  ['input missing dohan',v=>v.draft.entries[0].dohan.pop()],['input missing middle dohan',v=>{delete v.draft.entries[0].dohan[1];}],
  ['input missing target',v=>v.draft.products[0].targets.pop()],['input missing middle target',v=>{delete v.draft.products[0].targets[1];}],
  ['input missing original casts',v=>{delete v.originalCasts;}],['input missing last original cast',v=>v.originalCasts.pop()],['input missing middle original cast',v=>{delete v.originalCasts[1];}],
 ]){const attempt=structuredClone(submitPlan);mutate(attempt['history/source'].castInputRevision);await deny(label,shop,attempt);}
 try{await allow('shop resubmits accepted correction once',shop,submitPlan);}catch(error){await explain(submitPlan,'shop');throw error;}
 assert.equal((await admin('accounting-dev/castDailyCorrections/source')).active,false);assert.deepEqual((await admin('accounting-dev/history/source')).cash,cash);
 await allow('shop releases submit lock',shop,{cashManagementLock:null});
 await allow('accounting approval lock',accounting,{cashManagementLock:{id:'source',operation:'approve',token:'approve-token',owner:'accounting',acquiredAtMs:serverTimestamp(),expiresAt:Date.now()+120000}});
 await allow('accounting reapproval keeps accepted input',accounting,{'history/source/status':'approved','history/source/updatedAt':'2026-09-20T03:00:00.000Z','history/source/approvedAt':'2026-09-20T03:00:00.000Z','history/source/approvedBy':'accounting','history/source/cashManagementToken':'approve-token'});
 assert.equal((await admin('accounting-dev/castDailyCorrections/source')).active,false);
 await allow('second return without new accounting correction',accounting,{'history/source/status':'returned','history/source/updatedAt':'2026-09-20T04:00:00.000Z','history/source/returnedAt':'2026-09-20T04:00:00.000Z','history/source/returnedBy':'accounting','history/source/returnedFromStatus':'approved','history/source/returnReason':'再確認'});
 assert.deepEqual((await admin('accounting-dev/history/source')).castInputRevision.draft,draft);
 console.log(`RESULT ${count} return/resubmit permission tests passed`);
} finally {for(const db of dbs)goOffline(db);await Promise.all(apps.map(deleteApp));}
