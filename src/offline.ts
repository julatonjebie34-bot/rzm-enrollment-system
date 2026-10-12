import {db,tables,Row,finalGrade} from './lib';
import {all,get,put,request,transaction,uuid} from './local-db';
export type Operation={key:string;sequence:number;owner:string;table:string;kind:string;payload:Row;record_id:string;expected:number|null;created_at:string;updated_at:string;sync_status:'pending_sync'|'synced'|'conflict'|'superseded';sync_attempts:number;last_sync_error:string|null;next_retry:number;server?:Row};
export type LocalRecord={key:string;owner:string;table:string;id:string;data:Row;created_at:string;updated_at:string;sync_status:string;sync_attempts:number;last_sync_error:string|null};
export const events=new EventTarget();
export let owner='';
let running=false;
const onlineOnly=new Set(['documents','audit_logs','grade_revisions']);
let transientOwner='';let transient:Record<string,Row[]>={};
export let status={online:typeof navigator!=='undefined'?navigator.onLine:true,syncing:false,pending:0,offline:0,errors:0,lastSync:'',message:'',cloudError:'',conflicts:[] as Operation[]};
const emit=()=>events.dispatchEvent(new Event('change'));
export async function activate(id:string){owner=id;status={...status,message:'',cloudError:'',lastSync:''};if(localStorage.getItem('rzm-trusted-device')==='true')await navigator.storage?.persist?.().catch(()=>false);await updateStatus();}
export function deactivate(){transientOwner='';transient={};owner='';status={...status,pending:0,offline:0,errors:0,message:'',cloudError:'',lastSync:'',conflicts:[]};emit()}
export async function snapshot(){const rows=await all<LocalRecord>('records');return Object.fromEntries(tables.map(t=>[t,onlineOnly.has(t)?(navigator.onLine&&transientOwner===owner?transient[t]||[]:[]):rows.filter(r=>r.owner===owner&&r.table===t).map(r=>r.data)])) as Record<string,Row[]>}
export async function updateStatus(){if(!owner)return;const q=(await all<Operation>('queue')).filter(o=>o.owner===owner&&['pending_sync','conflict'].includes(o.sync_status));status={...status,online:navigator.onLine,pending:q.length,offline:new Set(q.map(o=>o.table+o.record_id)).size,errors:q.filter(o=>o.last_sync_error).length,conflicts:q.filter(o=>o.sync_status==='conflict'),lastSync:(await get('meta',owner+':lastSync'))?.value||status.lastSync};emit()}
export async function save(table:string,input:Row,kind='write',expectedDraftVersion?:number|null){
 if(!owner)throw Error('Sign in before saving records.');
 if(table==='enrollments')throw Error('Section assignments and transfers require online server confirmation.');
 if(table==='grades')throw Error('Use Grade Encoding to save drafts and submit grades for approval.');
 const account=owner;const now=new Date().toISOString();const id=input.id??(table==='school_settings'?1:uuid());
 await transaction(['records','queue','meta'],'readwrite',async t=>{
  const store=t.objectStore('records');const key=`${account}:${table}:${id}`;const current=await request<LocalRecord|undefined>(store.get(key));
  if(kind==='grade_draft'){if(expectedDraftVersion!==undefined&&(current?Number(current.data.sync_version):null)!==expectedDraftVersion)throw Error('This draft changed while you were editing. Keep a copy of your edits, refresh, and review the latest draft before retrying.');if(!current){const records=await request<LocalRecord[]>(store.getAll());if(records.some(r=>r.owner===account&&r.table===table&&r.data.section_id===input.section_id&&r.data.subject_id===input.subject_id&&r.data.period_id===input.period_id))throw Error('A draft for this class and quarter already exists. Refresh before editing.');}}
  const queued=await request<Operation[]>(t.objectStore('queue').getAll());if(queued.some(o=>o.owner===account&&o.table===table&&o.record_id===String(id)&&!['write','grade_draft'].includes(o.kind)&&['pending_sync','conflict'].includes(o.sync_status)))throw Error('An approval or promotion is pending for this record. Sync it before editing.');
  if(current?.sync_status==='conflict'||queued.some(o=>o.owner===account&&o.table===table&&o.record_id===String(id)&&o.sync_status==='conflict'))throw Error('Resolve this record’s sync conflict before editing it.');
  let payload:Row={...input,id};if(!current&&table==='enrollment_links'){payload.token=uuid();payload.archived=false;payload.instructions='';payload.extra_questions=[];}
  const related=queued.filter(o=>o.owner===account&&o.table===table&&o.record_id===String(id)&&o.sync_status==='pending_sync').sort((a,b)=>a.sequence-b.sequence);let expected=current?Number(current.data.sync_version||1):null;
  // Correct failed changes without leaving an invalid insert permanently blocking its edits.
  // New operation UUIDs still use the SAME record ID; uncertain cloud commits become conflicts.
  if(related.some(o=>o.last_sync_error)){expected=related[0].expected;payload=Object.assign({},...related.map(o=>o.payload),payload);for(const old of related){old.sync_status='superseded';await request(t.objectStore('queue').put(old));}}
  const data:Row={...(current?.data||{}),...payload};
  data.sync_version=expected===null?1:expected+1;
  if(table==='grades')data.final_grade=finalGrade(['q1','q2','q3','q4'].map(k=>data[k]??null));
  const sequence=Number((await request(t.objectStore('meta').get('sequence')))?.value||0)+1;await request(t.objectStore('meta').put({key:'sequence',value:sequence}));
  const op:Operation={key:uuid(),sequence,owner:account,table,kind,payload,record_id:String(id),expected,created_at:now,updated_at:now,sync_status:'pending_sync',sync_attempts:0,last_sync_error:null,next_retry:0};
  await request(store.put({key,owner:account,table,id:String(id),data,created_at:current?.created_at||now,updated_at:now,sync_status:'pending_sync',sync_attempts:0,last_sync_error:null}));await request(t.objectStore('queue').put(op));
 });
 await updateStatus();kick();
}
export async function command(kind:'approve'|'promote',payload:Row){
 if(!owner||!db||!navigator.onLine)throw Error('Approvals and promotions require an online server check.');
 if(status.pending)throw Error('Synchronize pending changes first.');
 const table=kind==='approve'?'applications':'enrollments';const id=String(payload.application||payload.enrollment);
 const row=await get<LocalRecord>('records',owner+':'+table+':'+id);
 if(!row)throw Error('Refresh records before continuing.');
 const {data,error}=await db.rpc('sync_management_change',{operation:uuid(),target_table:table,kind,payload,expected_version:row.data.sync_version});
 if(error)throw Error(error.message);if(data?.status==='conflict')throw Error('This record changed. Refresh and review it again.');await pull();
}
export async function saveGradeDraft(assignment:Row,period:Row,entries:Row,current?:Row){
 if(current&&!['Draft','Returned'].includes(current.status))throw Error('Submitted grades are locked.');
 const account=owner,id=current?.id??uuid();
 await save('grade_submissions',{id,assignment_id:assignment.id,section_id:assignment.section_id,subject_id:assignment.subject_id,teacher_id:assignment.teacher_id,period_id:period.id,entries,status:current?.status||'Draft',roster:current?.roster||[],remarks:current?.remarks||''},'grade_draft',current?.sync_version??null);
 const saved=await get<LocalRecord>('records',account+':grade_submissions:'+id);
 if(owner!==account||!saved)throw Error('Account access changed while saving. Sign in again to verify your saved draft.');
 return saved.data;
}
/** Read cloud snapshots into IndexedDB; never overwrite a pending local record. */
export async function pull(){if(!db||!owner||!navigator.onLine)return;const account=owner;const access=await db.from('profiles').select('*').eq('id',account).single();if(access.error)throw Error(access.error.message);const permitted=access.data.active&&!access.data.must_change_password;const teacher=access.data.role==='teacher';const next:Record<string,Row[]>={};for(const table of tables){const rows:Row[]=[];if(!permitted){next[table]=table==='profiles'?[access.data]:[];continue;}if(teacher&&table==='profiles'){const r=await db.rpc('teacher_directory');if(r.error)throw Error(r.error.message);next[table]=r.data.map((p:Row)=>p.id===account?access.data:p);continue;}if(teacher&&table==='students'){for(let offset=0;;offset+=1000){const r=await db.rpc('teacher_students').order('id').range(offset,offset+999);if(r.error)throw Error(r.error.message);rows.push(...r.data);if(r.data.length<1000)break;}next[table]=rows;continue;}for(let start=0;;start+=1000){const r=await db.from(table).select('*').order('id').range(start,start+999);if(r.error)throw Error(r.error.message);rows.push(...r.data);if(r.data.length<1000)break;}next[table]=rows;}
 if(account!==owner)return;
 await transaction(['records','queue','meta'],'readwrite',async t=>{const pending=(await request<Operation[]>(t.objectStore('queue').getAll())).filter(o=>o.owner===account&&['pending_sync','conflict'].includes(o.sync_status));const records=await request<LocalRecord[]>(t.objectStore('records').getAll());const protectedKey=(key:string)=>permitted&&pending.some(o=>`${account}:${o.table}:${o.record_id}`===key&&o.table!=='profiles'&&(!teacher||(o.kind==='grade_draft'&&next.assignments?.some(a=>a.id===o.payload.assignment_id&&a.teacher_id===account&&a.active))));for(const r of records){if(r.owner===account&&!protectedKey(r.key))await request(t.objectStore('records').delete(r.key));}for(const table of tables)if(!onlineOnly.has(table))for(const data of next[table]){const key=`${account}:${table}:${data.id}`;if(!protectedKey(key))await request(t.objectStore('records').put({key,owner:account,table,id:String(data.id),data,created_at:data.created_at||new Date().toISOString(),updated_at:data.updated_at||new Date().toISOString(),sync_status:'synced',sync_attempts:0,last_sync_error:null}))}});if(owner===account){transientOwner=account;transient=Object.fromEntries([...onlineOnly].map(t=>[t,next[t]||[]]));}emit();
}
export const retryDelay=(attempt:number)=>Math.min(300000,2000*2**Math.min(attempt-1,8));
async function syncLoop(force:boolean){if(!db||!owner||!navigator.onLine||running)return;running=true;const account=owner;status.syncing=true;emit();let count=0;try{
 const auth=await db.auth.getSession();if(owner!==account)return;if(auth.error||auth.data.session?.user.id!==account) {status.message='Sign in online with this account to synchronize its saved changes.';return;}
 const q=(await all<Operation>('queue')).filter(o=>o.owner===account&&['pending_sync','conflict'].includes(o.sync_status));status.message=`Syncing ${q.length} pending changes…`;emit();
 // Transactional sequence preserves dependency order, including same-millisecond saves.
 q.sort((a,b)=>a.sequence-b.sequence);
 const blocked=new Set<string>();
 for(const queued of q){const op=await get<Operation>('queue',queued.key);if(!op||!['pending_sync','conflict'].includes(op.sync_status))continue;if(owner!==account||!navigator.onLine)break;const rk=op.table+op.record_id;if(op.sync_status==='conflict'||blocked.has(rk)||(!force&&op.next_retry>Date.now())){blocked.add(rk);continue;}
  try{const session=await db.auth.getSession();if(owner!==account||session.data.session?.user.id!==account)break;op.sync_attempts++;op.updated_at=new Date().toISOString();await put('queue',op);if(['approve','promote'].includes(op.kind))throw Error('Legacy queued approval: cancel this operation and approve again online.');const {data:s,error}=op.kind==='grade_draft'?await db.rpc('grade_workflow',{operation:op.key,action:'save',assignment:op.payload.assignment_id,period:op.payload.period_id,expected_version:op.expected,entries:op.payload.entries,remarks:''}):await db.rpc('sync_management_change',{operation:op.key,target_table:op.table,kind:op.kind,payload:op.payload,expected_version:op.expected});if(error)throw Error(error.message);if(!s)throw Error('No synchronization receipt returned');if(s.status==='conflict'){op.sync_status='conflict';op.server=s.record;throw Error('Cloud record changed. Choose which version to keep.');}
   await transaction(['queue','records'],'readwrite',async t=>{op.sync_status='synced';op.updated_at=new Date().toISOString();op.last_sync_error=null;await request(t.objectStore('queue').put(op));const later=(await request<Operation[]>(t.objectStore('queue').getAll())).some(o=>o.owner===account&&o.table===op.table&&o.record_id===op.record_id&&['pending_sync','conflict'].includes(o.sync_status));const key=`${account}:${op.table}:${op.record_id}`;const row=await request<LocalRecord>(t.objectStore('records').get(key));if(row){row.sync_status=later?'pending_sync':'synced';row.last_sync_error=null;row.sync_attempts=op.sync_attempts;if(!later&&s.record)row.data=s.record;await request(t.objectStore('records').put(row));}});count++;
  }catch(e){const persisted=await get<Operation>('queue',op.key);if(persisted?.sync_status==='superseded')continue;op.last_sync_error=e instanceof Error?e.message:String(e);op.next_retry=Date.now()+retryDelay(op.sync_attempts);op.updated_at=new Date().toISOString();await transaction(['queue','records','logs'],'readwrite',async t=>{await request(t.objectStore('queue').put(op));const key=`${account}:${op.table}:${op.record_id}`;const row=await request<LocalRecord>(t.objectStore('records').get(key));if(row){row.sync_status=op.sync_status;row.sync_attempts=op.sync_attempts;row.last_sync_error=op.last_sync_error;await request(t.objectStore('records').put(row));}await request(t.objectStore('logs').put({key:uuid(),owner:account,operation:op.key,at:op.updated_at,error:op.last_sync_error}))});blocked.add(rk);}
 }
 status.cloudError='';
 await put('meta',{key:account+':lastSync',value:new Date().toISOString()});status.message=count?`${count} changes synchronized successfully.`:'School records are up to date.';
 if(owner===account)try{await pull()}catch(e){status.cloudError=e instanceof Error?e.message:String(e);status.message='Cloud unavailable. Your locally saved records remain available.';}
 }finally{running=false;status.syncing=false;await updateStatus();}}
