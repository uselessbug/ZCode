// Standalone Web task management (archive/unarchive/delete/rename/pin/read) and
// project-creation / non-project work mode compatibility regression.
//
// These tests compile the ACTUAL upstream source files (via Node's type stripper)
// and exercise them with minimal injected ports, so the assertions describe the
// shipped implementation rather than a copy of it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {stripTypeScriptTypes} from 'node:module';
import {pathToFileURL} from 'node:url';

const sourceRoot=process.env.ZCODE_SOURCE_ROOT||process.cwd();
const read=(path)=>readFile(join(sourceRoot,path),'utf8');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function scratch(t,prefix){
 const dir=await mkdtemp(join(tmpdir(),prefix));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 return dir;
}

/** Write a module into the scratch dir and return its file URL for import. */
async function emit(dir,name,source){
 const file=join(dir,`${name}.js`);
 await writeFile(file,stripTypeScriptTypes(source,{mode:'transform'}));
 return pathToFileURL(file).href;
}

/** Minimal zod surface used by the compiled project sources. */
const ZOD_STUB=`
function chain(check){
 const api={
  optional:()=>chain(value=>value===undefined||check(value)),
  strict:()=>api,refine:()=>api,min:()=>api,max:()=>api,
  uuid:()=>chain(value=>typeof value==='string'&&${UUID.toString()}.test(value)),
  parse:(value)=>{if(!check(value))throw new Error('zod.invalid');return value;},
 };
 return api;
}
export const z={
 string:()=>chain(value=>typeof value==='string'),
 boolean:()=>chain(value=>typeof value==='boolean'),
 array:()=>chain(value=>Array.isArray(value)),
 object:()=>chain(value=>value!==null&&typeof value==='object'),
};
`;

// ---------------------------------------------------------------------------
// Area A: service exposure, task fallback, archive-conditioned deletion
// ---------------------------------------------------------------------------

/** Compile packages/client/src/remoteServiceAccess.ts against generated stubs. */
async function compileRemoteServiceAccess(dir){
 const source=await read('packages/client/src/remoteServiceAccess.ts');
 const names=new Set();
 for(const statement of source.matchAll(/^import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+"([^"]+)";/gm)){
  if(statement[2]!=='@zcode/services')continue;
  for(const raw of statement[1].split(',')){
   const name=raw.trim();
   if(!name||name.startsWith('type '))continue;
   names.add(name.split(/\s+as\s+/)[0].trim());
  }
 }
 assert.ok(names.has('IFileService')&&names.has('IWindowControllerService'),
  'service channel names must be discovered');
 await writeFile(join(dir,'services-stub.js'),
  [...names].map(name=>`export const ${name}={channelName:${JSON.stringify(name)}};`).join('\n'));
 await writeFile(join(dir,'rpc-stub.js'),
  'export const ProxyChannel={toService:(channel)=>({__channel:channel})};\n');
 const rewritten=source
  .replaceAll('from "@zcode/services";','from "./services-stub.js";')
  .replace('import { ProxyChannel, type IChannelClient } from "@zcode/rpc";',
   'import { ProxyChannel } from "./rpc-stub.js";');
 assert.ok(rewritten.includes('./services-stub.js'),'services stub must be wired');
 assert.ok(rewritten.includes('./rpc-stub.js'),'rpc stub must be wired');
 return import(await emit(dir,'remoteServiceAccess',rewritten));
}

test('standalone Web service access omits windowControllerService; desktop/relay keep it',async t=>{
 const dir=await scratch(t,'zcode-rsa-');
 const {RemoteServiceAccess}=await compileRemoteServiceAccess(dir);
 const channelClientOf=(seen)=>({getChannel:(name)=>{const channel={name};seen.set(name,channel);return channel;}});
 // 默认（桌面 / 桌面远控 / connectViaProtocol）仍构造 Controller 代理。
 const legacySeen=new Map();
 const legacy=new RemoteServiceAccess(channelClientOf(legacySeen));
 assert.equal(legacy.windowControllerService?.__channel?.name,'IWindowControllerService');
 assert.equal(legacy.zcodeTaskService.__channel.name,'IZCodeTaskService');
 // 独立 Web 显式关闭时保持 undefined，且不解析该 channel，消费方回退到 zcodeTaskService。
 const standaloneSeen=new Map();
 const standalone=new RemoteServiceAccess(channelClientOf(standaloneSeen),{exposeWindowController:false});
 assert.equal(standalone.windowControllerService,undefined);
 assert.equal(standaloneSeen.has('IWindowControllerService'),false,'channel must not be resolved');
 assert.equal(standaloneSeen.has('IZCodeTaskService'),true);
 const explicitSeen=new Map();
 const explicit=new RemoteServiceAccess(channelClientOf(explicitSeen),{exposeWindowController:true});
 assert.equal(explicit.windowControllerService.__channel.name,'IWindowControllerService');
});

