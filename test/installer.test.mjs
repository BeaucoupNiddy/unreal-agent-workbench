import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { installPlan, mergeConfig, plist, preflight } from '../packaging/launch.mjs';
test('paths with spaces and XML characters produce valid launchd plists',()=>{
 const home='/Users/A & B';const base=home+'/Applications/Unreal Agent.app/Contents/Resources';
 const plan=installPlan(home,base);
 assert.equal(plan.length,2);
 for(const service of plan){const xml=plist(service.value);const decoded=JSON.parse(execFileSync('plutil',['-convert','json','-o','-','--','-'],{input:xml,encoding:'utf8'}));assert.deepEqual(decoded,service.value);assert.equal(decoded.EnvironmentVariables.HOME,home);assert.ok(decoded.ProgramArguments[0].startsWith(base));assert.equal(decoded.KeepAlive,true);assert.ok(!xml.includes('Pat Nasty'));}
});
test('config merge preserves other agents and preferences',()=>{
 const old={agents:{other:{command:'other'}},extensions:{example:{}},synopsisModel:'custom',defaultAgent:'other'};
 const result=mergeConfig(old,'/Applications/Unreal Agent.app/Contents/Resources');
 assert.equal(result.defaultAgent,'other');assert.equal(result.synopsisModel,'custom');assert.deepEqual(result.agents.other,old.agents.other);assert.deepEqual(result.extensions,old.extensions);assert.equal(old.agents.unreal,undefined);
});
test('legacy service conflict aborts without changing files',async()=>{
 const home=await fs.mkdtemp(path.join(tmpdir(),'unreal-install-test-'));
 try{const plan=installPlan(home,'/Applications/Unreal Agent.app/Contents/Resources');await fs.mkdir(path.dirname(plan[1].file),{recursive:true});await fs.writeFile(plan[1].file,'legacy');await assert.rejects(preflight(home,'/Applications/Unreal Agent.app/Contents/Resources'),/another installation/);assert.equal(await fs.readFile(plan[1].file,'utf8'),'legacy');await assert.rejects(fs.stat(plan[0].file),{code:'ENOENT'});}finally{await fs.rm(home,{recursive:true,force:true});}
});
test('fresh and same-location installs pass, foreign agent registration fails',async()=>{
 const home=await fs.mkdtemp(path.join(tmpdir(),'unreal-install-test-'));const base='/Applications/Unreal Agent.app/Contents/Resources';
 try{assert.deepEqual(await preflight(home,base),{});await fs.mkdir(path.join(home,'.hydra-acp'));const config=path.join(home,'.hydra-acp/config.json');await fs.writeFile(config,JSON.stringify(mergeConfig({},base)));assert.equal((await preflight(home,base)).defaultAgent,'unreal');await fs.writeFile(config,JSON.stringify({agents:{unreal:{command:'/old/node',args:[]}}}));await assert.rejects(preflight(home,base),/another installation/);}finally{await fs.rm(home,{recursive:true,force:true});}
});
