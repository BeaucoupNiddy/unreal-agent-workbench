#!/usr/bin/env python3
"""Publish this distribution through GitHub API using Git's credential helper."""
import argparse,json,os,shutil,subprocess,urllib.request,urllib.error
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--owner',required=True);parser.add_argument('--repo',default='unreal-agent-workbench');parser.add_argument('--inspect',action='store_true')
args=parser.parse_args()
credential=subprocess.run(['git','credential','fill'],input='protocol=https\nhost=github.com\n\n',capture_output=True,text=True,check=True,env={**os.environ,'GIT_TERMINAL_PROMPT':'0'})
fields=dict(line.split('=',1) for line in credential.stdout.splitlines() if '=' in line)
token=fields.get('password')
if not token:raise SystemExit('Sign into GitHub through your Git credential helper first.')
def api(route,method='GET',data=None,raw=None):
    url=route if route.startswith('https://') else 'https://api.github.com'+route
    body=raw if raw is not None else json.dumps(data).encode() if data is not None else None
    request=urllib.request.Request(url,data=body,method=method,headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','User-Agent':'Unreal-Agent-Release','Content-Type':'application/octet-stream' if raw is not None else 'application/json'})
    with urllib.request.urlopen(request,timeout=300) as response:return json.load(response)
user=api('/user')
if user['login'].lower()!=args.owner.lower():raise SystemExit('Authenticated GitHub account does not match the requested owner.')
route=f'/repos/{args.owner}/{args.repo}'
try:repo=api(route)
except urllib.error.HTTPError as e:
    if e.code!=404:raise
    repo=None
if args.inspect:
    print(json.dumps({'account':user['login'],'repository':repo['html_url'] if repo else None,'private':repo['private'] if repo else None}));raise SystemExit(0)
if not repo:repo=api('/user/repos','POST',{'name':args.repo,'description':'Installable macOS Unreal Agent Console, bundled runtime, build source, and documentation.','private':True,'auto_init':False})
work=ROOT/'.publish';work.mkdir(exist_ok=True)
if not (work/'.git').exists():
    subprocess.run(['git','init','-b','main',str(work)],check=True)
    subprocess.run(['git','-C',str(work),'remote','add','origin',repo['clone_url']],check=True)
for name in ('source','packaging','docs','test'):
    target=work/name
    if target.exists():shutil.rmtree(target)
    shutil.copytree(ROOT/name,target,ignore=shutil.ignore_patterns('__pycache__'))
for name in ('README.md','THIRD_PARTY_NOTICES.md'):shutil.copy2(ROOT/name,work/name)
(work/'.gitignore').write_text('build/\nreleases/\n.publish/\n**/node_modules/\n**/__pycache__/\n.DS_Store\n.env\n.env.*\n*.log\n')
for command in (['git','add','.'],['git','diff','--cached','--check']):subprocess.run(command,cwd=work,check=True)
changed=subprocess.run(['git','diff','--cached','--quiet'],cwd=work).returncode!=0
if changed:subprocess.run(['git','commit','-m','Package Unreal Agent Console as a self-contained macOS app'],cwd=work,check=True)
# A normal push never force-replaces another branch's history.
subprocess.run(['git','push','-u','origin','main'],cwd=work,check=True)
version=json.loads((ROOT/'releases/BUILD-INFO.json').read_text())['version'];tag='v'+version
try:api(route+'/releases/tags/'+tag)
except urllib.error.HTTPError as e:
    if e.code!=404:raise
else:raise SystemExit('Release tag already exists; refusing to overwrite a published release.')
notes=(ROOT/'docs/RELEASE_NOTES.md').read_text()
release=api(route+'/releases','POST',{'tag_name':tag,'target_commitish':'main','name':f'Unreal Agent {version} — macOS Apple Silicon','body':notes,'draft':True,'prerelease':False})
upload=release['upload_url'].split('{')[0]
files=sorted((ROOT/'releases').glob('*'))
for file in files:
    if file.suffix not in ('.pkg','.zip','.json','.txt'):continue
    from urllib.parse import quote
    result=api(upload+'?name='+quote(file.name),'POST',raw=file.read_bytes())
    if result['size']!=file.stat().st_size:raise RuntimeError('Uploaded asset size mismatch')
    print('Uploaded',file.name,result['size'])
release=api(route+'/releases/'+str(release['id']),'PATCH',{'draft':False})
print(json.dumps({'repository':repo['html_url'],'release':release['html_url'],'assets':[x['name'] for x in api(route+'/releases/'+str(release['id']))['assets']]}))
