import assert from 'node:assert/strict';
import test from 'node:test';
import { createShellTools } from '../../lib/terminal/tools.js';
import { createApprovalGate } from '../../lib/approval.js';
import { createTargetController } from '../../lib/target-controller.js';
import { normalizeConfig } from '../../lib/config.js';
import { targetConnectionDigest, targetChecksDigest } from '../../lib/target-binding.js';

const check = { name:'identity', command:'hostname', expected:'fixture' };
function setup({ controller = true, config = {}, onApproval, onDecision, onRefresh, inputHost, sendError } = {}) {
  const cfg = normalizeConfig({ includeSshConfig:false, policy:'always', ...config });
  const state = { host: inputHost || { id:'config:fixture', name:'fixture', host:'192.0.2.1', port:22, username:'ops' }, managed:[], allowed:true, readonly:false, descriptor:null };
  const bound = targetConnectionDigest(state.host);
  const counts = { sends:[], approvals:[], dispatches:[], guarded:[], refresh:0, inventory:0, live:[] };
  const signal = new AbortController(); const exec = { agent:{id:'owner'}, callId:'input-call', signal:signal.signal };
  const hosts = {
    list:async()=>{ counts.inventory++; return [state.host]; },
    find:async()=>state.host,
    isAllowed:()=>state.allowed,
    isReadonly:host=>state.readonly || host.readonly === true,
  };
  const manager = {
    describe:()=>({ sessionId:'pty-1', host:'fixture', status:{kind:'running'}, connectionDigest:state.descriptor ?? bound }),
    send:async request=>{ counts.sends.push(request); if(sendError) throw sendError; return { viewport:'private-server-viewport', waitReason:'inferred_idle', sessionStatus:{kind:'running'}, truncated:false }; },
  };
  const gate = createApprovalGate({ config:cfg, ctx:{get:()=>({request:async request=>{counts.approvals.push(request);if(onApproval) await onApproval({cfg,state,counts,signal});return 'allowed-once';}})} });
  const approval = { ...gate, authorize:async request=>{const result=await gate.authorize(request);if(onDecision) await onDecision({cfg,state,counts,signal,result});return result;} };
  const refresh = async()=>{counts.refresh++;if(onRefresh)await onRefresh({cfg,state,counts,signal});};
  const actual = createTargetController({ config:cfg, transport:{}, approval, hosts, manager, managedChecks:()=>state.managed, refreshManaged:refresh });
  const targets = { refresh:actual.refresh, checksFor:actual.checksFor,
    ...(controller ? {dispatchCheck:async request=>{counts.dispatches.push(request);return actual.dispatchCheck(request);}} : {}),
    execute:async request=>{counts.guarded.push(request);return {code:0,stdout:'verified',targetEvidence:{status:'passed'},truncated:false};},
  };
  const live = {begin:entry=>{counts.live.push(entry);return {note:()=>{},end:entry=>counts.live.push(entry)};}};
  const tools = createShellTools({defineTool:definition=>definition,config:cfg,manager,approval,hosts,targets,live});
  const send = args=>tools.find(tool=>tool.name==='remote_shell_send').execute({sessionId:'pty-1',...args},exec);
  return {cfg,state,counts,send,signal,bound,targets};
}

for(const controller of [true,false]) for(const submitted of [true,false]) {
  const variant = `${controller?'controller':'fallback'} ${submitted?'submitted':'raw'}`;
  const input = submitted ? {text:'hostname'} : {text:'\u0003',submit:false};
  for(const [name, mutate] of [
    ['managed checks activated',({state})=>{state.managed=[check];}],
    ['configured checks activated',({cfg})=>{cfg.profiles.push({name:'new-target',hosts:['fixture'],targetChecks:[check]});}],
    ['SSH host changed in-place',({state})=>{state.host.host='192.0.2.2';}],
    ['SSH user changed',({state})=>{state.host={...state.host,username:'different'};}],
    ['readonly lock activated',({state})=>{state.readonly=true;}],
    ['never policy activated',({cfg})=>{cfg.policy='never';}],
    ['allowlist revoked',({state})=>{state.allowed=false;}],
    ['command deny added',({cfg})=>{cfg.denyCommandPatterns.push('hostname|Raw interactive input');}],
  ]) {
    test(`${variant}: ${name} during approval causes zero sends, never an upgraded guard`,async()=>{
      const f=setup({controller,onApproval:mutate});
      await assert.rejects(f.send(input));assert.equal(f.counts.sends.length,0);assert.equal(f.counts.guarded.length,0);
      assert.equal(f.counts.approvals.length,1);if(controller&&f.counts.dispatches.length)assert.equal(f.counts.dispatches[0].approvedOnce,true);
    });
  }
  test(`${variant}: stable one-shot approval dispatches once with pinned hashes`,async()=>{
    const f=setup({controller});await f.send(input);assert.equal(f.counts.sends.length,1);assert.equal(f.counts.approvals.length,1);assert.equal(f.counts.guarded.length,0);
    assert.ok(f.counts.inventory>=2);if(controller){assert.equal(f.counts.dispatches[0].expectedChecksHash,targetChecksDigest([]));assert.equal(f.counts.dispatches[0].expectedConnectionDigest,f.bound);assert.equal(f.counts.dispatches[0].ptyInput,true);assert.equal(f.counts.dispatches[0].approvedOnce,true);}
  });
}

