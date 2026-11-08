import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../lib/client-target-ui.inc.js', import.meta.url), 'utf8');
const client = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8');
const host = { name:'fixture-cluster', host:'192.0.2.1', viaHost:'entry', allowed:true };
const configured = [{name:'profile-check',command:'hostname',expected:'configured-site'}];
function setup(callApi) {
  let cursor=0,slots=[],effects=[];
  const calls=[];
  const React={ Fragment:'fragment',createElement:(type,props,...children)=>({type,props:props||{},children}),
    useState(initial){const i=cursor++;if(!slots[i])slots[i]={value:typeof initial==='function'?initial():initial};return[slots[i].value,next=>{slots[i].value=typeof next==='function'?next(slots[i].value):next;}];},
    useRef(initial){const i=cursor++;if(!slots[i])slots[i]={current:initial};return slots[i];},
    useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((value,index)=>value!==old.deps[index]))effects.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:fn()};});},
  };
  function ModalShell(){}
  const context={React,h:React.createElement,ModalShell,TextEncoder,errorText:error=>error.message||String(error),callApi:async(method,payload)=>{calls.push({method,payload:JSON.parse(JSON.stringify(payload))});if(callApi)return callApi(method,payload);return{host:host.name,revision:3,checks:[],configuredChecks:configured,effectiveChecks:configured};}};
  vm.createContext(context);vm.runInContext(source+'\nthis.ui={TargetCheckEditor,TargetCheckField,buildTargetCheckInput};',context);
  function expand(node){if(Array.isArray(node))return node.map(expand);if(!node||typeof node!=='object')return node;if(node.type===context.ui.TargetCheckField)return expand(node.type(node.props));return{...node,children:expand(node.children)};}
  return{...context.ui,calls,render(props={host,onClose(){},onSaved(){}}){cursor=0;return expand(context.ui.TargetCheckEditor(props));},async flush(){const pending=effects;effects=[];pending.forEach(effect=>effect());for(let i=0;i<8;i++)await Promise.resolve();},unmount(){slots.forEach(slot=>slot?.cleanup?.());}};
}
function nodes(tree){if(Array.isArray(tree))return tree.flatMap(nodes);if(!tree||typeof tree!=='object')return[];return[tree,...nodes(tree.children)];}
const button=(tree,name)=>nodes(tree).find(node=>node.props?.['data-target-action']===name);
const field=(tree,name)=>nodes(tree).find(node=>node.props?.['data-target-field']===name);
const form=tree=>nodes(tree).find(node=>node.type==='form');
const text=tree=>JSON.stringify(tree,(_key,value)=>typeof value==='function'?undefined:value);
const prevent={preventDefault(){}};