export async function sync(force=false){if(navigator.locks){await navigator.locks.request('rzm-sync',{ifAvailable:true},async lock=>{if(lock)await syncLoop(force)})}else await syncLoop(force)}
export async function discardPending(operation:Operation){
 if(operation.owner!==owner||running)throw Error('Wait for synchronization to finish.');
 if(!navigator.onLine)throw Error('Reconnect to restore the current cloud record.');
 const account=owner;
 await transaction(['queue','records'],'readwrite',async t=>{
  const queue=await request<Operation[]>(t.objectStore('queue').getAll());
  for(const item of queue)if(item.owner===account&&item.table===operation.table&&item.record_id===operation.record_id&&['pending_sync','conflict'].includes(item.sync_status)){item.sync_status='superseded';await request(t.objectStore('queue').put(item));}
  await request(t.objectStore('records').delete(`${account}:${operation.table}:${operation.record_id}`));
 });await updateStatus();await pull();
}
export async function resolveConflict(op:Operation,keepLocal:boolean){
 if(op.owner!==owner)return;if(running)throw Error('Wait for synchronization to finish before resolving a conflict.');const account=owner;
 await transaction(['queue','records','meta'],'readwrite',async t=>{const q=(await request<Operation[]>(t.objectStore('queue').getAll())).filter(o=>o.owner===account&&o.table===op.table&&o.record_id===op.record_id&&['pending_sync','conflict'].includes(o.sync_status)).sort((a,b)=>a.sequence-b.sequence);const row=await request<LocalRecord>(t.objectStore('records').get(`${account}:${op.table}:${op.record_id}`))||{key:`${account}:${op.table}:${op.record_id}`,owner:account,table:op.table,id:op.record_id,data:op.payload,created_at:op.created_at,updated_at:op.updated_at,sync_status:op.sync_status,sync_attempts:op.sync_attempts,last_sync_error:op.last_sync_error};if(keepLocal&&op.kind==='grade_draft')throw Error('Use the cloud version, then re-enter reviewed grade changes. Grade conflicts cannot overwrite a submitted version.');if(keepLocal&&!op.server)throw Error('Cloud record is missing. Export local data before deciding how to recreate it.');
 for(const change of q){change.sync_status='superseded';await request(t.objectStore('queue').put(change));}
 if(keepLocal){let version=Number(op.server?.sync_version||1);let sequence=Number((await request(t.objectStore('meta').get('sequence')))?.value||0);for(const change of q){const latest:Operation={...change,key:uuid(),sequence:++sequence,expected:version,sync_status:'pending_sync',sync_attempts:0,last_sync_error:null,next_retry:0,created_at:new Date().toISOString()};delete latest.server;await request(t.objectStore('queue').put(latest));if(change.kind!=='promote')version++;}await request(t.objectStore('meta').put({key:'sequence',value:sequence}));row.sync_status='pending_sync';row.data.sync_version=version;}
 else{row.sync_status='synced';if(op.server)row.data=op.server;else await request(t.objectStore('records').delete(row.key));}
 row.last_sync_error=null;if(keepLocal||op.server)await request(t.objectStore('records').put(row));});await updateStatus();emit();kick(true);
}
function kick(force=false){void sync(force).catch(e=>{status.cloudError=e instanceof Error?e.message:String(e);status.message='Synchronization is paused. Locally saved changes are retained.';emit()})}
export function startSync(){const online=()=>kick(true);const changed=()=>{void updateStatus().catch(e=>{status.cloudError=e.message;emit()})};const focus=()=>{if(document.visibilityState==='visible')kick()};window.addEventListener('online',online);window.addEventListener('offline',changed);document.addEventListener('visibilitychange',focus);const interval=setInterval(()=>kick(),30000);kick();return()=>{clearInterval(interval);window.removeEventListener('online',online);window.removeEventListener('offline',changed);document.removeEventListener('visibilitychange',focus)}}
