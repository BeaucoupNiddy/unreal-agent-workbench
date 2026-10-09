#!/usr/bin/env python3
"""Refresh the distributable source from a development checkout; allowlisted only."""
import shutil
from pathlib import Path
root=Path(__file__).resolve().parents[2]
dest=root/'distribution/source'
for component in ('agent-console','unreal-agent-acp','hydra-gateway','apple-productivity-mcp','harness-chat'):
    folder=dest/component
    if folder.exists(): shutil.rmtree(folder)
    for source in (root/component).rglob('*'):
        relative=source.relative_to(root/component)
        if any(p.startswith('.') or p in ('node_modules','__pycache__','build','runtime') for p in relative.parts): continue
        if not source.is_file() or source.name.startswith('README') or source.suffix not in ('.mjs','.js','.json','.html','.css','.svg','.webmanifest','.jxa','.swift','.plist','.sh',''): continue
        target=folder/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
# The small CLI extension is source, not a vendored upstream harness or binary.
folder=dest/'live-runner'
if folder.exists(): shutil.rmtree(folder)
folder.mkdir()
for name in ('build.py','runner.patch','live_input.go','live_input_test.go','README.md'):
    shutil.copy2(root/'live-runner'/name,folder/name)
print('Updated distribution/source with application code only.')
