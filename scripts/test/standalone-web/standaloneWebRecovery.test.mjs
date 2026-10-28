import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {stripTypeScriptTypes} from 'node:module';

const sourceRoot=process.env.ZCODE_SOURCE_ROOT||process.cwd();
const main=await readFile(join(sourceRoot,'packages/web/src/main.tsx'),'utf8');
const controllerSource=main.slice(main.indexOf('function createStandaloneWebConnection('),main.indexOf('\nasync function bootstrapWebApp()'));
assert.ok(controllerSource.length>1000,'Actual upstream entry controller must be present');
assert.match(controllerSource,/createWebRemoteControlLifecycleRecovery/,'Controller must reuse the official lifecycle recovery');
// 控制器现在引用官方 lifecycle 恢复函数；把官方文件本身一起编译进测试 data module，
// 用真实实现而不是副本 mock，保证监听与暂停/恢复语义与生产一致。
const lifecycleSource=await readFile(join(sourceRoot,'packages/web/src/web-remote-control/app/webRemoteControlLifecycle.ts'),'utf8');
const compiled=stripTypeScriptTypes(lifecycleSource+'\n'+controllerSource+'\nexport {createStandaloneWebConnection};',{mode:'transform'});
const {createStandaloneWebConnection}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};

function makeHarness(overrides={}) {
 const win=new EventTarget(),doc=new EventTarget();doc.visibilityState='visible';
 const states=[],ready=[],connections=[],sent=[],settingReads=[],settingWrites=[];
 const ports={windowTarget:win,documentTarget:doc,checkAccess:async()=>true,
  connect:async options=>{
   const index=connections.length;
   const listeners=new Set();
   const services={
    systemService:{info:async()=>({})},
    settingService:{
     get:async()=>{settingReads.push(index);return{recentProjects:[],locale:'en'};},
     update:async patch=>{settingWrites.push({index,patch});},
     updateDataBaseDir:async()=>{},
    },
    broadcastService:{
     send:async message=>{sent.push({index,message});},
     onMessage(listener){listeners.add(listener);return{dispose(){listeners.delete(listener);}};},
    },
   };
   connections.push({options,services,emit(message){for(const f of listeners)f(message);}});
   return services;
  },onState:s=>states.push(s),onReady:s=>ready.push(s),...overrides};
 const owner=createStandaloneWebConnection(ports);
 return {owner,ports,win,doc,states,ready,connections,sent,settingReads,settingWrites};
}

function harness(t,overrides={}) {
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const h=makeHarness(overrides);
 t.after(()=>{h.owner.dispose();t.mock.timers.reset();});
 return h;
}

