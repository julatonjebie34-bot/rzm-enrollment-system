import React from 'react';
import {Row} from './lib';
import {FieldHelp} from './EnrollmentGuide';
import {Language,Topic,translations} from './enrollment-i18n';
import {adults,addressExample} from '../supabase/functions/_shared/enrollment-details';

export function EnrollmentDetails({form,step,info,language,onChange,help}:{form:Row;step:number;info:Row;language:Language;onChange:(key:string,value:any)=>void;help:(topic:Topic)=>void}){
 const t=translations[language];const grades:Row[]=info.allGrades||info.grades;
 function field(key:string,required=false,topic:Topic='learner'){
  const address=key==='address'||key.endsWith('_address');
  const telephone=key==='contact'||key.endsWith('_contact');
  const props={id:'enroll-'+key,name:key,required,value:form[key]??'',onChange:(event:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>)=>onChange(key,event.target.value)};
  return <div className={'enrollment-field'+(address?' full-width':'')} key={key}><div className="field-caption"><label htmlFor={props.id}>{(t as any)[key]} <small>{required?t.required:t.optional}</small></label><FieldHelp language={language} topic={topic} open={help}/></div>
   {key==='last_grade_level_id'?<select {...props}><option value="">{t.notApplicable}</option>{grades.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select>
    :address?<textarea {...props} rows={2} maxLength={1000} placeholder={addressExample} readOnly={adults.some(p=>key===p+'_address'&&form[p+'_same_address'])}/>
    :<input {...props} type={telephone?'tel':key==='student_email'?'email':'text'} inputMode={telephone?'tel':key==='student_email'?'email':undefined} autoComplete={key==='address'?'street-address':telephone?'tel':key==='student_email'?'email':'off'} maxLength={key==='student_email'?254:telephone?40:300} placeholder={key==='student_email'?'example@email.com':telephone?'0917 123 4567':undefined}/>}
  </div>;
 }
 if(step===1)return <div className="form-grid">{field('address',true,'address')}{field('contact',true,'address')}{field('student_email',false,'address')}</div>;
 if(step===2)return <div className="family-sections"><p className="family-policy">{t.familyPolicy}</p>{adults.map(person=><fieldset className="family-section" key={person}><legend>{t[(person+'Title') as 'motherTitle']}</legend><label className="inline-choice"><input id={'enroll-'+person+'_available'} type="checkbox" checked={!!form[person+'_available']} onChange={e=>onChange(person+'_available',e.target.checked)}/>{(t as any)[person+'_available']}</label>{form[person+'_available']?<><div className="form-grid">{field(person+'_name',true,'guardian')}{field(person+'_contact',true,'guardian')}{field(person+'_address',false,'guardian')}</div><label className="inline-choice same-address"><input type="checkbox" checked={!!form[person+'_same_address']} onChange={e=>onChange(person+'_same_address',e.target.checked)}/>{t.sameAddress}</label></>:<small>{t.notProvided}</small>}</fieldset>)}</div>;
 if(step===3)return <><fieldset className="previous-choice"><legend>{t.previously_attended}</legend><div className="returning-options">{[[true,t.yes],[false,t.previousNo]].map(([value,text])=><label key={String(value)}><input id={value?'enroll-previously_attended':undefined} type="radio" name="previously-attended" checked={form.previously_attended===value} onChange={()=>onChange('previously_attended',value)}/>{String(text)}</label>)}</div></fieldset>{form.previously_attended===true?<div className="form-grid">{field('previous_school',true,'previous')}{field('last_grade_level_id',false,'previous')}{field('previous_school_address',true,'previous')}</div>:form.previously_attended===false?<p className="lrn-notice">{t.noPrevious}</p>:null}{info.extra_questions?.length>0&&<div className="form-grid extra-questions">{info.extra_questions.map((question:string)=><label key={question}>{question} <small>{t.optional}</small><input maxLength={1000} value={form.extra_answers?.[question]||''} onChange={e=>onChange('extra_answers',{...form.extra_answers,[question]:e.target.value})}/></label>)}</div>}</>;
 return null;
}

export function EnrollmentReview({form,info,language}:{form:Row;info:Row;language:Language}){
 const t=translations[language];const keys=['enrollment_type','grade_level_id','first_name','last_name','birth_date','sex','lrn','address','contact','student_email',...adults.flatMap(p=>[p+'_available',...(form[p+'_available']?[p+'_name',p+'_contact',p+'_address']:[])]),'previously_attended',...(form.previously_attended?['previous_school','previous_school_address','last_grade_level_id']:[]),'extra_answers'];
 const value=(key:string)=>key==='grade_level_id'||key==='last_grade_level_id'?(info.allGrades||info.grades).find((g:Row)=>g.id===form[key])?.name||t.notApplicable:typeof form[key]==='boolean'?form[key]?t.yes:t.previousNo:key==='enrollment_type'?form[key]==='New'?t.newLearner:form[key]==='Returning'?t.returning:t.transferee:key==='lrn'&&!form[key]?t.noLrnReview:key==='sex'?form[key]==='Male'?t.male:t.female:key==='extra_answers'?Object.entries(form.extra_answers||{}).map(([q,a])=><span key={q}>{q}: {String(a)}<br/></span>):String(form[key]||'—');
 return <>{keys.map(key=><div key={key}><small>{(t as any)[key]||key}</small><p>{value(key)}</p></div>)}</>;
}
