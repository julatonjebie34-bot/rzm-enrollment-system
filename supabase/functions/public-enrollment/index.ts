import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const required=['first_name','last_name','birth_date','sex','address','contact','guardian_name','guardian_contact','grade_level_id','enrollment_type'];
Deno.serve(async(req)=>{
 const origin=req.headers.get('origin')||'';
 const allowed=(Deno.env.get('ALLOWED_ORIGINS')||'').split(',');
 const headers={'Access-Control-Allow-Origin':allowed.includes(origin)?origin:'null','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Content-Type':'application/json','Vary':'Origin'};
 const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
 if(!allowed.includes(origin))return response({error:'Origin not allowed'},403);
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 if(!['GET','POST'].includes(req.method))return response({error:'Method not allowed'},405);
 let paths:string[]=[];let applicationId:string|undefined;
 try{
  const token=new URL(req.url).searchParams.get('token');
  if(!token||!/^[0-9a-f-]{36}$/i.test(token))throw Error('Invalid enrollment link');
  const {data:link,error}=await client.from('enrollment_links').select('*').eq('token',token).single();
  if(error||!link||!link.published||link.archived||Date.now()<Date.parse(link.opens_at)||Date.now()>Date.parse(link.closes_at))return response({error:'This enrollment link is closed or unavailable'},404);
  if(req.method==='GET'){
   const [grades,year,school]=await Promise.all([client.from('grade_levels').select('id,name').in('id',link.allowed_grade_ids),client.from('school_years').select('name').eq('id',link.school_year_id).single(),client.from('school_settings').select('school_name').eq('id',1).single()]);
   return response({title:link.title,instructions:link.instructions,extra_questions:link.extra_questions,grades:grades.data,year:year.data?.name,school:school.data?.school_name,turnstileSiteKey:Deno.env.get('TURNSTILE_SITE_KEY')});
  }
  if(Number(req.headers.get('content-length')||0)>11*1024*1024)return response({error:'Request too large'},413);
  const reader=req.body?.getReader();if(!reader)throw Error('Missing request body');let length=0;const chunks:ArrayBuffer[]=[];while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>11*1024*1024){await reader.cancel();return response({error:'Request too large'},413);}chunks.push(new Uint8Array(value).buffer);}const form=await new Response(new Blob(chunks),{headers:{'Content-Type':req.headers.get('content-type')||''}}).formData(); const data=JSON.parse(String(form.get('data')));
  const secret=Deno.env.get('TURNSTILE_SECRET_KEY');if(!secret)throw Error('Enrollment protection is not configured');
  const verify=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',body:new URLSearchParams({secret,response:String(form.get('captcha')||'')})});
  const verified=await verify.json();if(!verified.success||verified.action!=='enrollment')return response({error:'Please complete the verification again'},400);
  for(const field of required){if(typeof data[field]!=='string'||!data[field].trim()||data[field].length>1000)throw Error('Invalid or missing '+field);data[field]=data[field].trim();}
  if(!link.allowed_grade_ids.includes(data.grade_level_id))throw Error('Grade level is not allowed');
  if(!['Male','Female'].includes(data.sex)||!['New','Returning','Transferee'].includes(data.enrollment_type))throw Error('Invalid enrollment details');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(data.birth_date)||!Number.isFinite(Date.parse(data.birth_date))||Date.parse(data.birth_date)>Date.now()||new Date(data.birth_date).toISOString().slice(0,10)!==data.birth_date)throw Error('Invalid birth date');
  if(data.lrn&&!/^\d{12}$/.test(data.lrn))throw Error('LRN must have 12 digits');
  if(data.enrollment_type==='Returning'&&!data.lrn)throw Error('Returning students must enter an LRN');
  const docs=[];const folder=crypto.randomUUID();
  for(const [field,kind] of [['photo','Photo'],['certificate','Birth Certificate']]){
   const file=form.get(field);if(!(file instanceof File)||!file.size||file.size>5*1024*1024)throw Error('Both documents are required, up to 5 MB each');
   const bytes=new Uint8Array(await file.arrayBuffer());const png=bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71;const jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;const pdf=new TextDecoder().decode(bytes.slice(0,5))==='%PDF-';
   if(!(png||jpg||(field==='certificate'&&pdf)))throw Error('Use a JPG/PNG photo and a JPG/PNG/PDF birth certificate');
   const ext=png?'png':jpg?'jpg':'pdf';const path=`${folder}/${field}.${ext}`;
   const {error}=await client.storage.from('student-documents').upload(path,bytes,{contentType:png?'image/png':jpg?'image/jpeg':'application/pdf'});if(error)throw error;paths.push(path);docs.push({kind,path});
  }
  const clean=Object.fromEntries(required.map(k=>[k,data[k]]));
  const {data:app,error:save}=await client.from('applications').insert({...clean,lrn:data.lrn||null,previous_school:String(data.previous_school||'').slice(0,300),extra_answers:Object.fromEntries((link.extra_questions||[]).map((q:string)=>[q,String(data.extra_answers?.[q]||'').slice(0,1000)])),link_id:link.id}).select('id,reference').single();
  if(save)throw Error(save.code==='23505'?'An application with this LRN already exists':'Unable to submit application');applicationId=app.id;
  const {error:docError}=await client.from('documents').insert(docs.map(d=>({...d,application_id:app.id})));if(docError)throw docError;
  return response({reference:app.reference},201);
 }catch(error){
  if(applicationId)await client.from('applications').delete().eq('id',applicationId);
  if(paths.length)await client.storage.from('student-documents').remove(paths);
  return response({error:error instanceof Error?error.message:'Submission failed'},400);
 }
});