test('real close changes both in-flight and new RPCs from pending to rejection',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'zcode-ws-regression-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(join(dir,'package.json'),'{"type":"module"}');
 for(const file of ['buffer','foundation','serialization','channels.shared','channelClient','protocol']){
  let source=await readFile(join(sourceRoot,'packages/rpc/src',file+'.ts'),'utf8');
  // Node's isolated TS stripper cannot infer imports used only as types.
  source=source.replace('Event, Emitter, IDisposable, DisposableStore','Event, Emitter, type IDisposable, DisposableStore');
  if(file==='channelClient')source=source.replace('type,\n','type,\n');
  let js=stripTypeScriptTypes(source,{mode:'transform'});
  if(file==='channelClient')js=js.replace(/import \{([^}]+)\} from "\.\/foundation.js";/,(_,names)=>`import {${names.replace(/\bIDisposable\b,?\s*/g,'')}} from "./foundation.js";`);
  await writeFile(join(dir,file+'.js'),js);
 }
 let wsSource=await readFile(join(sourceRoot,'packages/client/src/websocket.ts'),'utf8');
 wsSource=wsSource.replace(/import \{[\s\S]*?\} from "@zcode\/rpc";/,`import {Emitter} from './foundation.js';import {VSBuffer} from './buffer.js';import {SocketProtocol} from './protocol.js';import {ChannelClient} from './channelClient.js';`)
 .replace('import type { IServiceAccessor } from "@zcode/services";','')
 .replace('import { RemoteServiceAccess } from "./remoteServiceAccess.js";',`class RemoteServiceAccess {constructor(client){this.client=client;}}`);
 await writeFile(join(dir,'websocket.js'),stripTypeScriptTypes(wsSource,{mode:'transform'}));
 class FakeSocket extends EventTarget {
  static OPEN=1;static last;readyState=0;sent=[];
  constructor(){super();FakeSocket.last=this;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
  send(b){this.sent.push(b);}
  close(){if(this.readyState===3)return;this.readyState=3;const e=new Event('close');Object.assign(e,{code:1006,reason:'test',wasClean:false});this.dispatchEvent(e);}
  deliver(b){const e=new Event('message');e.data=b;this.dispatchEvent(e);}
 }
 const original=globalThis.WebSocket;globalThis.WebSocket=FakeSocket;t.after(()=>globalThis.WebSocket=original);
 const {pathToFileURL}=await import('node:url');
 const {connectViaWebSocket}=await import(pathToFileURL(join(dir,'websocket.js')));
 const {BufferWriter,serialize}=await import(pathToFileURL(join(dir,'serialization.js')));
 let closed=0;const services=await connectViaWebSocket('ws://test.invalid',{onClose:()=>closed++});
 const w=new BufferWriter();serialize(w,[200]);serialize(w,undefined);const b=w.buffer;
 const packet=Buffer.alloc(13+b.byteLength);packet[0]=1;packet.writeUInt32BE(b.byteLength,9);packet.set(b.buffer,13);
 FakeSocket.last.deliver(packet.buffer.slice(packet.byteOffset,packet.byteOffset+packet.byteLength));
 const before=services.client.getChannel('project').call('readTree',[]);
 const beforeCheck=assert.rejects(before,{name:'ConnectionClosed'});
 FakeSocket.last.close();
 await beforeCheck;
 await assert.rejects(services.client.getChannel('project').call('readTree',[]),/disposed/);
 assert.equal(closed,1);
 assert.equal(FakeSocket.last.sent.length,1,'closed transport never admits another RPC');
 const cancellation=new AbortController();
 const next=await connectViaWebSocket('ws://test.invalid',{signal:cancellation.signal});
 cancellation.abort();
 await assert.rejects(next.client.getChannel('project').call('readTree',[]),/disposed/);
});

test('reconnect publishes fresh services without replaying writes; captured broadcast follows new owner',async t=>{
 const h=harness(t);await flush();assert.equal(h.states.at(-1),'connected');
 const original=h.ready[0];let received=0;
 original.broadcastService.onMessage(()=>received++);
 h.connections[0].emit({channel:'state:theme'});assert.equal(received,1);
 h.connections[0].options.onClose();h.connections[0].options.onClose();
 assert.equal(h.connections[0].options.signal.aborted,true);
 t.mock.timers.tick(1000);await flush();assert.equal(h.connections.length,2);
 assert.equal(h.states.at(-1),'connected');
 assert.notEqual(h.ready[0].systemService,h.ready[1].systemService);
 assert.equal(h.ready[0].broadcastService,h.ready[1].broadcastService);
 h.connections[0].emit({channel:'old'});assert.equal(received,1);
 h.connections[1].emit({channel:'new'});assert.equal(received,2);
 assert.equal(h.sent.length,0,'reconnection must not replay writes');
 await original.broadcastService.send({channel:'state:theme'});
 assert.equal(h.sent[0].index,1);
});

test('settingService facade keeps identity across reconnect and routes reads to the new connection',async t=>{
 const h=harness(t);await flush();assert.equal(h.states.at(-1),'connected');
 const facade=h.ready[0].settingService;
 await facade.get();
 assert.deepEqual(h.settingReads,[0]);
 // 断线：live 已清空，转发对象必须明确拒绝，不排队也不缓存写请求。
 h.connections[0].options.onClose();
 await assert.rejects(facade.get(),/ConnectionClosed/);
 await assert.rejects(facade.update({locale:'en'}),/ConnectionClosed/);
 assert.equal(h.settingWrites.length,0,'断线期间的设置写请求不能被缓存或重放');
 t.mock.timers.tick(1000);await flush();
 assert.equal(h.connections.length,2);assert.equal(h.states.at(-1),'connected');
 const nextFacade=h.ready[1].settingService;
 assert.equal(facade,nextFacade,'同一 controller 下 settingService 身份必须稳定');
 await nextFacade.get();
 assert.deepEqual(h.settingReads,[0,1],'重连后读取必须路由到新连接');
 assert.notEqual(h.ready[0].systemService,h.ready[1].systemService,'其他 services 必须保持 fresh');
 assert.equal(h.ready[0].broadcastService,h.ready[1].broadcastService);
});