test('standalone generated target editor matches source and contains no procedure controls or data requests',()=>{
  const generated=client.split('    // BEGIN GENERATED TARGET UI\n')[1]?.split('    // END GENERATED TARGET UI')[0];assert.equal(generated.trim(),source.trim());
  assert.doesNotMatch(source,/template|intent|sendConversationMessage|parameters/);
  assert.match(client,/"data-host-action": "target-checks"/);assert.match(client,/h\(TargetCheckEditor/);
});
test('empty state exposes editable check action and configured checks remain readonly',async()=>{
  const ui=setup();ui.render();await ui.flush();const tree=ui.render();assert.equal(tree.props.trapFocus,true);assert.ok(button(tree,'add'));assert.match(text(tree),/profile-check/);assert.match(text(tree),/只读，不能在此移除/);assert.equal(ui.calls[0].method,'target.get');
  assert.equal(nodes(tree).some(node=>node.props?.['data-target-field']==='profile-check'),false);
});
test('save uses only current logical host, expected revision and managed checks; no probe or execution',async()=>{
  const ui=setup();ui.render();await ui.flush();let tree=ui.render();button(tree,'add').props.onClick();tree=ui.render();
  for(const [key,value] of [['name','logical-user'],['command','id -un'],['expected','ops']])field(tree,'0-'+key).props.onChange({target:{value}});
  tree=ui.render();await form(tree).props.onSubmit(prevent);assert.deepEqual(ui.calls.map(call=>call.method),['target.get','target.save']);assert.deepEqual(ui.calls[1].payload,{host:'fixture-cluster',expectedRevision:3,checks:[{name:'logical-user',command:'id -un',expected:'ops'}]});
});
test('clearing managed rows never sends configured checks for deletion',async()=>{
  const ui=setup();ui.render();await ui.flush();await form(ui.render()).props.onSubmit(prevent);assert.deepEqual(ui.calls[1].payload.checks,[]);assert.deepEqual(configured,[{name:'profile-check',command:'hostname',expected:'configured-site'}]);
});
test('pending save synchronously blocks double clicks and dialog closing',async()=>{
  let release,closed=0,saved=0;const pending=new Promise(resolve=>{release=resolve});const ui=setup(method=>method==='target.get'?{host:host.name,revision:3,checks:[],configuredChecks:configured}:pending);const props={host,onClose(){closed++},onSaved(){saved++}};
  ui.render(props);await ui.flush();let tree=ui.render(props);const first=form(tree).props.onSubmit(prevent);await form(tree).props.onSubmit(prevent);tree.props.onClose();assert.equal(closed,0);assert.equal(ui.calls.length,2);tree=ui.render(props);assert.equal(button(tree,'save').props.disabled,true);assert.equal(button(tree,'cancel').props.disabled,true);release({host:host.name});await first;assert.equal(saved,1);
});
test('failed or wrong-host reads cannot enable saving; errors have explicit retry',async()=>{
  for(const result of [Error('unavailable'),{host:'wrong-host',revision:3,checks:[],configuredChecks:[]}]){
    const ui=setup(async()=>{if(result instanceof Error)throw result;return result;});ui.render();await ui.flush();const tree=ui.render();assert.equal(button(tree,'save').props.disabled,true);assert.ok(button(tree,'reload'));await form(tree).props.onSubmit(prevent);assert.equal(ui.calls.length,1);
  }
});
test('validation errors are linked to labeled fields and no helper text repeats inside labels',async()=>{
  const ui=setup();ui.render();await ui.flush();let tree=ui.render();button(tree,'add').props.onClick();tree=ui.render();await form(tree).props.onSubmit(prevent);tree=ui.render();const invalid=field(tree,'0-name');assert.equal(invalid.props['aria-invalid'],true);assert.match(invalid.props['aria-describedby'],/-error/);const label=nodes(tree).find(node=>node.type==='label'&&node.props.htmlFor===invalid.props.id);assert.ok(label);assert.equal(nodes(label).some(node=>node.type==='input'||node.type==='textarea'),false);assert.equal(ui.calls.length,1);
});
test('input validation preserves exact expected values and rejects controls, duplicate names and byte overflow',()=>{
  const ui=setup();const rows=[{name:'target',command:'hostname',expected:' site-a\nsite-b\n'}];assert.equal(ui.buildTargetCheckInput(rows)[0].expected,rows[0].expected);
  for(const input of [[{name:'x',command:'hostname\nid',expected:'a'}],[{name:'x',command:'hostname',expected:'\r'}],[{name:'x',command:'hostname',expected:'界'.repeat(2000)}],[{name:'x',command:'hostname',expected:'a'},{name:'x',command:'id -un',expected:'ops'}]])assert.throws(()=>ui.buildTargetCheckInput(input));
});
test('removed page controls are absent in actual lazy bundle while host detail opens independent editor',()=>{
  let registration,cursor=0;const states=[{hosts:[host],sessions:[],audit:[],live:{enabled:false}}];
  const React={createElement:(type,props,...children)=>({type,props:props||{},children}),useState(initial){const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return[states[i],next=>{states[i]=typeof next==='function'?next(states[i]):next;}];},useRef:value=>({current:value}),useEffect(){},useLayoutEffect(){},useCallback:fn=>fn,useMemo:fn=>fn()};
  const instrumented=client.replace('    return plugin;','    return {RemoteOpsPage,TargetCheckEditor};');assert.notEqual(instrumented,client);vm.runInNewContext(instrumented,{TextEncoder,window:{__ModuleLoader__:{load(value){registration=value;}}}},{timeout:1000});const api=registration.factory(name=>{assert.equal(name,'react');return React;});
  const render=()=>{cursor=0;return api.RemoteOpsPage();};let tree=render();assert.doesNotMatch(text(tree),/模板|下一步/);const target=nodes(tree).find(node=>node.props?.['data-host-action']==='target-checks');assert.ok(target);target.props.onClick();tree=render();const editor=nodes(tree).find(node=>node.type===api.TargetCheckEditor);assert.equal(editor.props.host.name,host.name);
});
