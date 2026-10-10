import {useEffect,useId,useRef,useState} from 'react';
import type {Row} from './lib';
import './allowed-grades.css';

export function AllowedGradesField({grades,initialValue}:{grades:Row[];initialValue?:string[]}){
 const options=[...grades].sort((a,b)=>a.rank-b.rank||a.name.localeCompare(b.name));
 const ids=options.map(grade=>String(grade.id));
 const [selected,setSelected]=useState(()=>initialValue===undefined?ids:initialValue.filter(id=>ids.includes(id)));
 const firstOption=useRef<HTMLInputElement>(null);const descriptionId=useId();
 useEffect(()=>{firstOption.current?.setCustomValidity(selected.length?'':'Select at least one grade level.');},[selected]);
 function toggle(id:string,checked:boolean){setSelected(current=>checked?[...current,id]:current.filter(value=>value!==id));}
 return <fieldset className="allowed-grades-field" aria-describedby={descriptionId}>
  <legend>Allowed grade levels <small>Required</small></legend>
  <p id={descriptionId}>Choose which grades appear in the enrollment form. You can select one, several, or all grades.</p>
  {options.length?<>
   <div className="allowed-grades-actions"><button type="button" disabled={selected.length===ids.length} onClick={()=>setSelected(ids)}>Select all grades</button><button type="button" disabled={!selected.length} onClick={()=>setSelected([])}>Clear selection</button><span role="status">{selected.length} of {options.length} selected</span></div>
   <div className="allowed-grades-options">{options.map((grade,index)=><label className="allowed-grade-option" key={grade.id}>
    <input ref={index===0?firstOption:undefined} type="checkbox" name="allowed_grade_ids" value={grade.id} checked={selected.includes(grade.id)} required={index===0&&!selected.length} onChange={event=>toggle(grade.id,event.target.checked)}/><span>{grade.name}</span>
   </label>)}</div>
   {!selected.length&&<p className="allowed-grades-error" role="alert">Select at least one grade level before saving.</p>}
  </>:<p className="allowed-grades-error" role="alert">Add grade levels under Academics → Grade Levels before saving an enrollment link.</p>}
 </fieldset>;
}
