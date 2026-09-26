#!/usr/bin/env python3
"""Inspect the built distribution and smoke-test HTTP without touching user state."""
import hashlib,json,os,re,subprocess,tempfile,time,urllib.request,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
resources=ROOT/'build/payload/Unreal Agent.app/Contents/Resources'
node=resources/'runtime/bin/node'
provenance=json.loads((resources/'BUILD-INFO.json').read_text())
for file,key in ((node,'bundledNodeSHA256'),(resources/'runtime/bin/unreal-agent-runner','bundledRunnerSHA256')):
    with file.open('rb') as stream:assert hashlib.file_digest(stream,'sha256').hexdigest()==provenance[key]
for name,expected in provenance['sourceSHA256'].items():
    with (resources/'source'/name).open('rb') as stream:assert hashlib.file_digest(stream,'sha256').hexdigest()==expected
subprocess.run([str(node),'--version'],check=True)
help_result=subprocess.run([str(resources/'runtime/bin/unreal-agent-runner'),'--help'],capture_output=True,text=True)
assert 'Request schema' in help_result.stdout+help_result.stderr
subprocess.run(['codesign','--verify','--deep','--strict',str(resources.parent.parent)],check=True)
for file in (ROOT/'source').rglob('*'):
    if not file.is_file():continue
    text=file.read_text(errors='replace')
    assert not re.search(r'/Users/Pat Nasty|tail07c43b|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-or-v1-[a-f0-9]{20,}|-----BEGIN .*PRIVATE KEY',text),f'Private content in {file}'
for file in resources.rglob('*'):
    if file.is_symlink():assert file.resolve().is_relative_to(resources),f'External symlink: {file}'
for line in (ROOT/'releases/SHA256SUMS.txt').read_text().splitlines():
    expected,name=line.split('  ',1)
    with (ROOT/'releases'/name).open('rb') as stream:assert hashlib.file_digest(stream,'sha256').hexdigest()==expected
for file in (ROOT/'releases').glob('*.zip'):
    with zipfile.ZipFile(file) as archive:
        assert archive.testzip() is None
        names=archive.namelist()
        assert any(p.endswith('/Install.command') for p in names)
        assert any(p.endswith('/Unreal Agent.app/Contents/MacOS/UnrealAgent') for p in names)
with tempfile.TemporaryDirectory(prefix='unreal-clean-home-') as temporary:
    # Bind an unused port; no daemon/LaunchAgent is started and no provider is called.
    import socket
    with socket.socket() as listener:listener.bind(('127.0.0.1',0));port=listener.getsockname()[1]
    env={'HOME':temporary,'PATH':str(node.parent)+':/usr/bin:/bin','PORT':str(port),'UNREAL_AGENT_RUNNER':str(resources/'runtime/bin/unreal-agent-runner')}
    with open(Path(temporary)/'server.log','w+') as log:
        process=subprocess.Popen([str(node),str(resources/'source/agent-console/server.mjs')],env=env,stdout=log,stderr=log)
        try:
            for attempt in range(40):
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/',timeout=1) as response:assert b'<!doctype html' in response.read().lower()
                    break
                except OSError:time.sleep(.1)
            else:raise AssertionError('Front end did not start')
            for endpoint in ('/app.js','/styles.css','/api/projects'):
                with urllib.request.urlopen(f'http://127.0.0.1:{port}'+endpoint,timeout=2) as response:assert response.status==200
            request=urllib.request.Request(f'http://127.0.0.1:{port}/api/projects',headers={'Origin':'https://untrusted.example'})
            try:urllib.request.urlopen(request);raise AssertionError('Cross-origin request was accepted')
            except urllib.error.HTTPError as e:assert e.code==403
        finally:process.terminate();process.wait(timeout=5)
    with socket.socket() as listener:listener.bind(('127.0.0.1',0));hydra_port=listener.getsockname()[1]
    hydra_home=Path(temporary)/'.hydra-acp';hydra_home.mkdir()
    (hydra_home/'config.json').write_text(json.dumps({'daemon':{'host':'127.0.0.1','port':hydra_port},'agents':{'unreal':{'command':str(node),'args':[str(resources/'source/unreal-agent-acp/bin/unreal-agent-acp.mjs')]}},'defaultAgent':'unreal'}))
    env['HYDRA_ACP_HOME']=str(hydra_home)
    with open(Path(temporary)/'hydra.log','w+') as log:
        process=subprocess.Popen([str(node),str(resources/'source/hydra-gateway/node_modules/@hydra-acp/cli/dist/daemon.js')],env=env,stdout=log,stderr=log)
        try:
            for attempt in range(100):
                try:
                    token=(hydra_home/'auth-token').read_text().strip()
                    request=urllib.request.Request(f'http://127.0.0.1:{hydra_port}/v1/health',headers={'Authorization':'Bearer '+token})
                    with urllib.request.urlopen(request,timeout=1) as response:assert response.status==200
                    break
                except OSError:time.sleep(.1)
            else:raise AssertionError('Bundled Hydra did not start')
            request=urllib.request.Request(f'http://127.0.0.1:{hydra_port}/v1/sessions',headers={'Authorization':'Bearer '+token})
            with urllib.request.urlopen(request,timeout=2) as response:assert response.status==200
        finally:process.terminate();process.wait(timeout=10)
print('Runtime, signatures, private-data scan, symlinks, archives, checksums, clean-HOME frontend/Hydra HTTP and origin checks passed.')
