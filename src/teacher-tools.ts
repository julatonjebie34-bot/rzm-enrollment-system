type Row=Record<string,any>;
export type TeacherSelection={year?:string;section?:string;assignment?:string;period?:string};
export function validGrade(value:unknown,policy:Row){return value===null||typeof value==='number'&&Number.isFinite(value)&&value>=Math.max(0,policy.grade_min)&&value<=Math.min(100,policy.grade_max)&&Math.abs(value*10**policy.quarter_decimals-Math.round(value*10**policy.quarter_decimals))<1e-7;}
/** Validate the entire column before applying anything; never partially paste grades. */
export function pasteGrades(text:string,ids:string[],start:number,policy:Row){
 const lines=text.replace(/\r\n?/g,'\n').replace(/\n$/,'').split('\n');
 if(start<0||start+lines.length>ids.length)throw Error('The pasted grades exceed the remaining student rows.');
 const result:Row={};
 lines.forEach((line,i)=>{if(line.includes('\t'))throw Error('Copy one quarter’s grade column only, without names or headings.');const cell=line.trim();if(cell&&!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(cell))throw Error(`Pasted row ${i+1} is not a numeric grade.`);const value=cell===''?null:Number(cell);if(!validGrade(value,policy))throw Error(`Pasted row ${i+1} is outside the grading policy.`);result[ids[start+i]]=value;});return result;
}
export function teacherTasks(data:Record<string,Row[]>,teacher:string,now=Date.now()){
 return data.assignments.filter(a=>a.active&&a.teacher_id===teacher).flatMap(a=>{
 const section=data.sections.find(s=>s.id===a.section_id&&s.active);if(!section||data.school_years.find(y=>y.id===section.school_year_id)?.archived)return [];
 return data.grading_periods.filter(p=>p.school_year_id===section.school_year_id).flatMap(period=>{
 const submission=data.grade_submissions.find(s=>s.section_id===a.section_id&&s.subject_id===a.subject_id&&s.period_id===period.id);
 const open=period.encoding_open&&now>=Date.parse(period.starts_at)&&now<=Date.parse(period.ends_at);
 if(submission&&!['Draft','Returned'].includes(submission.status)||!open&&submission?.status!=='Returned')return [];
 return [{assignment:a,section,period,submission,open}];
 });}).sort((a,b)=>Number(b.submission?.status==='Returned')-Number(a.submission?.status==='Returned')||Date.parse(a.period.ends_at)-Date.parse(b.period.ends_at));
}
export function validSelection(data:Record<string,Row[]>,teacher:string,saved:TeacherSelection):TeacherSelection{
 const year=data.school_years.find(y=>y.id===saved.year)?.id||data.school_years.find(y=>y.active)?.id||'';
 const own=data.assignments.filter(a=>a.active&&a.teacher_id===teacher);
 const section=data.sections.find(s=>s.id===saved.section&&s.active&&s.school_year_id===year&&own.some(a=>a.section_id===s.id))?.id||'';
 return {year,section,assignment:own.find(a=>a.id===saved.assignment&&a.section_id===section)?.id||'',period:data.grading_periods.find(p=>p.id===saved.period&&p.school_year_id===year)?.id||''};
}
