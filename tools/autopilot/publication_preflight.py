"""Read-only publication evaluation. Never grants diagnostic/candidate permission.
CLI has exactly one purpose; no phase switch, remote write or credential access.
Input provenance/freshness and independent revision approval remain operator duties.
"""
import hashlib, json, pathlib, re, subprocess, sys
BASE = '601e7775e5f9b5748f4426cfd0f741e337c2eeca'
BEFORE = '42bb66fb37373a707a8d6c2aa891906be4c4c533'
OBSERVED_BASE = '759f3ea525b64281060b14ed43c6f35ae15705c8'
REF = 'docs/issue-autopilot-design-20261119'
ORIGINAL_HEAD = 'fb19e011aa6534e3bd3fe5bde160a022c7e98a71'
ROOT = pathlib.Path(__file__).resolve().parents[2]
DISABLED_WORKFLOW = {
 'name':'Publication checkpoint - synthetic diagnostic unavailable',
 'on':{'push':{'branches':[REF]}},'permissions':{'contents':'read'},
 'jobs':{'publication-no-diagnostic':{'if':'${{ false }}','runs-on':'ubuntu-24.04',
 'timeout-minutes':1,'steps':[{'name':'No diagnostic approval in publication checkpoint','run':'exit 1'}]}}}
def require(ok):
    if not ok: raise ValueError('rejected')
def sha(value):
    require(type(value) is str and re.fullmatch('[a-f0-9]{40}', value) is not None)
    return value
def pr_identity(p, head, base):
    require(type(p) is dict and type(p['number']) is int and p['number'] == 2)
    require(p['state'] == 'open' and p['merged'] is False)
    for side, ref, commit in [('head',REF,head),('base','main',base)]:
        x=p[side]; require(type(x) is dict and x['ref']==ref and x['sha']==commit)
        repo=x['repo'];require(type(repo) is dict and type(repo['id']) is int and repo['id']==1461122513)
        require(repo['full_name']=='shadow-qw/AI-Turn-Meter')
def validate_publication(v):
    require(type(v) is dict and set(v)=={'purpose','pr','refs','actor','approvalsObserved'})
    require(v['purpose']=='publication-only-snapshot' and v['actor']=='shadow-qw')
    require(type(v['approvalsObserved']) is list and v['approvalsObserved']==[])
    require(type(v['refs']) is dict and v['refs']=={'head':BEFORE,'main':BASE})
    pr_identity(v['pr'],BEFORE,OBSERVED_BASE)
    p=v['pr'];require(p['merge_commit_sha'] is None and p['mergeable'] is False and p['mergeable_state']=='dirty')
def unique_object(pairs):
    result={}
    for k,v in pairs:
        require(k not in result);result[k]=v
    return result
def load_snapshot_bytes(raw):
    require(type(raw) is bytes and len(raw)<=1048576)
    v=json.loads(raw.decode('utf-8'),object_pairs_hook=unique_object);validate_publication(v);return v
def publication_receipt(reviewed, v):
    validate_publication(v);sha(reviewed)
    return {'purpose':'publication-evaluation','marker':'PUBLICATION_ONLY_EVALUATION_OK',
        'reviewedPublicationSha':reviewed,'observedApiBase':OBSERVED_BASE,'targetMainRef':BASE,
        'remoteBefore':BEFORE,'diagnosticApproved':False,'candidateValidated':False,
        'allowedNextEvaluation':'normal-fast-forward-existing-pr-head-only'}
def validate_diagnostic_observation(v, published):
    """Data-only helper for a FUTURE separately reviewed D; no D approval/receipt.
    No CLI path calls this, and no current workflow consumes its result.
    """
    sha(published)
    require(type(v) is dict and set(v)=={'purpose','pr','mergeCommit'})
    require(v['purpose']=='published-diagnostic-observation')
    pr_identity(v['pr'],published,BASE)
    p=v['pr'];merge=sha(p['merge_commit_sha']);require(p['mergeable'] is True and p['mergeable_state'] in ('clean','unstable'))
    m=v['mergeCommit'];require(type(m) is dict and m['sha']==merge)
    parents=m['parents'];require(type(parents) is list and len(parents)==2)
    require(all(type(x) is dict and 'sha' in x for x in parents))
    require([sha(x['sha']) for x in parents]==[BASE,published])
def git(*args, root=ROOT):
    return subprocess.check_output(['git','-C',str(root),*args],stderr=subprocess.DEVNULL)
def check_local_publication(reviewed):
    sha(reviewed)
    require(git('rev-parse','HEAD').decode().strip()==reviewed)
    require(git('branch','--show-current').decode().strip()=='integration/issue-autopilot-main-601e777')
    require(git('status','--porcelain=v1')==b'')
    for ancestor in (BASE, BEFORE):
        subprocess.run(['git','-C',str(ROOT),'merge-base','--is-ancestor',ancestor,reviewed],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    own=pathlib.Path(__file__)
    require(not own.is_symlink() and own.is_file())
    require(own.read_bytes()==git('show',reviewed+':tools/autopilot/publication_preflight.py'))
    wf=ROOT/'.github/workflows/autopilot-synthetic.yml';require(not wf.is_symlink() and wf.is_file())
    require(json.loads(wf.read_bytes())==DISABLED_WORKFLOW)
    require(wf.read_bytes()==git('show',reviewed+':.github/workflows/autopilot-synthetic.yml'))
    for name in ('.github/workflows/ci.yml','.github/workflows/release.yml'):
        require(git('show',reviewed+':'+name)==git('show',ORIGINAL_HEAD+':'+name))
    original=pathlib.Path('/workspace/AI-Turn-Meter')
    require(git('rev-parse','HEAD',root=original).decode().strip()==ORIGINAL_HEAD)
    require(git('status','--porcelain=v1',root=original)==b' D dist/ai-turn-meter.vsix\n')
    require(hashlib.sha256(git('diff','--binary',root=original)).hexdigest()=='b8f0cf51cc1fbfb4bf674f7d199bd1d0b2397fa7518586c368a88be65569b9b6')
def main():
    try:
        require(len(sys.argv)==3)
        # Input is data, not a command or credential. No network reads/writes.
        with open(sys.argv[1],'rb') as f:raw=f.read(1048577)
        snapshot=load_snapshot_bytes(raw);check_local_publication(sys.argv[2])
        print(json.dumps(publication_receipt(sys.argv[2],snapshot),sort_keys=True))
    except Exception:
        print('PUBLICATION_ONLY_REJECTED',file=sys.stderr);return 1
    return 0
if __name__=='__main__':sys.exit(main())
