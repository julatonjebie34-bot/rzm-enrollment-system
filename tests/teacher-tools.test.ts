import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pasteGrades,validGrade,teacherTasks,validSelection} from '../src/teacher-tools.ts';
const policy={grade_min:60,grade_max:100,quarter_decimals:0};
test('spreadsheet paste validates the whole column, range, row count and precision',()=>{
 assert.deepEqual(pasteGrades('80\r\n90\r\n',['a','b','c'],1,policy),{b:80,c:90});
 assert.deepEqual(pasteGrades('80\n\n90',['a','b','c'],0,policy),{a:80,b:null,c:90});
 for(const text of ['80\t90','Grade\n90','80\n101','80\n79.5','80\n-1','80\nInfinity','80\n1e2'])assert.throws(()=>pasteGrades(text,['a','b'],0,policy));
 assert.throws(()=>pasteGrades('80\n90',['a','b'],1,policy));
 assert.equal(validGrade(NaN,policy),false);assert.equal(validGrade(null,policy),true);
});
const data={school_years:[{id:'year',active:true}],sections:[{id:'class',active:true,school_year_id:'year'},{id:'other',active:true,school_year_id:'year'}],assignments:[{id:'mine',teacher_id:'teacher',section_id:'class',subject_id:'math',active:true},{id:'not-mine',teacher_id:'another',section_id:'other',subject_id:'math',active:true}],grading_periods:[{id:'q1',school_year_id:'year',encoding_open:true,starts_at:'2026-01-01',ends_at:'2026-03-31'},{id:'q2',school_year_id:'year',encoding_open:false,starts_at:'2026-04-01',ends_at:'2026-06-30'}],grade_submissions:[] as any[]};
test('tasks respect assignments, actual quarter dates, returned work and locked submissions',()=>{
 const now=Date.parse('2026-02-01');assert.equal(teacherTasks(data,'teacher',now).length,1);
 assert.equal(teacherTasks(data,'teacher',Date.parse('2026-07-01')).length,0);
 const submission={section_id:'class',subject_id:'math',period_id:'q1',status:'Submitted'};
 assert.equal(teacherTasks({...data,grade_submissions:[submission]},'teacher',now).length,0);
 const returned={...submission,period_id:'q2',status:'Returned',remarks:'Check grades'};
 const tasks=teacherTasks({...data,grade_submissions:[returned]},'teacher',now);assert.equal(tasks[0].submission?.status,'Returned');assert.equal(tasks[0].open,false);
 assert.equal(teacherTasks({...data,school_years:[{id:'year',active:true,archived:true}]},'teacher',now).length,0);
});
test('remembered selections discard revoked assignments and mismatched quarters',()=>{
 assert.deepEqual(validSelection(data,'teacher',{year:'year',section:'class',assignment:'mine',period:'q1'}),{year:'year',section:'class',assignment:'mine',period:'q1'});
 const result=validSelection(data,'teacher',{year:'deleted',section:'other',assignment:'not-mine',period:'deleted'});assert.deepEqual(result,{year:'year',section:'',assignment:'',period:''});
});
