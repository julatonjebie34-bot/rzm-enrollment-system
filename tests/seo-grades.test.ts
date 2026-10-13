import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {publicHomepage} from '../src/seo.ts';
import {quarterResult} from '../src/teacher-tools.ts';
test('only anonymous canonical homepage is indexable',()=>{
 const root='https://rzm-enrollment-system.vercel.app/';assert.equal(publicHomepage(new URL(root)),true);
 for(const tail of ['?enroll=test','?reset-password=1','?code=test','#access_token=test','admin','student-records','index.html'])assert.equal(publicHomepage(new URL(root+tail)),false);
 assert.equal(publicHomepage(new URL(root),true),false);assert.equal(publicHomepage(new URL('https://preview.vercel.app/')),false);
});
test('grade color boundaries keep missing and invalid grades neutral',()=>{
 for(const value of [null,undefined,'',NaN,-1,101,'75'])assert.equal(quarterResult(value),'');
 for(const value of [0,50,74,74.99])assert.equal(quarterResult(value),'fail');
 for(const value of [75,75.01,100])assert.equal(quarterResult(value),'pass');
});
test('SEO assets list public homepage only and preserve SPA/security configuration',()=>{
 const html=readFileSync('index.html','utf8'),robots=readFileSync('public/robots.txt','utf8'),map=readFileSync('public/sitemap.xml','utf8');
 assert.match(html,/<html lang="en">/);assert.match(html,/name="description"/);assert.match(html,/name="robots" content="index, follow"/);assert.match(html,/rel="canonical" href="https:\/\/rzm-enrollment-system.vercel.app\/"/);
 for(const text of ['Restituta Z. Medina Elementary School','Web-Based Enrollment System','Online Enrollment','Student Information Management','Academic Records Management'])assert.ok(html.includes(text));
 assert.equal((map.match(/<loc>/g)||[]).length,1);assert.ok(map.includes('<loc>https://rzm-enrollment-system.vercel.app/</loc>'));assert.ok(robots.includes('Sitemap: https://rzm-enrollment-system.vercel.app/sitemap.xml'));
 assert.equal(/supabase|service_role|enroll=|token_hash|student_id/i.test(map),false);assert.ok(existsSync('public/brand/school-logo.jpg'));
 const config=JSON.parse(readFileSync('vercel.json','utf8'));assert.ok(config.rewrites.some((r:any)=>r.source==='/(.*)'&&r.destination==='/index.html'));
 for(const key of ['enroll','reset-password','code','token_hash'])assert.ok(config.headers.some((r:any)=>r.has?.some((h:any)=>h.type==='query'&&h.key===key)&&r.headers.some((h:any)=>h.key==='X-Robots-Tag'&&h.value.includes('noindex'))));
 assert.ok(config.headers.some((r:any)=>r.missing?.some((h:any)=>h.type==='host'&&h.value==='rzm-enrollment-system.vercel.app')));
 assert.ok(config.headers.some((r:any)=>r.source==='/sw.js'&&r.headers.some((h:any)=>h.key==='Content-Type'&&h.value.includes('javascript'))));
});