test('connectViaWebSocket defaults exposeWindowController to false; explicit true still works',async t=>{
 const dir=await scratch(t,'zcode-ws-');
 const remoteStub=`
export const calls=[];
export class RemoteServiceAccess{constructor(client,options){calls.push(options??null);this.client=client;}}
`;
 await writeFile(join(dir,'remote-stub.js'),remoteStub);
 const source=(await read('packages/client/src/websocket.ts'))
  .replace('"./remoteServiceAccess.js"','"./remote-stub.js"');
 await writeFile(join(dir,'rpc-stub.js'),`
export class Emitter{constructor(){this.event=()=>({dispose(){}});}fire(){}}
export const VSBuffer={wrap:(value)=>value};
export class SocketProtocol{constructor(socket){this.socket=socket;}dispose(){}}
export class ChannelClient{constructor(protocol){this.protocol=protocol;}dispose(){}getChannel(name){return name;}}
`);
 const rewritten=source.replace(/import \{[\s\S]*?\} from "@zcode\/rpc";/,'import {Emitter,VSBuffer,SocketProtocol,ChannelClient} from "./rpc-stub.js";');
 const href=await emit(dir,'websocket',rewritten);
 class FakeSocket extends EventTarget{
  static OPEN=1;static last;
  readyState=0;
  constructor(){super();FakeSocket.last=this;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
  send(){}
  close(){if(this.readyState===3)return;this.readyState=3;const event=new Event('close');Object.assign(event,{code:1000,reason:'',wasClean:true});this.dispatchEvent(event);}
 }
 const original=globalThis.WebSocket;
 globalThis.WebSocket=FakeSocket;
 t.after(()=>{globalThis.WebSocket=original;});
 const {connectViaWebSocket}=await import(href);
 const {calls}=await import(pathToFileURL(join(dir,'remote-stub.js')).href);
 await connectViaWebSocket('ws://test.invalid');
 assert.deepEqual(calls.at(-1),{exposeWindowController:false});
 await connectViaWebSocket('ws://test.invalid',{exposeWindowController:true});
 assert.deepEqual(calls.at(-1),{exposeWindowController:true});
});

/** Compile task-mutation.ts with a minimal @zcode/shared stub. */
async function compileTaskMutation(dir){
 await writeFile(join(dir,'shared-stub.js'),
  'export function parseRemoteWorkspaceIdentity(){return null;}\n');
 const source=(await read('packages/ui/src/project-sidebar/task-mutation.ts'))
  .replace('"@zcode/shared"','"./shared-stub.js"');
 return import(await emit(dir,'task-mutation',source));
}

function taskServiceSpy(){
 const calls=[];
 const service={
  getTaskMeta:async(target)=>{calls.push(['getTaskMeta',target]);return null;},
  archiveTask:async(target)=>{calls.push(['archiveTask',target]);return {};},
  unarchiveTask:async(target)=>{calls.push(['unarchiveTask',target]);return {};},
  deleteTask:async(target)=>{calls.push(['deleteTask',target]);},
  deleteArchivedTask:async(target)=>{calls.push(['deleteArchivedTask',target]);return true;},
  renameTask:async(params)=>{calls.push(['renameTask',params]);return {};},
  setTaskPinned:async(params)=>{calls.push(['setTaskPinned',params]);return {};},
  setTaskUnread:async(params)=>{calls.push(['setTaskUnread',params]);return {};},
 };
 return {service,calls};
}

test('task mutations fall back to zcodeTaskService when no window controller exists',async t=>{
 const dir=await scratch(t,'zcode-mut-');
 const {mutateProjectTask,deleteArchivedProjectTask}=await compileTaskMutation(dir);
 const {service,calls}=taskServiceSpy();
 const task={workspacePath:'/workspace/projects/demo',taskId:'t1'};
 await mutateProjectTask({service},task,{kind:'archive',archived:true});
 await mutateProjectTask({service},task,{kind:'archive',archived:false});
 await mutateProjectTask({service},task,{kind:'rename',title:'renamed'});
 await mutateProjectTask({service},task,{kind:'pin',pinned:true});
 await mutateProjectTask({service},task,{kind:'mark-read',expectedUnreadAt:7});
 await mutateProjectTask({service},task,{kind:'mark-unread'});
 assert.deepEqual(calls.map(([name])=>name),
  ['archiveTask','unarchiveTask','renameTask','setTaskPinned','setTaskUnread','setTaskUnread']);
 assert.equal(calls[2][1].title,'renamed');
 assert.equal(calls[3][1].pinned,true);
 assert.deepEqual(calls[4][1],
  {workspacePath:task.workspacePath,workspaceIdentity:undefined,taskId:'t1',unread:false,expectedUnreadAt:7});
 assert.deepEqual(calls[5][1],
  {workspacePath:task.workspacePath,workspaceIdentity:undefined,taskId:'t1',unread:true});
 // 归档条件删除复用 deleteArchivedTask，而不是普通 deleteTask。
 assert.equal(await deleteArchivedProjectTask({service},task),true);
 assert.equal(calls.at(-1)[0],'deleteArchivedTask');
 assert.equal(calls.some(([name])=>name==='deleteTask'),false);
});

test('archive-conditioned deletion prefers the controller owner when present',async t=>{
 const dir=await scratch(t,'zcode-mut-ctl-');
 const {deleteArchivedProjectTask,mutateProjectTask}=await compileTaskMutation(dir);
 const {service,calls}=taskServiceSpy();
 const controllerCalls=[];
 const controller={
  deleteArchivedTask:async({address})=>{controllerCalls.push(address);return true;},
  mutateTask:async(params)=>{controllerCalls.push(params);return null;},
  getTaskMeta:async()=>({}),
 };
 const task={workspacePath:'/workspace/projects/demo',taskId:'t2',workspaceIdentity:'server:oci/workspace'};
 assert.equal(await deleteArchivedProjectTask({service,controller},task),true);
 assert.equal(controllerCalls.length,1);
 assert.equal(controllerCalls[0].taskId,'t2');
 assert.equal(calls.length,0,'controller path must not touch the local service');
 await mutateProjectTask({service,controller},task,{kind:'delete-archived'});
 assert.equal(controllerCalls.at(-1).mutation.kind,'delete-archived');
});

/** Slice runArchivedDeletion out of the real hook module and compile it standalone. */
async function compileArchivedDeletion(dir){
 const source=await read('packages/ui/src/project-sidebar/useArchiveManagement.ts');
 const start=source.indexOf('export async function runArchivedDeletion(');
 const end=source.indexOf('export function useArchiveManagement(');
 assert.ok(start>0&&end>start,'runArchivedDeletion must be extractable');
 const prelude=`
let __delete;
export function __setDelete(fn){__delete=fn;}
const deleteArchivedProjectTask=(...args)=>__delete(...args);
`;
 return import(await emit(dir,'archive-deletion',prelude+source.slice(start,end)));
}

test('archive deletion separates deleted, skipped and failed without hiding failures',async t=>{
 const dir=await scratch(t,'zcode-archive-');
 const {runArchivedDeletion,__setDelete}=await compileArchivedDeletion(dir);
 const outcomes=new Map([
  ['deleted',async()=>true],
  ['skipped',async()=>false],
  ['failed',async()=>{throw new Error('cli rejected delete');}],
 ]);
 __setDelete(async(_ports,task)=>outcomes.get(task.taskId)());
 const removed=[];
 const errors=[];
 const result=await runArchivedDeletion({
  tasks:[{taskId:'deleted'},{taskId:'skipped'},{taskId:'failed'},{taskId:'already-gone'}],
  ports:{service:{}},
  resolveRemoteSessionId:()=>null,
  isStillArchived:(task)=>task.taskId!=='already-gone',
  removeTaskState:(task)=>removed.push(task.taskId),
  onError:(task,error)=>errors.push([task.taskId,error.message]),
 });
 assert.deepEqual(result,{succeeded:1,failed:1,skipped:2});
 // 已删除与已取消归档都从归档视图移除；失败项必须保留在列表中以便重试。
 assert.deepEqual(removed.sort(),['deleted','skipped']);
 assert.deepEqual(errors,[['failed','cli rejected delete']]);
});

/** Slice deleteArchivedTask/deleteArchivedTasks out of the real adapter. */
async function compileArchivedDeletionAdapter(dir){
 const source=await read('packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts');
 const start=source.indexOf('    async deleteArchivedTask(params): Promise<boolean> {');
 const end=source.indexOf('    async renameTask(params): Promise<ZCodeTaskMeta> {');
 assert.ok(start>0&&end>start,'adapter deletion methods must be extractable');
 const prelude=`
let taskIndexRepo,taskIndexSyncer,emitWorkspaceTaskListChanged,logger,resolveWorkspaceKey;
export function __setup(deps){
 ({taskIndexRepo,taskIndexSyncer,emitWorkspaceTaskListChanged,logger,resolveWorkspaceKey}=deps);
}
export const api={
`;
 return import(await emit(dir,'adapter-deletion',prelude+source.slice(start,end)+'};\n'));
}

/** In-memory task index modelling archived/deleted columns and CLI fact mutations. */
function taskIndexDouble(rows){
 const store=new Map(rows.map((row)=>[row.taskId,{archived:true,deleted:false,...row}]));
 const events=[];
 return {
  store,events,
  getTaskIndexFlags:async({taskId})=>{
   const row=store.get(taskId);
   return row?{archived:row.archived,deleted:row.deleted}:null;
  },
  deleteArchivedTask:async({taskId})=>{
   const row=store.get(taskId);
   // 与真实 repo 同事务 guard：不存在/已删除/未归档一律返回 null。
   if(!row||row.deleted||!row.archived)return null;
   row.deleted=true;
   return {taskId};
  },
 };
}

test('archived deletion writes the CLI fact before the tombstone and never pre-hides failures',async t=>{
 const dir=await scratch(t,'zcode-adapter-');
 const {api,__setup}=await compileArchivedDeletionAdapter(dir);
 const index=taskIndexDouble([{taskId:'kept'},{taskId:'cli-confirms'},{taskId:'cli-fails'},{taskId:'restored'}]);
 index.store.get('restored').archived=false;
 const order=[];
 const emitted=[];
 __setup({
  taskIndexRepo:{
   getTaskIndexFlags:async(target)=>{order.push(`flags:${target.taskId}`);return index.getTaskIndexFlags(target);},
   deleteArchivedTask:async(target)=>{order.push(`tombstone:${target.taskId}`);return index.deleteArchivedTask(target);},
  },
  taskIndexSyncer:{
   mutateSessionFacts:async(target)=>{
    order.push(`cli:${target.sessionId}`);
    if(target.sessionId==='cli-fails')throw new Error('deleteSession failed');
    // CLI 确认删除后对账会把该行标记 deleted=1，此时 tombstone 会返回 null。
    if(target.sessionId==='cli-confirms')index.store.get(target.sessionId).deleted=true;
   },
  },
  emitWorkspaceTaskListChanged:(params,meta,reason)=>emitted.push([params.taskId??null,reason,meta===undefined]),
  logger:{warn(){},info(){},error(){},debug(){}},
  resolveWorkspaceKey:(target)=>target.workspacePath,
 });

 // 1) 已取消归档：不发写请求，直接跳过。
 assert.equal(await api.deleteArchivedTask({workspacePath:'/ws',taskId:'restored'}),false);
 assert.deepEqual(order.filter((step)=>step.includes('restored')),['flags:restored']);
 assert.equal(index.store.get('restored').deleted,false);

 // 2) CLI 失败：repo 未被写成 deleted=1，失败项刷新后仍在归档列表。
 await assert.rejects(api.deleteArchivedTask({workspacePath:'/ws',taskId:'cli-fails'}),/deleteSession failed/);
 assert.deepEqual(order.filter((step)=>step.includes('cli-fails')),['flags:cli-fails','cli:cli-fails']);
 assert.equal(index.store.get('cli-fails').deleted,false,'failed task must not be tombstoned');

 // 3) CLI 成功：顺序为 flags -> cli -> tombstone，并广播 task_deleted。
 assert.equal(await api.deleteArchivedTask({workspacePath:'/ws',taskId:'kept'}),true);
 assert.deepEqual(order.filter((step)=>step.includes('kept')),['flags:kept','cli:kept','tombstone:kept']);
 assert.equal(index.store.get('kept').deleted,true);
 assert.deepEqual(emitted.at(-1),['kept','task_deleted',false]);

 // 4) CLI 对账已置 deleted=1 时 tombstone 返回 null，仍视为删除成功且不复活。
 assert.equal(await api.deleteArchivedTask({workspacePath:'/ws',taskId:'cli-confirms'}),true);
 assert.equal(index.store.get('cli-confirms').deleted,true);
 assert.deepEqual(emitted.at(-1),['cli-confirms','task_deleted',true]);
});

test('batch archived deletion reports deleted, skipped and failed per task',async t=>{
 const dir=await scratch(t,'zcode-adapter-batch-');
 const {api,__setup}=await compileArchivedDeletionAdapter(dir);
 const index=taskIndexDouble([{taskId:'a'},{taskId:'b'},{taskId:'c'}]);
 index.store.get('c').archived=false;
 const emitted=[];
 __setup({
  taskIndexRepo:{
   getTaskIndexFlags:(target)=>index.getTaskIndexFlags(target),
   deleteArchivedTask:(target)=>index.deleteArchivedTask(target),
  },
  taskIndexSyncer:{mutateSessionFacts:async(target)=>{if(target.sessionId==='b')throw new Error('nope');}},
  emitWorkspaceTaskListChanged:(params,meta,reason)=>emitted.push([params.taskId??null,reason]),
  logger:{warn(){},info(){},error(){},debug(){}},
  resolveWorkspaceKey:(target)=>target.workspacePath,
 });
 const result=await api.deleteArchivedTasks({workspacePath:'/ws',taskIds:['a','b','c','a']});
 assert.deepEqual(result,{deletedTaskIds:['a'],skippedTaskIds:['c'],failedTaskIds:['b']});
 assert.equal(index.store.get('a').deleted,true);
 assert.equal(index.store.get('b').deleted,false,'failed batch member keeps its archived row');
 assert.equal(index.store.get('c').deleted,false);
 // 批次只在有成功项时广播一次，避免逐项驱动全量重读。
 assert.deepEqual(emitted,[[null,'task_deleted']]);
});

// ---------------------------------------------------------------------------
// Area B: standalone cloud project creation and non-project work mode
// ---------------------------------------------------------------------------

/** Compile packages/services/src/project-storage/remote-policy.ts. */
async function compileRemotePolicy(dir){
 return import(await emit(dir,'remote-policy',await read('packages/services/src/project-storage/remote-policy.ts')));
}

test('remote task directory policy only relaxes for the explicit standalone policy',async t=>{
 const dir=await scratch(t,'zcode-policy-');
 const {assertRemoteProjectRoots,assertRemoteTaskDirectories}=await compileRemotePolicy(dir);
 const root='/workspace';
 const conversations=`${root}/.zcode/conversations/draft-${randomUUID()}`;
 const standalone={allowStandaloneNonProject:true,standaloneWorkspaceRoot:root};

 // 本地 owner 不受任何远端约束。
 assert.doesNotThrow(()=>assertRemoteTaskDirectories('local',null,'/tmp/anything',[]));
 // 远端 owner 默认仍拒绝无项目会话。
 assert.throws(()=>assertRemoteTaskDirectories('server:oci',null,conversations,[],undefined),
  /project\.remote-project-required/);
 assert.throws(()=>assertRemoteTaskDirectories('server:oci',null,conversations,[],{}),
  /project\.remote-project-required/);
 // 显式开启且目录唯一、非空、位于工作区根内时放行。
 assert.doesNotThrow(()=>assertRemoteTaskDirectories('server:oci',null,conversations,[],standalone));
 // 附加目录、空路径、越出工作区根仍然拒绝。
 assert.throws(()=>assertRemoteTaskDirectories('server:oci',null,conversations,['/tmp/x'],standalone),
  /project\.remote-single-root-required/);
 assert.throws(()=>assertRemoteTaskDirectories('server:oci',null,'   ',[],standalone),
  /project\.remote-project-required/);
 assert.throws(()=>assertRemoteTaskDirectories('server:oci',null,'/etc',[],standalone),
  /project\.remote-project-required/);
 assert.throws(()=>assertRemoteTaskDirectories('server:oci',null,'/workspace-other/x',[],standalone),
  /project\.remote-project-required/);

 // 有项目时维持唯一 root 与 cwd 归属约束。
 const project={id:'p',hostId:'server:oci',name:'p',nameOverridden:false,position:0,pinned:false,
  deleted:false,createdAt:0,updatedAt:0,roots:[{rootPath:root,position:0,isPrimary:true}]};
 assert.doesNotThrow(()=>assertRemoteTaskDirectories('server:oci',project,root,[],standalone));
 assert.throws(()=>assertRemoteTaskDirectories('server:oci',project,'/other',[],standalone),
  /project\.cwd-not-in-roots/);
 const twoRoots={...project,roots:[...project.roots,{rootPath:'/extra',position:1,isPrimary:false}]};
 assert.throws(()=>assertRemoteTaskDirectories('server:oci',twoRoots,root,[],standalone),
  /project\.remote-single-root-required/);

 // root 数量与固定性。
 assert.throws(()=>assertRemoteProjectRoots('server:oci',[]),/project\.remote-single-root-required/);
 assert.throws(()=>assertRemoteProjectRoots('server:oci',['/a','/b']),/project\.remote-single-root-required/);
 assert.throws(()=>assertRemoteProjectRoots('server:oci',['/b'],project),/project\.remote-root-immutable/);
 assert.doesNotThrow(()=>assertRemoteProjectRoots('server:oci',[root],project));
 assert.doesNotThrow(()=>assertRemoteProjectRoots('local',[],project));
});

/** Write an already type-stripped module and return its file URL. */
async function emitStripped(dir,name,stripped){
 const file=join(dir,`${name}.js`);
 await writeFile(file,stripped);
 return pathToFileURL(file).href;
}

/** Compile packages/services/src/project/index.ts against stubs. */
async function compileProjectService(dir,policyHref){
 await writeFile(join(dir,'zod-stub.js'),ZOD_STUB);
 let source=await read('packages/services/src/project/index.ts');
 // 值重导出指向其它模块，编译时必须移除；类型 import/重导出由 stripper 擦除。
 source=source
  .replace(/^export \{[\s\S]*?\} from "#src\/[^"]+";\s*$/gm,'')
  .replace(/^export type \{[\s\S]*?\} from "#src\/[^"]+";\s*$/gm,'')
  .replace('"zod"','"./zod-stub.js"');
 const stripped=stripTypeScriptTypes(source,{mode:'transform'});
 assert.ok(!stripped.includes('#src/'),'no internal #src imports may remain after stripping');
 return import(await emitStripped(dir,'project-service',stripped));
}

/** Fake repository that applies the real remote policy guards. */
function fakeRepository({ownerHostId,policy,seed=[]}){
 const projects=new Map(seed.map((project)=>[project.id,project]));
 const policyHref=policy;
 return {
  projects,
  readTree:({includeTasks}={})=>({projects:[...projects.values()],tasks:[],...(includeTasks?{}:{})}),
  saveProject(input){
   const old=input.id?projects.get(input.id):undefined;
   const roots=[...new Set(input.roots??old?.roots.map((root)=>root.rootPath)??[])];
   policyHref.assertRemoteProjectRoots(ownerHostId,roots,old);
   const id=old?.id??input.id??randomUUID();
   const primary=input.primaryRoot??old?.roots.find((root)=>root.isPrimary)?.rootPath??roots[0];
   const project={id,hostId:ownerHostId,name:input.name??input.defaultName??'New project',
    nameOverridden:false,position:projects.size,pinned:false,deleted:false,createdAt:0,updatedAt:0,
    roots:roots.map((rootPath,position)=>({rootPath,position,isPrimary:rootPath===primary}))};
   projects.set(id,project);
   return project;
  },
  initializeProjectRoot(id,path){
   const project=projects.get(id);
   const next={...project,roots:[{rootPath:path,position:0,isPrimary:true}]};
   projects.set(id,next);
   return next;
  },
  deleteProject(id){projects.delete(id);},
  moveTask(){throw new Error('project.moveTask-unused');},
  reorderProjects(){},
  archiveInactive:()=>[],
  resolveSessionDirectories:(task)=>({workspacePath:task.workspacePath,additionalDirectories:[],projectId:null}),
  reserveCreatedTask:(input)=>({
   workspacePath:input.task.workspacePath,
   additionalDirectories:input.additionalDirectories??[],
   projectId:input.projectId??null,
  }),
 };
}

test('standalone cloud prepareSession allocates a stable non-project conversation directory',async t=>{
 const dir=await scratch(t,'zcode-prev-');
 const root=join(dir,'workspace');
 await mkdir(root,{recursive:true});
 const policy=await compileRemotePolicy(dir);
 const {createProjectService}=await compileProjectService(dir,policy);
 const {assertRemoteTaskDirectories}=policy;
 const repository=fakeRepository({ownerHostId:'server:oci',policy});
 // 仓储同样走真实策略：无项目 + 空附加目录 + 工作区根内才放行。
 const guardedRepository={
  ...repository,
  reserveCreatedTask(input){
   assertRemoteTaskDirectories('server:oci',null,input.task.workspacePath,input.additionalDirectories??[],
    {allowStandaloneNonProject:true,standaloneWorkspaceRoot:root});
   return repository.reserveCreatedTask(input);
  },
 };
 const service=createProjectService({
  repository:async()=>guardedRepository,
  workspaceDirectory:join(dir,'local-workspace'),
  ownerHostId:'server:oci',
  allowStandaloneCloudWorkspaces:true,
  standaloneWorkspaceRoot:root,
 });
 const draftId=randomUUID();
 const first=await service.prepareSession({draftId});
 assert.equal(first.projectId,null);
 assert.equal(first.workspacePath,join(root,'.zcode','conversations',`draft-${draftId}`));
 assert.equal(first.additionalDirectories.length,0);
 // 相同 draftId 幂等复用同一目录，重试与重连不会另建空目录。
 const second=await service.prepareSession({draftId,reuseDraft:true});
 assert.equal(second.workspacePath,first.workspacePath);
 // 无 draftId 的调用（自动化/Bots）仍独立分配，不能复用最近目录。
 const automated=await service.prepareSession();
 assert.notEqual(automated.workspacePath,first.workspacePath);
 assert.equal(automated.workspacePath.startsWith(join(root,'.zcode','conversations')),true);
 // 预留创建允许 projectId:null 且 additionalDirectories:[]。
 assert.deepEqual(
  await guardedRepository.reserveCreatedTask({task:{workspacePath:first.workspacePath,taskId:'t1'},projectId:null,additionalDirectories:[]}),
  {workspacePath:first.workspacePath,additionalDirectories:[],projectId:null});
});

test('standalone cloud prepareSession still rejects non-project sessions without the policy',async t=>{
 const dir=await scratch(t,'zcode-prev-off-');
 const root=join(dir,'workspace');
 await mkdir(root,{recursive:true});
 const policy=await compileRemotePolicy(dir);
 const {createProjectService}=await compileProjectService(dir,policy);
 const service=createProjectService({
  repository:async()=>fakeRepository({ownerHostId:'server:oci',policy}),
  workspaceDirectory:join(dir,'local-workspace'),
  ownerHostId:'server:oci',
 });
 await assert.rejects(service.prepareSession({draftId:randomUUID()}),/project\.remote-project-required/);
 await assert.rejects(service.prepareSession(),/project\.remote-project-required/);
 // 跨 Host 请求在路由层即被拒绝，不会落到本机 owner。
 await assert.rejects(service.prepareSession({projectId:'p',hostId:'server:other'}),/project\.host-offline/);
});

test('standalone cloud project creation allocates, fixes and validates roots',async t=>{
 const dir=await scratch(t,'zcode-proj-');
 const root=join(dir,'workspace');
 const chosen=join(dir,'chosen');
 await mkdir(root,{recursive:true});
 await mkdir(chosen,{recursive:true});
 const policy=await compileRemotePolicy(dir);
 const {createProjectService}=await compileProjectService(dir,policy);
 const repository=fakeRepository({ownerHostId:'server:oci',policy});
 const service=createProjectService({
  repository:async()=>repository,
  workspaceDirectory:join(dir,'local-workspace'),
  ownerHostId:'server:oci',
  allowStandaloneCloudWorkspaces:true,
  standaloneWorkspaceRoot:root,
 });

 // 只填名称（0 目录）：自动在工作区根下分配专用目录并固定为唯一 root。
 const created=await service.saveProject({name:'Demo Project'});
 assert.equal(created.roots.length,1);
 assert.equal(created.roots[0].rootPath.startsWith(join(root,'projects','demo-project-')),true);
 const {stat}=await import('node:fs/promises');
 assert.equal((await stat(created.roots[0].rootPath)).isDirectory(),true);
 // 相同项目 ID 重试幂等复用同一 root（不重新分配，也不触发 remote-root-immutable）。
 const retried=await service.saveProject({id:created.id,name:'Demo Project',roots:[]});
 assert.equal(retried.id,created.id);
 assert.equal(retried.roots[0].rootPath,created.roots[0].rootPath);

 // 1 个目录正常保存。
 const one=await service.saveProject({name:'One',roots:[chosen]});
 assert.deepEqual(one.roots.map((entry)=>entry.rootPath),[chosen]);
 // >1 个目录由后端策略拒绝。
 await assert.rejects(service.saveProject({name:'Many',roots:[chosen,root]}),
  /project\.remote-single-root-required/);
 // 修改已有项目的 root 被拒绝。
 await assert.rejects(service.saveProject({id:one.id,roots:[root]}),
  /project\.remote-root-immutable/);
});

test('standalone cloud project creation stays strict without the policy',async t=>{
 const dir=await scratch(t,'zcode-proj-off-');
 const root=join(dir,'workspace');
 const chosen=join(dir,'chosen');
 await mkdir(root,{recursive:true});
 await mkdir(chosen,{recursive:true});
 const policy=await compileRemotePolicy(dir);
 const {createProjectService}=await compileProjectService(dir,policy);
 const service=createProjectService({
  repository:async()=>fakeRepository({ownerHostId:'server:oci',policy}),
  workspaceDirectory:join(dir,'local-workspace'),
  ownerHostId:'server:oci',
 });
 // 0 目录新建仍被拒绝（不会自动分配目录）。
 await assert.rejects(service.saveProject({name:'Empty'}),/project\.remote-single-root-required/);
 // 多目录同样拒绝。
 await assert.rejects(service.saveProject({name:'Many',roots:[chosen,root]}),
  /project\.remote-single-root-required/);
 // 1 个目录仍可创建。
 const ok=await service.saveProject({name:'One',roots:[chosen]});
 assert.deepEqual(ok.roots.map((entry)=>entry.rootPath),[chosen]);
});

/** Compile project-repository.ts with stubs, binding the real remote policy. */
async function compileProjectRepository(dir,policyHref){
 await writeFile(join(dir,'zod-stub.js'),ZOD_STUB);
 await writeFile(join(dir,'shared-stub.js'),`
export const ZCODE_AGENT_PROVIDER='zcode';
export const generateTraceId=(id)=>'trace-'+id;
export const isRemoteWorkspaceIdentity=()=>false;
export const resolveWorkspaceKey=(target)=>target.workspaceIdentity?.trim()||target.workspacePath;
`);
 await writeFile(join(dir,'legacy-stub.js'),`
export const OWNERSHIP_DECIDED=8;
export function ensureHost(db,workspaceKey,ownerHostId){
 const hostId=ownerHostId??'local';
 db.prepare('INSERT OR IGNORE INTO hosts(host_id,kind,position) VALUES(?,?,(SELECT count(*) FROM hosts))')
  .run(hostId,hostId==='local'?'local':'server');
 return hostId;
}
`);
 const source=(await read('packages/services/src/project-storage/project-repository.ts'))
  .replace('"zod"','"./zod-stub.js"')
  .replace('"@zcode/shared"','"./shared-stub.js"')
  .replace('"#src/project-storage/legacy-tasks.js"','"./legacy-stub.js"')
  .replace('"#src/project-storage/remote-policy.js"',JSON.stringify(policyHref));
 return import(await emit(dir,'project-repository',source));
}

test('project repository threads the standalone policy into task directory checks',async t=>{
 const dir=await scratch(t,'zcode-repo-');
 const root=join(dir,'workspace');
 await mkdir(root,{recursive:true});
 const policy=await compileRemotePolicy(dir);
 const {ProjectRepository}=await compileProjectRepository(dir,pathToFileURL(join(dir,'remote-policy.js')).href);
 const db=new DatabaseSync(join(dir,'tasks-index.sqlite'));
 t.after(()=>db.close());
 db.exec(`
CREATE TABLE hosts(host_id TEXT PRIMARY KEY,kind TEXT NOT NULL,position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE projects(project_id TEXT PRIMARY KEY,host_id TEXT NOT NULL,name TEXT NOT NULL,name_overridden INTEGER NOT NULL DEFAULT 0,position INTEGER NOT NULL,pinned INTEGER NOT NULL DEFAULT 0,pinned_at INTEGER,deleted INTEGER NOT NULL DEFAULT 0,deleted_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE project_roots(project_id TEXT NOT NULL,root_path TEXT NOT NULL,position INTEGER NOT NULL,is_primary INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project_id,root_path));
CREATE TABLE tasks(workspace_key TEXT NOT NULL,task_id TEXT NOT NULL,workspace_path TEXT,workspace_identity TEXT,host_id TEXT,root_path TEXT,project_id TEXT,execution_directories TEXT,handoff_pending INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0,cli_created_at INTEGER,cli_updated_at INTEGER,cli_deleted INTEGER,cli_last_outcome TEXT,provider TEXT,PRIMARY KEY(workspace_key,task_id));
`);
 const options={allowStandaloneCloudWorkspaces:true,standaloneWorkspaceRoot:root};
 const repository=new ProjectRepository(db,'server:oci',options);
 const conversations=join(root,'.zcode','conversations','draft-'+randomUUID());
 const reserved=repository.reserveCreatedTask({task:{workspacePath:conversations,taskId:'t1'},projectId:null,additionalDirectories:[]});
 assert.equal(reserved.projectId,null);
 assert.deepEqual(reserved.additionalDirectories,[]);
 assert.equal(repository.resolveSessionDirectories({workspacePath:conversations,taskId:'t1'}).projectId,null);
 // 附加目录与越界路径仍然拒绝。
 assert.throws(()=>repository.reserveCreatedTask({task:{workspacePath:join(dir,'elsewhere'),taskId:'t2'},projectId:null,additionalDirectories:[]}),
  /project\.remote-project-required/);
 assert.throws(()=>repository.reserveCreatedTask({task:{workspacePath:conversations,taskId:'t3'},projectId:null,additionalDirectories:['/tmp/x']}),
  /project\.remote-single-root-required/);
 // 未开启策略的同一仓储保持原拒绝语义。
 const strict=new ProjectRepository(db,'server:oci');
 assert.throws(()=>strict.reserveCreatedTask({task:{workspacePath:conversations,taskId:'t4'},projectId:null,additionalDirectories:[]}),
  /project\.remote-project-required/);
});

test('project editor limits standalone cloud projects to a single fixed root',async()=>{
 const source=await read('packages/ui/src/project-sidebar/ProjectEditor.tsx');
 // 能力来自平台能力而不是 hostId 标签，避免把独立云端 Web 当成可多 root 的本地项目。
 assert.match(source,/const nativeDirectoryPicker = Boolean\(platform\?\.selectDirectories\);/);
 assert.match(source,/const isStandaloneWeb = !nativeDirectoryPicker && !remote;/);
 assert.match(source,/const singleRootMode = remote \|\| isStandaloneWeb;/);
 // 选目录在单 root 模式下最多保留 1 个。
 assert.match(source,/const next = singleRootMode\s*\n\s*\? values\.filter\(Boolean\)\.slice\(0, 1\)/);
 // 已有项目在单 root 模式下隐藏移除与添加按钮（root 固定）。
 assert.equal(source.split('!singleRootMode || !project').length-1,2);
 // 独立云端新建项目允许 0 目录并给出说明文案。
 assert.match(source,/isStandaloneWeb && !project && !roots\.length/);
 assert.match(source,/msg\("standaloneAutoRootHint"\)/);
});

test('project error codes are translated instead of leaking raw identifiers',async()=>{
 const source=await read('packages/ui/src/project-sidebar/view.ts');
 for(const [code,key] of [
  ['project.remote-single-root-required','project.remoteSingleRootRequired'],
  ['project.remote-project-required','project.remoteProjectRequired'],
  ['project.remote-root-immutable','project.remoteRootImmutable'],
 ]){
  assert.ok(source.includes(`code === "${code}"`),`${code} must be mapped`);
  assert.ok(source.includes(`id: "${key}"`),`${key} must be used`);
 }
 for(const locale of ['en-US','zh-CN']){
  const messages=await read(`packages/ui/src/i18n/locales/${locale}.ts`);
  for(const key of ['project.remoteSingleRootRequired','project.remoteProjectRequired','project.remoteRootImmutable','project.standaloneAutoRootHint'])
   assert.ok(messages.includes(`"${key}"`),`${locale} must define ${key}`);
 }
});