for(const controller of [true,false]) {
  test(`${controller?'controller':'fallback'}: allow-to-ask drift cannot use an unapproved gray command`,async()=>{
    const f=setup({controller,config:{policy:'auto'},onDecision:({cfg})=>{cfg.unprovenCommands='ask';}});
    await assert.rejects(f.send({text:'mystery-tool --inspect'}),{code:'DENIED'});assert.equal(f.counts.sends.length,0);assert.equal(f.counts.approvals.length,0);
  });
  test(`${controller?'controller':'fallback'}: auto-to-always drift cannot reuse a no-approval readonly decision`,async()=>{
    const f=setup({controller,config:{policy:'auto'},onDecision:({cfg})=>{cfg.policy='always';}});
    await assert.rejects(f.send({text:'hostname'}),{code:'DENIED'});assert.equal(f.counts.sends.length,0);assert.equal(f.counts.approvals.length,0);
  });
  test(`${controller?'controller':'fallback'}: configured shortcut action route change is not reinitialized or sent`,async()=>{
    const inputHost={id:'config:fixture',name:'fixture',host:'192.0.2.1',username:'ops',viaHost:'entry',actions:[{type:'command',value:'login fixture'}]};
    const f=setup({controller,inputHost,onApproval:({state})=>{state.host.actions[0].value='login other';}});
    await assert.rejects(f.send({text:'hostname'}),{code:'TARGET_CONNECTION_CHANGED'});assert.equal(f.counts.sends.length,0);
  });
}

test('guarded initial route passes immutable checks/connection hashes and never falls back',async()=>{
  const f=setup({config:{profiles:[{name:'guard',hosts:['fixture'],targetChecks:[check]}]}});
  await f.send({text:'hostname'});assert.equal(f.counts.sends.length,0);assert.equal(f.counts.guarded.length,1);assert.equal(f.counts.approvals.length,0);
  assert.equal(f.counts.guarded[0].expectedChecksHash,targetChecksDigest([check]));assert.equal(f.counts.guarded[0].expectedConnectionDigest,f.bound);
});
test('raw initial guarded route is rejected before any approval or dispatch',async()=>{
  const f=setup({config:{profiles:[{name:'guard',hosts:['fixture'],targetChecks:[check]}]}});
  await assert.rejects(f.send({text:'\u0003',submit:false}),{code:'TARGET_PARTIAL_INPUT'});assert.equal(f.counts.sends.length,0);assert.equal(f.counts.approvals.length,0);
});
test('mutated PTY descriptor rejects input even if logical host and target hash stay unchanged',async()=>{
  const f=setup({onApproval:({state})=>{state.descriptor='changed-connection';}});
  await assert.rejects(f.send({text:'hostname'}),{code:'TARGET_CONNECTION_CHANGED'});assert.equal(f.counts.sends.length,0);
});
test('a stale initial PTY-to-host route is rejected before approval',async()=>{
  const f=setup();f.state.host.host='192.0.2.9';await assert.rejects(f.send({text:'hostname'}),{code:'TARGET_CONNECTION_CHANGED'});assert.equal(f.counts.approvals.length,0);assert.equal(f.counts.sends.length,0);
});
test('raw live output and errors omit raw bytes and opaque program output',async()=>{
  const f=setup({sendError:Error('private-server-viewport raw-private-marker')});
  await assert.rejects(f.send({text:'raw-private-marker',submit:false}));const mirrored=JSON.stringify(f.counts.live);
  assert.ok(!mirrored.includes('raw-private-marker'));assert.ok(!mirrored.includes('private-server-viewport'));assert.match(mirrored,/raw input omitted/);assert.equal('onData' in f.counts.sends[0],false);
});
test('C0/DEL in submitted text and hidden Enter in raw input are rejected before host resolution',async()=>{
  const f=setup();for(const args of [{text:'echo safe\u0015touch marker'},{text:'echo\rhostname'},{text:'echo\u007f'},{text:'\r',submit:false},{text:'\n',submit:false}])await assert.rejects(f.send(args),{code:'SHELL_INPUT_INVALID'});
  assert.equal(f.counts.approvals.length,0);assert.equal(f.counts.sends.length,0);assert.equal(f.counts.refresh,0);
});
test('invalid submit modes cannot be approved as raw while manager would add Enter',async()=>{
  const f=setup();for(const submit of [0,1,'false',null])await assert.rejects(f.send({text:'hostname',submit}),{code:'SHELL_INPUT_INVALID'});assert.equal(f.counts.approvals.length,0);assert.equal(f.counts.sends.length,0);
});
test('aborting during one-shot approval causes zero input writes',async()=>{
  const f=setup({onApproval:({signal})=>signal.abort()});await assert.rejects(f.send({text:'hostname'}),{name:'AbortError'});assert.equal(f.counts.sends.length,0);
});
