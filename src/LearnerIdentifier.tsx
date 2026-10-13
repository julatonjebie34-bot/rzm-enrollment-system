import React from 'react';
export function LearnerIdentifier({learner}:{learner?:Record<string,any>}){return <div><div>Official LRN: {learner?.lrn||'Not assigned'}</div>{learner?.learner_identifier&&<div><strong>{learner.learner_identifier}</strong><small className="learner-id-label">Application-generated learner ID · not an official DepEd LRN</small></div>}</div>}
