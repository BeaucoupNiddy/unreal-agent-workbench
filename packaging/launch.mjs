import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const resources = path.dirname(fileURLToPath(import.meta.url));
export const labels = ['local.unreal-agent.hydra', 'local.unreal-agent.agent-console'];
const escapeXML = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export function plist(value) {
  const encode = v => Array.isArray(v) ? `<array>${v.map(encode).join('')}</array>` : typeof v === 'object' ? `<dict>${Object.entries(v).map(([k,x])=>`<key>${escapeXML(k)}</key>${encode(x)}`).join('')}</dict>` : typeof v === 'boolean' ? `<${v}/>` : typeof v === 'number' ? `<integer>${v}</integer>` : `<string>${escapeXML(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">${encode(value)}</plist>\n`;
}
export function installPlan(home, base) {
  const source = path.join(base,'source');
  const env = { HOME:home, PATH:`${base}/runtime/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HYDRA_ACP_HOME:path.join(home,'.hydra-acp'), UNREAL_AGENT_RUNNER:path.join(base,'runtime/bin/unreal-agent-runner'), UNREAL_AGENT_LIVE_RUNNER:path.join(base,'runtime/bin/unreal-agent-live-runner'), UNREAL_CALENDAR_HELPER:path.resolve(base,'../MacOS/UnrealAgentCalendar') };
  return labels.map((label,i) => ({file:path.join(home,'Library/LaunchAgents',`${label}.plist`), value:{Label:label, ProgramArguments:[path.join(base,'runtime/bin/node'),path.join(source,i ? 'agent-console/server.mjs':'hydra-gateway/node_modules/@hydra-acp/cli/dist/daemon.js')], WorkingDirectory:source, EnvironmentVariables:env,RunAtLoad:true,KeepAlive:true,ThrottleInterval:5,StandardOutPath:path.join(home,'Library/Logs',`${label}.log`),StandardErrorPath:path.join(home,'Library/Logs',`${label}.log`)}}));
}
export function mergeConfig(previous, base) {
  return {...previous, agents:{...previous.agents,unreal:{command:path.join(base,'runtime/bin/node'),args:[path.join(base,'source/unreal-agent-acp/bin/unreal-agent-acp.mjs')]}}, defaultAgent:previous.defaultAgent || 'unreal'};
}
async function readJSON(file, fallback={}) {try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
async function atomicJSON(file, value) {await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await fs.rename(tmp,file);}
export async function preflight(home, base) {
  // Check BOTH services before writing anything; never replace a developer install.
  for (const item of installPlan(home,base)) {
    try {const text=await fs.readFile(item.file,'utf8');if(!text.includes(escapeXML(base))) throw new Error(`An existing Unreal Agent service uses another installation: ${item.file}. Stop its tasks and follow the migration guide before installing this copy.`);}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  const config=await readJSON(path.join(home,'.hydra-acp/config.json'));
  const agent=config.agents?.unreal;
  if(agent && (agent.command!==path.join(base,'runtime/bin/node') || agent.args?.[0]!==path.join(base,'source/unreal-agent-acp/bin/unreal-agent-acp.mjs'))) throw new Error('An existing Hydra Unreal agent points to another installation. Follow docs/MIGRATION.md before switching.');
  return config;
}
async function main() {
  const home=homedir();
  if(process.argv.includes('--plan')) {console.log(JSON.stringify(installPlan(home,resources),null,2));return;}
  if(process.platform!=='darwin')throw new Error('This release requires macOS.');
  if(!resources.startsWith('/Applications/') && !resources.startsWith(path.join(home,'Applications')+'/')) throw new Error('Install Unreal Agent.app into Applications using the installer before opening it.');
  const old=await preflight(home,resources);
  if(process.argv.includes('--preflight'))return;
  const domain=`gui/${process.getuid()}`;
  // A registered legacy service can exist even when its plist was removed.
  for(const label of labels){try{const {stdout}=await exec('/bin/launchctl',['print',`${domain}/${label}`]);if(!stdout.includes(resources))throw new Error('A different Unreal Agent service is already loaded. See the migration guide.');}catch(e){if(!Number.isInteger(e.code))throw e;}}
  const configFile=path.join(home,'.hydra-acp/config.json');
  if(Object.keys(old).length)await fs.copyFile(configFile,configFile+'.before-installer').catch(()=>{});
  await atomicJSON(configFile,mergeConfig(old,resources));
  await fs.mkdir(path.join(home,'Library/Logs'),{recursive:true});
  for(const item of installPlan(home,resources)) {
    await fs.mkdir(path.dirname(item.file),{recursive:true});
    await fs.writeFile(item.file,plist(item.value),{mode:0o600});
    try{await exec('/bin/launchctl',['print',`${domain}/${item.value.Label}`]);}catch{await exec('/bin/launchctl',['bootstrap',domain,item.file]);}
    // Reopening the Dock window must not interrupt an active agent task.
    // A newly bootstrapped RunAtLoad service starts automatically.

  }
  let detail='Services are starting';
  for(let attempt=0;attempt<60;attempt++) {
    try{const response=await fetch('http://127.0.0.1:4318/api/status',{signal:AbortSignal.timeout(2000)});const status=await response.json();if(!status.ready)throw new Error(status.error||'Backend is not ready');if(!process.argv.includes('--check'))return;}catch(e){detail=e.message;await new Promise(resolve=>setTimeout(resolve,500));}
  }
  throw new Error(`Startup failed: ${detail}. See ~/Library/Logs/local.unreal-agent.*.log.`);
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