test('standalone controllers keep independent settingService facades',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const a=makeHarness(),b=makeHarness();
 t.after(()=>{a.owner.dispose();b.owner.dispose();t.mock.timers.reset();});
 await flush();
 assert.equal(a.states.at(-1),'connected');assert.equal(b.states.at(-1),'connected');
 assert.notEqual(a.ready[0].settingService,b.ready[0].settingService,'不同 controller 的转发对象必须相互独立');
 await a.ready[0].settingService.get();
 await b.ready[0].settingService.get();
 assert.deepEqual(a.settingReads,[0]);
 assert.deepEqual(b.settingReads,[0]);
});

test('hidden then visible keeps a healthy connection instead of rebuilding it',async t=>{
 const h=harness(t);await flush();assert.equal(h.states.at(-1),'connected');
 h.doc.visibilityState='hidden';h.doc.dispatchEvent(new Event('visibilitychange'));
 h.doc.visibilityState='visible';h.doc.dispatchEvent(new Event('visibilitychange'));
 await flush();
 assert.equal(h.connections.length,1,'健康连接不应因切后台重建');
 assert.equal(h.states.at(-1),'connected');
});

test('initial pageshow does not open a second connection',async t=>{
 const h=harness(t);
 h.win.dispatchEvent(new Event('pageshow'));
 await flush();
 assert.equal(h.connections.length,1,'首屏 pageshow 不应重复建连');
 assert.equal(h.states.at(-1),'connected');
});

test('half-open connection is retired after one bounded heartbeat and recovers',async t=>{
 const h=harness(t);await flush();
 h.connections[0].services.systemService.info=()=>new Promise(()=>{});
 t.mock.timers.tick(25000);await flush();
 h.win.dispatchEvent(new Event('online'));h.win.dispatchEvent(new Event('pageshow'));
 t.mock.timers.tick(10000);await flush();
 assert.equal(h.connections[0].options.signal.aborted,true);
 t.mock.timers.tick(1000);await flush();
 assert.equal(h.connections.length,2);assert.equal(h.states.at(-1),'connected');
});

test('authentication block preserves current page and stops socket retries until recovery',async t=>{
 const h=harness(t,{checkAccess:async()=>false});await flush();
 assert.equal(h.states.at(-1),'auth-required');assert.equal(h.connections.length,0);
 t.mock.timers.tick(120000);await flush();assert.equal(h.connections.length,0);
 h.ports.checkAccess=async()=>true;h.owner.retry();await flush();
 assert.equal(h.states.at(-1),'connected');assert.equal(h.connections.length,1);
});

test('concurrent resume triggers do not create competing connections; disposed attempt stays stale',async t=>{
 let complete;const delayed=new Promise(resolve=>complete=resolve);
 const h=harness(t,{checkAccess:()=>delayed});
 h.win.dispatchEvent(new Event('online'));h.win.dispatchEvent(new Event('pageshow'));h.doc.dispatchEvent(new Event('visibilitychange'));
 h.owner.dispose();complete(true);await flush();
 assert.equal(h.connections.length,0);assert.equal(h.ready.length,0);
});

