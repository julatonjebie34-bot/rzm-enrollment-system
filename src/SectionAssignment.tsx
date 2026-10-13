import {LearnerIdentifier} from './LearnerIdentifier';
import {SectionAlerts} from './SmartPlacement';
import React,{useEffect,useRef,useState} from 'react';
import {Row} from './lib';
import {uuid} from './local-db';
import * as offline from './offline';
import {placementPreview,confirmPlacement} from './section-assignment-api';
import {DataTable,AcademicRecords} from './AcademicWorkspace';
import './section-assignment.css';
type Data=Record<string,Row[]>;
const name=(data:Data,table:string,id:any)=>{const r=data[table]?.find(x=>x.id===id);return r?.name||r?.full_name||[r?.first_name,r?.last_name].filter(Boolean).join(' ')||'—'};
const capacity=(s:Row)=>`${s.enrolled} / ${s.capacity??'No limit'}`;
const failure=(e:unknown)=>e instanceof Error?e.message:String(e);

export function AssignmentDialog({data,application,enrollment,close,done}:{data:Data;application?:Row;enrollment?:Row;close:()=>void;done:()=>void}){
 const [preview,setPreview]=useState<Row|null>(null),[method,setMethod]=useState('Automatic'),[autoTeacher,setAutoTeacher]=useState(true),[selected,setSelected]=useState(''),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const retry=useRef<{signature:string;operation:string}|null>(null);
 const transfer=!!enrollment;
 async function load(){const p=await placementPreview(application?.id??null,enrollment?.id??null);setPreview(p);setSelected(transfer||method==='Manual'?'':p.recommended||'');return p;}
 useEffect(()=>{let active=true;setBusy(true);placementPreview(application?.id??null,enrollment?.id??null).then(p=>{if(active){setPreview(p);setSelected(transfer?'':p.recommended||'')}}).catch(e=>{if(active)setError(failure(e))}).finally(()=>{if(active)setBusy(false)});return()=>{active=false}},[application?.id,enrollment?.id]);
 const learner=preview?.application||application||data.students.find(s=>s.id===enrollment?.student_id);
 const options:Row[]=preview?.options||[];
 const destination=options.find(s=>s.id===selected);
 const eligible=options.filter(s=>s.eligible&&s.id!==preview?.current_section);
 async function submit(){
  if(!destination?.eligible||!preview||autoTeacher&&!destination.teacher?.eligible)return;
  if(!window.confirm(`${transfer?'Transfer':'Approve and assign'} ${learner?.first_name} ${learner?.last_name} to ${destination.name}${autoTeacher?` with adviser ${destination.teacher?.name}`:''}?`))return;
  setBusy(true);setError('');
  const body={application:application?.id??null,enrollment:enrollment?.id??null,selected_section:selected,method:transfer?'Manual':method,expected_version:preview.expected_version,reason,use_auto_teacher:autoTeacher,expected_teacher:destination.teacher?.teacher_id??null,expected_assignment:destination.teacher?.assignment_id??null};
  const signature=JSON.stringify(body);if(retry.current?.signature!==signature)retry.current={signature,operation:uuid()};
  try{await confirmPlacement({...body,operation:retry.current!.operation});done();void offline.pull().catch(()=>{});}
  catch(e){setError(failure(e));try{await load()}catch{} }
  finally{setBusy(false)}
 }
 return <div className="modal-backdrop"><section className="modal academic-workspace placement-dialog" role="dialog" aria-modal="true" aria-label={transfer?'Transfer section':'Approve and assign student'}><div className="toolbar"><h2>{transfer?'Transfer section':'Approve & assign student'}</h2><button autoFocus disabled={busy} onClick={close}>Close</button></div>
 <p><strong>{learner?.first_name} {learner?.last_name}</strong> · LRN: {learner?.lrn||'Not assigned'}</p>
 <p>{name(data,'grade_levels',preview?.grade_level_id||application?.grade_level_id||enrollment?.grade_level_id)} · {name(data,'school_years',preview?.school_year_id||enrollment?.school_year_id)}{application&&` · ${application.enrollment_type}`}</p>
 {transfer&&<p>Current section: {name(data,'sections',preview?.current_section||enrollment?.section_id)}</p>}
 {error&&<p className="alert error" role="alert">{error}</p>}{busy&&<p role="status">Checking school records…</p>}
 {!navigator.onLine&&<p className="notice">Reconnect to confirm placement with current server capacity.</p>}
 {!transfer&&<fieldset disabled={busy}><legend>Assignment method</legend>{['Automatic','Manual'].map(value=><label className="inline-check" key={value}><input type="radio" name="assignment-method" checked={method===value} onChange={()=>{setMethod(value);setSelected(value==='Automatic'?preview?.recommended||'':'')}}/>{value}{value==='Automatic'?' (recommended)':''}</label>)}</fieldset>}
 {!transfer&&method==='Automatic'&&<p className="notice">Recommended section: <strong>{options.find(s=>s.id===preview?.recommended)?.name||'None available'}</strong>. Lowest enrollment first; ties use section name, then ID. Current enrollment: {options.find(s=>s.id===preview?.recommended)?.enrolled??'—'} of {options.find(s=>s.id===preview?.recommended)?.capacity??'no configured limit'}.</p>}
 {(transfer||method==='Manual')&&<label>Destination section<select disabled={busy} value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Choose an eligible section…</option>{options.map(s=><option key={s.id} value={s.id} disabled={!s.eligible||s.id===preview?.current_section}>{s.name} · {capacity(s)} · {s.adviser}{!s.active?' · Inactive':!s.eligible?' · Full':''}</option>)}</select></label>}
 {destination&&<><p className="notice"><strong>Placement preview:</strong> {name(data,'grade_levels',preview?.grade_level_id)} → {destination.name} → {autoTeacher?destination.teacher?.name:destination.adviser}</p><label className="inline-check"><input type="checkbox" checked={autoTeacher} disabled={busy} onChange={e=>setAutoTeacher(e.target.checked)}/>Automatically choose an eligible adviser when this section has none</label>{autoTeacher&&<p className="compact-help">{destination.teacher?.reason}{destination.teacher?.needs_assignment&&destination.teacher?.eligible?' The proposed adviser will be assigned when you confirm.':''}</p>}</>}
 <div className="table-wrap"><table><thead><tr><th>Section</th><th>Adviser</th><th>Enrolled / capacity</th><th>Slots</th><th>Status</th></tr></thead><tbody>{options.map(s=><tr key={s.id}><td>{s.name}{s.id===selected?' ✓':''}</td><td>{s.adviser}</td><td>{capacity(s)}</td><td>{s.slots??'No limit'}</td><td>{s.id===preview?.current_section?'Current':!s.active?'Inactive':s.eligible?(s.capacity!=null&&s.enrolled/s.capacity>=0.9?'Almost full':'Available'):'Full'}</td></tr>)}</tbody></table></div>
 {preview&&!options.some(s=>s.active)&&<p className="notice">No section available for this grade level. Please create a section first.</p>}
 {preview&&options.some(s=>s.active)&&!eligible.length&&<p className="notice">{transfer?'No other eligible section is available.':'All sections are currently full. Please adjust section capacity or create another section.'}</p>}
 {destination?.adviser==='No adviser assigned'&&!autoTeacher&&<p className="notice">No adviser assigned. Placement is allowed; assign an adviser under Class Assignments to provide adviser access.</p>}
 {transfer&&<label>Transfer reason (optional)<textarea value={reason} maxLength={2000} onChange={e=>setReason(e.target.value)} disabled={busy}/></label>}
 <div className="toolbar"><button disabled={busy} onClick={()=>{setBusy(true);setError('');void load().catch(e=>setError(failure(e))).finally(()=>setBusy(false))}}>Refresh availability</button><button className="primary" disabled={busy||!navigator.onLine||!destination?.eligible||autoTeacher&&!destination.teacher?.eligible||selected===preview?.current_section} onClick={()=>void submit()}>{transfer?'Confirm transfer':'Approve & Assign Student'}</button></div>
 <p className="compact-help">Confirmation requires internet. Capacity is checked again before anything is saved. Existing academic records are preserved.</p>
 </section></div>;
}

