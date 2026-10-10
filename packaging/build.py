#!/usr/bin/env python3
"""Build self-contained macOS app, .pkg, ZIP, SHA-256 manifest and provenance."""
import argparse, fcntl, hashlib, json, os, plistlib, shutil, subprocess, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
VERSION='1.0.5'
def run(*args, **kwargs):
    subprocess.run([str(x) for x in args],check=True,**kwargs)
def sha(file):
    with file.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
def signing_identity(requested):
    """Pick a stable code-signing identity so macOS privacy grants (Calendar)
    survive rebuilds. Ad-hoc ('-') signatures change on every build, which
    silently invalidates grants that System Settings still shows as enabled."""
    identity=requested or os.environ.get('CODESIGN_IDENTITY','')
    if identity:return identity
    try:listing=subprocess.check_output(['/usr/bin/security','find-identity','-v','-p','codesigning'],text=True)
    except (OSError,subprocess.CalledProcessError):listing=''
    for kind in ('Developer ID Application','Apple Development'):
        for line in listing.splitlines():
            if '"'+kind in line:return line.split('"')[1]
    return '-'
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node',required=True,type=Path)
    parser.add_argument('--node-license',required=True,type=Path)
    parser.add_argument('--runner',required=True,type=Path)
    parser.add_argument('--runner-source',required=True,type=Path)
    parser.add_argument('--sign-identity',help="Code-signing identity (default: $CODESIGN_IDENTITY, else first Developer ID Application/Apple Development identity, else ad-hoc '-')")
    parser.add_argument('--offline-deps',type=Path,help='Use an already locked, installed component tree instead of npm ci')
    args=parser.parse_args()
    identity=signing_identity(args.sign_identity)
    if identity=='-':print('warning: ad-hoc signing; users must re-grant Calendar access after every update.',file=sys.stderr)
    else:
        print('Signing with:',identity)
        if identity.startswith('Apple Development'):print('note: this personal identity (including its Apple ID email) is embedded in the signature; pass --sign-identity - for public releases.',file=sys.stderr)
    if sys.platform!='darwin':parser.error('Build on macOS with Xcode Command Line Tools.')
    for binary in (args.node,args.runner):
        description=subprocess.check_output(['file','-b',str(binary.resolve())],text=True)
        if 'arm64' not in description:parser.error('This release builder requires Apple Silicon binaries.')
    revision=subprocess.check_output(['git','-C',str(args.runner_source),'rev-parse','HEAD'],text=True).strip()
    if revision!='a5f3fd13032737142916523ae4344c392292f9d5':parser.error('Runner source must match pinned revision a5f3fd13032737142916523ae4344c392292f9d5.')
    runner_info=subprocess.check_output(['go','version','-m',str(args.runner)],text=True)
    if 'vcs.revision='+revision not in runner_info or 'vcs.modified=true' in runner_info:parser.error('Runner binary does not match the clean pinned source revision.')
    build=ROOT/'build'
    if build.exists():shutil.rmtree(build)
    bundle=build/'payload'/'Unreal Agent.app'
    contents=bundle/'Contents';resources=contents/'Resources';macos=contents/'MacOS'
    macos.mkdir(parents=True);resources.mkdir()
    shutil.copytree(ROOT/'source',resources/'source')
    runtime=resources/'runtime/bin';runtime.mkdir(parents=True)
    shutil.copy2(args.node.resolve(),runtime/'node');shutil.copy2(args.runner,runtime/'unreal-agent-runner')
    # Build the inbox transport as a separate companion; the official runner and
    # supplied clean upstream checkout remain unmodified.
    run(sys.executable,ROOT/'source/live-runner/build.py','--source',args.runner_source,
        '--revision',revision,'--official-runner',args.runner,'--output',runtime/'unreal-agent-live-runner')
    live_info=json.loads((runtime/'unreal-agent-live-runner.json').read_text())

    env={**os.environ,'PATH':str(runtime)+':'+os.environ.get('PATH',''),'UNREAL_AGENT_RUNNER':str(runtime/'unreal-agent-runner'),'UNREAL_AGENT_LIVE_RUNNER':str(runtime/'unreal-agent-live-runner')}
    for component in ('hydra-gateway','unreal-agent-acp'):
        target=resources/'source'/component
        if args.offline_deps:
            source=args.offline_deps/component
            if (source/'package-lock.json').read_bytes()!=(target/'package-lock.json').read_bytes():raise RuntimeError('Offline dependency lockfile mismatch')
            shutil.copytree(source/'node_modules',target/'node_modules',symlinks=True)
        else:run('npm','ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund',cwd=target,env=env)
    for component in ('agent-console','unreal-agent-acp','apple-productivity-mcp','harness-chat'):
        run('npm','run','check',cwd=resources/'source'/component,env=env)
    shutil.copy2(ROOT/'packaging/launch.mjs',resources/'launch.mjs')
    shutil.copy2(ROOT/'packaging/Uninstall.command',resources/'Uninstall.command')
    shutil.copy2(ROOT/'README.md',resources/'README.md')
    shutil.copytree(ROOT/'docs',resources/'docs')
    licenses=resources/'licenses';licenses.mkdir()
    shutil.copy2(args.node_license,licenses/'Node-LICENSE.txt')
    shutil.copy2(args.runner_source/'LICENSE',licenses/'Unreal-Agent-LICENSE.txt')
    go_root=Path(subprocess.check_output(['go','env','GOROOT'],text=True).strip())
    go_license=next((p for p in (go_root/'LICENSE',go_root.parent/'LICENSE') if p.is_file()),None)
    if go_license is None:raise RuntimeError('Go runtime LICENSE not found in GOROOT or its parent.')
    shutil.copy2(go_license,licenses/'Go-LICENSE.txt')
    # Go dependency license text accompanies the vendored executable.
    modules=subprocess.check_output(['go','list','-m','-json','all'],cwd=args.runner_source,text=True)
    decoder=json.JSONDecoder();remaining=modules.strip();go_licenses=[]
    while remaining:
        module,end=decoder.raw_decode(remaining);remaining=remaining[end:].lstrip()
        directory=Path(module.get('Dir','/nonexistent'))
        texts=[p for p in directory.glob('*') if p.is_file() and p.name.lower().startswith(('license','copying','notice'))]
        for p in texts:
            name=(module['Path']+'@'+module.get('Version','local')+'-'+p.name).replace('/','_')
            shutil.copy2(p,licenses/name);go_licenses.append(name)
    if len(go_licenses)<5:raise RuntimeError('Go dependency licenses missing; run go mod download in the pinned runner source first.')
    for license_file in licenses.iterdir():license_file.chmod(0o644)
    shutil.copy2(ROOT/'THIRD_PARTY_NOTICES.md',resources/'THIRD_PARTY_NOTICES.md')
    iconset=build/'UnrealAgent.iconset'
    run('/usr/bin/xcrun','swift',ROOT/'packaging/generate-app-icon.swift',iconset)
    run('/usr/bin/iconutil','-c','icns',iconset,'-o',resources/'UnrealAgent.icns')
    shutil.copy2(ROOT/'packaging/Launcher.swift',build/'main.swift')
    run('/usr/bin/xcrun','swiftc','-O','-target','arm64-apple-macosx14.0','-module-cache-path',build/'swift-cache','-framework','AppKit','-framework','WebKit','-framework','Security',ROOT/'packaging/AgentWindow.swift',build/'main.swift','-o',macos/'UnrealAgent')
    run('/usr/bin/xcrun','swiftc','-O','-target','arm64-apple-macosx14.0','-module-cache-path',build/'swift-cache','-framework','AppKit','-framework','EventKit',resources/'source/apple-productivity-mcp/calendar-helper/CalendarHelper.swift','-o',macos/'UnrealAgentCalendar')
    info={'CFBundleExecutable':'UnrealAgent','CFBundleIdentifier':'local.unreal-agent','CFBundleName':'Unreal Agent','CFBundleDisplayName':'Unreal Agent','CFBundlePackageType':'APPL','CFBundleShortVersionString':VERSION,'CFBundleVersion':'2','LSMinimumSystemVersion':'14.0','CFBundleIconFile':'UnrealAgent.icns','NSCalendarsFullAccessUsageDescription':'Read and update Calendar events when you ask Unreal Agent.','NSCalendarsUsageDescription':'Read and update Calendar events when you ask Unreal Agent.','NSAppleEventsUsageDescription':'Access Apple Notes only when you enable the integration and ask Unreal Agent to use it.'}
    with (contents/'Info.plist').open('wb') as out:plistlib.dump(info,out)
    provenance={'version':VERSION,'platform':'darwin-arm64','node':subprocess.check_output([str(args.node),'--version'],text=True).strip(),'nodeSHA256':sha(args.node),'runnerRevision':revision,'runnerSHA256':sha(args.runner),'liveRunner':live_info,'dependencyMode':'offline-locked' if args.offline_deps else 'npm-ci','sourceSHA256':{str(p.relative_to(ROOT/'source')):sha(p) for p in sorted((ROOT/'source').rglob('*')) if p.is_file()}}
    (resources/'BUILD-INFO.json').write_text(json.dumps(provenance,indent=2)+'\n')
    # Discard inherited Finder/provenance metadata from this newly built tree.
    run('/usr/bin/xattr','-cr',bundle)
    for file in [runtime/'node',runtime/'unreal-agent-runner',runtime/'unreal-agent-live-runner',macos/'UnrealAgent']:
        run('/usr/bin/codesign','--force','--sign',identity,file)
    # The Calendar helper becomes its own responsible process for privacy
    # checks, so give it the app's identifier to match the app's Calendar grant.
    run('/usr/bin/codesign','--force','--sign',identity,'--identifier','local.unreal-agent',macos/'UnrealAgentCalendar')
    provenance['inputNodeSHA256']=provenance.pop('nodeSHA256')
    provenance['inputRunnerSHA256']=provenance.pop('runnerSHA256')
    provenance['bundledNodeSHA256']=sha(runtime/'node')
    provenance['bundledRunnerSHA256']=sha(runtime/'unreal-agent-runner')
    provenance['liveRunner']['bundledBinarySHA256']=sha(runtime/'unreal-agent-live-runner')
    live_info['binarySHA256']=provenance['liveRunner']['bundledBinarySHA256']
    live_info['officialBinarySHA256']=provenance['bundledRunnerSHA256']
    (runtime/'unreal-agent-live-runner.json').write_text(json.dumps(live_info,indent=2)+'\n')
    (resources/'BUILD-INFO.json').write_text(json.dumps(provenance,indent=2)+'\n')
    run('/usr/bin/codesign','--force','--sign',identity,bundle)
    run('/usr/bin/codesign','--verify','--deep','--strict',bundle)
    release=ROOT/'releases';release.mkdir(exist_ok=True)
    name=f'Unreal-Agent-{VERSION}-macOS-arm64'
    pkg=release/(name+'.pkg')
    # Disable bundle relocation: Installer must never find and overwrite a
    # similarly identified developer app in a different location. The source
    # Calendar Info.plist is a build input, not a second installable bundle.
    components=build/'components.plist'
    with components.open('wb') as out:plistlib.dump([{'RootRelativeBundlePath':'Unreal Agent.app','BundleIsRelocatable':False,'BundleIsVersionChecked':True,'BundleHasStrictIdentifier':True,'BundleOverwriteAction':'upgrade'}],out)
    run('/usr/bin/pkgbuild','--root',build/'payload','--component-plist',components,'--install-location','/Applications','--identifier','local.unreal-agent.installer','--version',VERSION,'--ownership','recommended',pkg)
    kit=build/name;kit.mkdir()
    shutil.copytree(bundle,kit/bundle.name,symlinks=True)
    for name2 in ('README.md','THIRD_PARTY_NOTICES.md'):shutil.copy2(ROOT/name2,kit/name2)
    shutil.copytree(ROOT/'docs',kit/'docs')
    for name2 in ('Install.command','Uninstall.command'):shutil.copy2(ROOT/'packaging'/name2,kit/name2)
    archive=release/(name+'.zip')
    run('/usr/bin/ditto','-c','-k','--sequesterRsrc','--keepParent',kit,archive)
    shutil.copy2(resources/'BUILD-INFO.json',release/'BUILD-INFO.json')
    (release/'SHA256SUMS.txt').write_text(''.join(f'{sha(p)}  {p.name}\n' for p in (pkg,archive,release/'BUILD-INFO.json')))
    print('Built releases in',release)
if __name__=='__main__':
    with (ROOT/'.build.lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        main()