test('ordinary Web wires recovery to stable root and leaves desktop relay branch separate',()=>{
 const entry=main.slice(main.indexOf('async function bootstrapWebApp()'));
 assert.match(entry,/createStandaloneWebConnection\(/);
 assert.match(entry,/inert=\{state !== "connected"\}/);
 assert.doesNotMatch(entry,/location\.reload/);
 assert.match(entry,/connectViaWebSocket\(bootstrap.wsUrl, options\)/);
 assert.match(entry,/signal: AbortSignal\.any/);
 assert.match(entry,/if \(isWebRemoteControlRoute\(\)\)/);
 // 重连提示延迟 1500ms，且只在曾加载 services 后延迟；auth-required 与首连不延迟。
 assert.match(entry,/STANDALONE_RECONNECT_HINT_DELAY_MS/);
 assert.match(entry,/hasLoadedServices/);
 // 断线到连接前保存并恢复编辑器焦点，使用 React commit（useLayoutEffect）而非 sleep/轮询。
 assert.match(main,/StandaloneFocusRestoreEffect/);
 assert.match(main,/focus\(\{ preventScroll: true \}\)/);
});


test('manual retry replaces a live connection immediately without replaying writes',async t=>{
 const h=harness(t);await flush();const facade=h.ready[0].settingService;
 h.owner.retry();await flush();
 assert.equal(h.connections[0].options.signal.aborted,true);
 assert.equal(h.connections.length,2);
 assert.equal(h.states.at(-1),'connected');
 assert.equal(h.ready[1].settingService,facade);
 assert.deepEqual(h.sent,[]);assert.deepEqual(h.settingWrites,[]);
});

test('manual retry cancels a pending Access probe and ignores its late result',async t=>{
 let finishFirst;const signals=[];
 const h=harness(t,{checkAccess:signal=>{signals.push(signal);return signals.length===1?new Promise(resolve=>finishFirst=resolve):Promise.resolve(true);}});
 assert.equal(signals.length,1);h.owner.retry();await flush();
 assert.equal(signals[0].aborted,true);assert.equal(signals.length,2);
 assert.equal(h.connections.length,1);assert.equal(h.states.at(-1),'connected');
 finishFirst(false);await flush();
 assert.equal(h.states.at(-1),'connected');assert.equal(h.connections.length,1);
 assert.equal(signals[1].aborted,false);
});


const focusSource=main.slice(main.indexOf('function isStandaloneRestorableFocusTarget('),main.indexOf('// connected 提交并移除 inert 后'));
const focusCode=stripTypeScriptTypes(focusSource+'\nexport {restoreStandaloneFocusAfterReconnect};',{mode:'transform'});
const {restoreStandaloneFocusAfterReconnect}=await import('data:text/javascript;base64,'+Buffer.from(focusCode).toString('base64'));
function focusHarness(t) {
 const oldDocument=globalThis.document;let focused=false;
 const doc={visibilityState:'hidden',hasFocus:()=>focused,body:{},activeElement:null};doc.activeElement=doc.body;
 const element={isConnected:true,tagName:'INPUT',focus(){doc.activeElement=this;},setSelectionRange(a,b){this.selection=[a,b];}};
 globalThis.document=doc;t.after(()=>{if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;});
 const store={pending:{element,selectionStart:2,selectionEnd:5,range:null}};
 return {doc,element,store,setFocused:v=>focused=v};
}
test('background reconnect retains focus snapshot until the page is visible and focused',t=>{
 const h=focusHarness(t);restoreStandaloneFocusAfterReconnect(h.store);assert.ok(h.store.pending);
 h.doc.visibilityState='visible';restoreStandaloneFocusAfterReconnect(h.store);assert.ok(h.store.pending);
 h.setFocused(true);restoreStandaloneFocusAfterReconnect(h.store);
 assert.equal(h.doc.activeElement,h.element);assert.deepEqual(h.element.selection,[2,5]);assert.equal(h.store.pending,undefined);
});
test('focus recovery respects another selected control and detached editors',t=>{
 const h=focusHarness(t);h.doc.visibilityState='visible';h.setFocused(true);h.doc.activeElement={};
 restoreStandaloneFocusAfterReconnect(h.store);assert.equal(h.store.pending,undefined);assert.equal(h.element.selection,undefined);
 h.store.pending={element:h.element,selectionStart:2,selectionEnd:5,range:null};h.element.isConnected=false;h.doc.activeElement=h.doc.body;
 restoreStandaloneFocusAfterReconnect(h.store);assert.equal(h.store.pending,undefined);assert.equal(h.doc.activeElement,h.doc.body);
});