export function StudentTransfer({data,student}:{data:Data;student:string}){
 const [selected,setSelected]=useState<Row|null>(null),[notice,setNotice]=useState('');
 return <><h3>Section assignment</h3>{notice&&<p className="alert success" role="status">{notice}</p>}{data.enrollments.filter(e=>e.student_id===student&&e.active).map(e=><div className="toolbar" key={e.id}><span>{name(data,'school_years',e.school_year_id)} · {name(data,'grade_levels',e.grade_level_id)} · {name(data,'sections',e.section_id)}</span><button disabled={data.school_years.find(y=>y.id===e.school_year_id)?.archived} onClick={()=>setSelected(e)}>Transfer Section</button></div>)}{selected&&<AssignmentDialog data={data} enrollment={selected} close={()=>setSelected(null)} done={()=>{setSelected(null);setNotice('Section transfer confirmed. Refreshing class rosters…')}}/>}</>;
}

export function SectionBoard({data,teacher,onEdit,onAdviser}:{data:Data;teacher?:Row;onEdit?:(s:Row)=>void;onAdviser?:(s:Row)=>void}){
 const [year,setYear]=useState(data.school_years.find(y=>y.active)?.id||''),[grade,setGrade]=useState(''),[section,setSection]=useState(''),[student,setStudent]=useState(''),[transfer,setTransfer]=useState<Row|null>(null),[notice,setNotice]=useState('');
 const sections=data.sections.filter(s=>(!year||s.school_year_id===year)&&(!grade||s.grade_level_id===grade)&&(!teacher||data.teacher_class_assignments.some(a=>a.active&&a.teacher_id===teacher.id&&a.section_id===s.id)));
 const selected=sections.find(s=>s.id===section);
 const roster=selected?data.enrollments.filter(e=>e.active&&e.section_id===selected.id):[];
 const learner=roster.some(e=>e.student_id===student)?data.students.find(s=>s.id===student):null;
 const rows:Row[]=sections.map(s=>{const enrolled=data.enrollments.filter(e=>e.active&&e.section_id===s.id).length;return {...s,grade:name(data,'grade_levels',s.grade_level_id),adviser:teacher?.full_name||name(data,'profiles',data.teacher_class_assignments.find(a=>a.section_id===s.id&&a.active)?.teacher_id).replace(/^—$/,'No adviser assigned'),enrolled,capacity:s.capacity??'No limit',slots:s.capacity==null?'No limit':Math.max(0,s.capacity-enrolled),status:!s.active?'Inactive':s.capacity!=null&&enrolled>=s.capacity?'Full':s.capacity!=null&&enrolled/s.capacity>=0.9?'Almost full':'Available'}});
 return <>{!teacher&&<SectionAlerts data={data}/>} {notice&&<p className="alert success" role="status">{notice}</p>}<div className="filters"><label>School year<select value={year} onChange={e=>{setYear(e.target.value);setSection('');setStudent('')}}><option value="">All years</option>{data.school_years.map(y=><option key={y.id} value={y.id}>{y.name}</option>)}</select></label><label>Grade level<select value={grade} onChange={e=>{setGrade(e.target.value);setSection('');setStudent('')}}><option value="">All grades</option>{data.grade_levels.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label></div>
 <DataTable caption={teacher?'My Section':'Section dashboard'} rows={rows} columns={['grade','name','adviser','enrolled','capacity','slots','status']} actions={r=><><button onClick={()=>{setSection(r.id);setStudent('')}}>View students</button>{onEdit&&<button onClick={()=>onEdit(data.sections.find(s=>s.id===r.id)!)}>Edit section</button>}{onAdviser&&<button onClick={()=>onAdviser(r)}>Assign / change adviser</button>}</>}/>
 {selected&&<section className="panel section-heading"><div className="toolbar"><h3>{selected.name} · {name(data,'grade_levels',selected.grade_level_id)} · {name(data,'school_years',selected.school_year_id)}</h3><button onClick={()=>setSection('')}>Close roster</button></div><p>Adviser: {rows.find(s=>s.id===selected.id)?.adviser} · Enrolled: {roster.length} / {selected.capacity??'No limit'}</p><p>{['Male','Female'].map(sex=>`${sex}: ${roster.filter(e=>data.students.find(s=>s.id===e.student_id)?.sex===sex).length}`).join(' · ')}</p>
 <DataTable caption="Section students" rows={roster.map(e=>({...e,name:name(data,'students',e.student_id),lrn:data.students.find(s=>s.id===e.student_id)?.lrn||'Not assigned',application_learner_id:data.students.find(s=>s.id===e.student_id)?.learner_identifier,grade:name(data,'grade_levels',e.grade_level_id),section:selected.name,status:'Enrolled'}))} columns={['name','lrn','application_learner_id','grade','section','status']} actions={r=><><button onClick={()=>setStudent(r.student_id)}>View Student Profile</button><button onClick={()=>setStudent(r.student_id)}>View Academic Records</button>{!teacher&&<button onClick={()=>setTransfer(data.enrollments.find(e=>e.id===r.id)!)}>Transfer Section</button>}</>}/>
 {!teacher&&<DataTable caption="Section assignment history" rows={data.enrollment_history.filter(h=>h.from_section_id===selected.id||h.to_section_id===selected.id).map(h=>({...h,student:name(data,'students',data.enrollments.find(e=>e.id===h.enrollment_id)?.student_id),from:name(data,'sections',h.from_section_id),to:name(data,'sections',h.to_section_id)}))} columns={['student','from','to','reason','created_at']}/>}
 {learner&&<section><div className="toolbar"><h3>{learner.first_name} {learner.last_name}</h3><button onClick={()=>setStudent('')}>Close profile</button></div><LearnerIdentifier learner={learner}/><p>Guardian: {learner.guardian_name||'Contact school office'} · {learner.guardian_contact||'—'}</p><AcademicRecords data={data} student={learner.id}/></section>}</section>}
 {transfer&&<AssignmentDialog data={data} enrollment={transfer} close={()=>setTransfer(null)} done={()=>{setTransfer(null);setNotice('Transfer confirmed. Refreshing section counts and teacher access…')}}/>}</>;
}
