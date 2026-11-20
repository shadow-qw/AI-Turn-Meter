import importlib.util, pathlib, json, copy, subprocess, sys, tempfile, os
ROOT=pathlib.Path(__file__).resolve().parents[3]
TOOL=ROOT/'tools/autopilot/publication_preflight.py'
code=r"""
import importlib.util,json,copy,pathlib,sys
spec=importlib.util.spec_from_file_location('p',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
B='601e7775e5f9b5748f4426cfd0f741e337c2eeca';H='42bb66fb37373a707a8d6c2aa891906be4c4c533';old='759f3ea525b64281060b14ed43c6f35ae15705c8';P='a'*40
repo={'id':1461122513,'full_name':'shadow-qw/AI-Turn-Meter'}
pr={'number':2,'state':'open','merged':False,'head':{'sha':H,'ref':'docs/issue-autopilot-design-20261119','repo':repo},'base':{'sha':old,'ref':'main','repo':repo},'merge_commit_sha':None,'mergeable':False,'mergeable_state':'dirty'}
v={'purpose':'publication-only-snapshot','pr':pr,'refs':{'head':H,'main':B},'actor':'shadow-qw','approvalsObserved':[]}
def must(ok):
 if not ok:raise RuntimeError('TEST_FAILED')
def denied(value,fn=m.validate_publication):
 marker=False
 try:fn(value);marker=True
 except (ValueError,KeyError,TypeError):pass
 must(not marker)
m.validate_publication(v)
for path,value in [('purpose','diagnostic-observation'),('actor','other'),('approvalsObserved',[{'name':'ATM_SYNTHETIC_APPROVED_WORKFLOW_SHA','value':P}]),('refs.main',old),('refs.head',P),('pr.number',True),('pr.state','closed'),('pr.merged',True),('pr.head.sha',P),('pr.head.ref','main'),('pr.head.repo.id',True),('pr.head.repo.full_name','evil/repo'),('pr.base.sha',B),('pr.base.ref','other'),('pr.merge_commit_sha',P),('pr.mergeable',True),('pr.mergeable_state','clean')]:
 for how in ['wrong','missing','type']:
  q=copy.deepcopy(v);parts=path.split('.');obj=q
  for key in parts[:-1]:obj=obj[key]
  if how=='missing':del obj[parts[-1]]
  else:obj[parts[-1]]={} if how=='type' else value
  denied(q)
for x in [None,[],True,{}, {'purpose':'publication-evaluation','marker':'PUBLICATION_ONLY_EVALUATION_OK'}, {'purpose':'diagnostic-observation-only'}]:denied(x)
receipt=m.publication_receipt(P,v)
must(receipt['diagnosticApproved'] is False and receipt['candidateValidated'] is False)
denied(receipt)
# No configured D exists. This pure observation helper is not an authorization
# gate or CLI mode; it cannot activate a workflow or issue D approval.
d={'purpose':'published-diagnostic-observation','pr':copy.deepcopy(pr),'mergeCommit':{'sha':'b'*40,'parents':[{'sha':B},{'sha':P}]}}
d['pr']['head']['sha']=P;d['pr']['base']['sha']=B;d['pr']['merge_commit_sha']='b'*40;d['pr']['mergeable']=True;d['pr']['mergeable_state']='clean'
m.validate_diagnostic_observation(d,P)
for x in [v,receipt,{'purpose':'diagnostic-observation-only'},None,[]]:denied(x,lambda q:m.validate_diagnostic_observation(q,P))
for path,value in [('pr.head.sha',H),('pr.base.sha',old),('pr.merge_commit_sha',None),('mergeCommit.sha',None),('mergeCommit.parents',[]),('pr.number',True),('pr.merged',True),('pr.mergeable',False)]:
 for how in ['wrong','missing','type']:
  q=copy.deepcopy(d);parts=path.split('.');obj=q
  for k in parts[:-1]:obj=obj[k]
  if how=='missing':del obj[parts[-1]]
  else:obj[parts[-1]]={} if how=='type' else value
  denied(q,lambda x:m.validate_diagnostic_observation(x,P))
denied(d)
for raw in [b'{bad',b'{"purpose":"diagnostic","purpose":"publication-only-snapshot"}',b'null',b'[]',b'{}',b'\xff',json.dumps(v).encode()+b' '*1048577]:
 try:m.load_snapshot_bytes(raw);raise RuntimeError('BAD_JSON_ACCEPTED')
 except (ValueError,UnicodeError,KeyError,TypeError):pass
print('MODE_PURPOSE_NEGATIVES_OK')
"""
for flags,env in [([],{}),([],{'PYTHONOPTIMIZE':'1'}),([],{'PYTHONOPTIMIZE':'2'}),(['-O'],{}),(['-OO'],{})]:
 r=subprocess.run([sys.executable,'-B',*flags,'-c',code,str(TOOL)],env={'PATH':os.environ['PATH'],'HOME':'/nonexistent',**env},text=True,capture_output=True)
 if r.returncode!=0:raise RuntimeError(r.stdout+r.stderr)
 print(flags,env,r.stdout.strip())
