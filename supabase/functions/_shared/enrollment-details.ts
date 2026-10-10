export type Details = Record<string, any>;
export const adults = ['mother', 'father', 'guardian'] as const;
export const addressExample = '123 Rizal Street, Brgy. Ibingay, Masbate City, Masbate';
export const additionalFields = ['student_email', 'mother_available', 'mother_name', 'mother_contact', 'mother_address', 'father_available', 'father_name', 'father_contact', 'father_address', 'guardian_available', 'guardian_address', 'previously_attended', 'previous_school_address', 'last_grade_level_id'];
export const initialDetails = (): Details => ({enrollment_type:'New',has_lrn:false,lrn:'',mother_available:false,father_available:false,guardian_available:true,previously_attended:null});
export function phone(value: unknown): string | null {
  if(typeof value !== 'string' || !/^[+\d\s().-]+$/.test(value)) return null;
  const digits=value.replace(/[\s().-]/g,'');
  if(!/^(?:\+?63|0)(?:9\d{9}|2\d{8}|[3-8]\d{8})$/.test(digits)) return null;
  return '+63'+digits.replace(/^(?:\+?63|0)/,'');
}
export const emailValid=(value:unknown)=>typeof value==='string'&&value.length<=254&&/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value.trim());
export function restoreDetails(saved:Details):Details {
  const form={...initialDetails(),...saved};
  if(typeof saved.previously_attended!=='boolean')form.previously_attended=saved.previous_school?.trim()?true:null;
  return syncAddresses(form);
}
export function syncAddresses(form:Details):Details {
  const next={...form};
  for(const person of adults)if(next[person+'_same_address'])next[person+'_address']=String(next.address||'');
  return next;
}
export function changeDetails(form:Details,key:string,value:any):Details {
  const next={...form,[key]:value};
  if(key==='previously_attended'&&value===false){next.previous_school='';next.previous_school_address='';next.last_grade_level_id='';}
  for(const person of adults)if(key===person+'_available'&&!value){for(const suffix of ['name','contact','address'])next[person+'_'+suffix]='';next[person+'_same_address']=false;}
  return syncAddresses(next);
}
export type Issue={field:string;code:string};
export function validateStep(form:Details,step:number,gradeIds:string[],allGradeIds=gradeIds):Issue|null {
  const required=(keys:string[]):Issue|null=>{const field=keys.find(k=>typeof form[k]!=='string'||!form[k].trim()||form[k].length>1000);return field?{field,code:'requiredError'}:null;};
  if(step===0){
    const missing=required(['first_name','last_name','birth_date','sex','grade_level_id','enrollment_type']);if(missing)return missing;
    if(!gradeIds.includes(form.grade_level_id))return{field:'grade_level_id',code:'invalidGrade'};
    if(!['Male','Female'].includes(form.sex)||!['New','Returning','Transferee'].includes(form.enrollment_type))return{field:'sex',code:'requiredError'};
    const date=Date.parse(form.birth_date);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(form.birth_date)||!Number.isFinite(date)||date>Date.now()||new Date(date).toISOString().slice(0,10)!==form.birth_date)return{field:'birth_date',code:'invalidBirthDate'};
    if(typeof form.has_lrn!=='boolean'||form.has_lrn&&!/^\d{12}$/.test(form.lrn||''))return{field:'lrn',code:'invalidLrn'};
  }
  if(step===1){
    const missing=required(['address','contact']);if(missing)return missing;
    if(!phone(form.contact))return{field:'contact',code:'invalidPhone'};
    if(form.student_email!=null&&(typeof form.student_email!=='string'||form.student_email.trim()&&!emailValid(form.student_email)))return{field:'student_email',code:'invalidEmail'};
  }
  if(step===2){
    if(!adults.some(p=>form[p+'_available']===true))return{field:'guardian_available',code:'adultRequired'};
    for(const p of adults){
      if(typeof form[p+'_available']!=='boolean')return{field:p+'_available',code:'adultRequired'};
      if(!form[p+'_available'])continue;
      const missing=required([p+'_name',p+'_contact']);if(missing)return missing;
      if(!phone(form[p+'_contact']))return{field:p+'_contact',code:'invalidPhone'};
      if(form[p+'_address']!=null&&(typeof form[p+'_address']!=='string'||form[p+'_address'].length>1000))return{field:p+'_address',code:'requiredError'};
    }
  }
  if(step===3){
    if(typeof form.previously_attended!=='boolean')return{field:'previously_attended',code:'previousAnswerRequired'};
    if(form.previously_attended){const missing=required(['previous_school','previous_school_address']);if(missing)return missing;
      if(form.last_grade_level_id&&!allGradeIds.includes(form.last_grade_level_id))return{field:'last_grade_level_id',code:'invalidGrade'};
    }
  }
  return null;
}
export function cleanExtendedDetails(input:Details):Details {
  const data:Details={student_email:input.student_email?.trim()||null,contact:phone(input.contact),previously_attended:input.previously_attended};
  for(const p of adults){data[p+'_available']=input[p+'_available'];for(const s of ['name','contact','address'])data[p+'_'+s]=input[p+'_available']?(s==='contact'?phone(input[p+'_'+s]):String(input[p+'_'+s]||'').trim()):'';}
  data.previous_school=input.previously_attended?input.previous_school.trim():'';
  data.previous_school_address=input.previously_attended?input.previous_school_address.trim():'';
  data.last_grade_level_id=input.previously_attended?(input.last_grade_level_id||null):null;
  return data;
}
