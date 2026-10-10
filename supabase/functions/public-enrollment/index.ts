import {createClient} from 'https://esm.sh/@supabase/supabase-js@2';
import {boundedBody,cleanDetails,fileType,PublicError,publicErrorCode} from './validation.ts';
const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
Deno.serve(async(req)=>{
 const origin=req.headers.get('origin')||'';const allowed=(Deno.env.get('ALLOWED_ORIGINS')||'').split(',').map(v=>v.trim()).filter(Boolean);
 const headers={'Access-Control-Allow-Origin':allowed.includes(origin)?origin:'null','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin'};
 const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
 if(!allowed.includes(origin))return response({error:'Origin not allowed',errorCode:'ORIGIN_NOT_ALLOWED'},403);
 if(req.method==='OPTIONS')return new Response('ok',{headers});if(!['GET','POST'].includes(req.method))return response({error:'Method not allowed'},405);
 const paths:string[]=[];let rpcAttempted=false;
 try{
  const url=new URL(req.url);const token=url.searchParams.get('token');if(!token||!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(token))throw new PublicError('LINK_UNAVAILABLE');
  const {data:link,error}=await client.from('enrollment_links').select('*').eq('token',token).single();if(error&&error.code!=='PGRST116')throw new PublicError('SERVICE_UNAVAILABLE');if(!link||!link.published||link.archived||Date.now()<Date.parse(link.opens_at)||Date.now()>Date.parse(link.closes_at))throw new PublicError('LINK_UNAVAILABLE');
  const allGrades=await client.from('grade_levels').select('id,name').order('rank');if(allGrades.error)throw new PublicError('SERVICE_UNAVAILABLE');
  link.valid_grade_ids=allGrades.data.map((g:{id:string})=>g.id);
  if(req.method==='GET'){
   const [grades,year,school]=await Promise.all([Promise.resolve({data:allGrades.data.filter((g:{id:string})=>link.allowed_grade_ids.includes(g.id)),error:null}),client.from('school_years').select('name').eq('id',link.school_year_id).single(),client.from('school_settings').select('school_name').eq('id',1).single()]);if(grades.error||year.error||school.error)throw new PublicError('SERVICE_UNAVAILABLE');
   return response({title:link.title,instructions:link.instructions,extra_questions:link.extra_questions,grades:grades.data,allGrades:allGrades.data,year:year.data?.name,school:school.data?.school_name,turnstileSiteKey:Deno.env.get('TURNSTILE_SITE_KEY')});
  }
  // Hash a gateway address rather than storing raw IPs; also enforce a per-link global cap.
  const ip=(req.headers.get('x-forwarded-for')||'unknown').split(',').at(-1)!.trim();const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip+'|'+Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')));const hash=[...new Uint8Array(bytes)].map(v=>v.toString(16).padStart(2,'0')).join('');
  const checking=url.searchParams.get('action')==='check-lrn';
  for(const [bucket,maximum] of [[`link:${token}:${checking?'check':'submit'}`,checking?80:30],[`ip:${hash}:${checking?'check':'submit'}`,checking?12:5]] as const){const r=await client.rpc('consume_enrollment_limit',{bucket_key:bucket,maximum,window_seconds:60});if(r.error)throw new PublicError('SERVICE_UNAVAILABLE');if(!r.data)throw new PublicError('RATE_LIMITED');}
  if(checking){const body=JSON.parse(await (await boundedBody(req,1024)).text());if(typeof body.lrn!=='string'||!/^\d{12}$/.test(body.lrn)||!['New','Returning','Transferee'].includes(body.enrollment_type))throw new PublicError('INVALID_LRN');const r=await client.rpc('check_public_lrn',{link_token:token,official_lrn:body.lrn,learner_type:body.enrollment_type});if(r.error)throw r.error;return response(r.data);}
  const blob=await boundedBody(req,11*1024*1024);const form=await new Response(blob,{headers:{'Content-Type':req.headers.get('content-type')||''}}).formData();const raw=JSON.parse(String(form.get('data')));const details=cleanDetails(raw,link);const submission=raw.submission_id;if(typeof submission!=='string'||!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(submission))throw new PublicError('INVALID_SUBMISSION');
  const secret=Deno.env.get('TURNSTILE_SECRET_KEY');if(!secret)throw new PublicError('SERVICE_UNAVAILABLE');const verified=await (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',body:new URLSearchParams({secret,response:String(form.get('captcha')||'')})})).json();if(!verified.success||verified.action!=='enrollment'||verified.hostname!==new URL(origin).hostname)throw new PublicError('CAPTCHA_REQUIRED');
  const docs=[];const folder=crypto.randomUUID();for(const [field,kind] of [['photo','Photo'],['certificate','Birth Certificate']]){const file=form.get(field);if(!(file instanceof File)||!file.size)throw new PublicError('MISSING_DOCUMENTS');if(file.size>5*1024*1024)throw new PublicError('DOCUMENT_TOO_LARGE');const bytes=new Uint8Array(await file.arrayBuffer());const type=fileType(bytes,field);const path=`${folder}/${field}.${type.ext}`;const uploaded=await client.storage.from('student-documents').upload(path,bytes,{contentType:type.mime});if(uploaded.error)throw new PublicError('SERVICE_UNAVAILABLE');paths.push(path);docs.push({kind,path});}
  // This RPC commits application + both document rows together; replay IDs are stable.
  rpcAttempted=true;const result=await client.rpc('submit_public_application',{link_token:token,submission,details,uploaded_documents:docs});if(result.error)throw result.error;if(!result.data?.reference)throw new PublicError('SERVICE_UNAVAILABLE');
  if(result.data.replayed&&paths.length)await client.storage.from('student-documents').remove(paths);return response({reference:result.data.reference,lrn_status:result.data.lrn_status},201);
 }catch(error){
  // An interrupted RPC may have committed: never delete potentially referenced uploads.
  if(paths.length&&!rpcAttempted)await client.storage.from('student-documents').remove(paths);
  const code=publicErrorCode(error);return response({error:'Enrollment could not be completed. Please check the form or contact the school.',errorCode:code},code==='RATE_LIMITED'?429:code==='LINK_UNAVAILABLE'?404:code==='SERVICE_UNAVAILABLE'?503:400);
 }
});
