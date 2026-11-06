# Task 001 · P5 驾驶舱 Tab 化 — 验收标准

- 基准 commit：`9efb19992f3d68f760082f0cda600c5e6d6b1ee9`
- 规格：同目录 `design.md`
- 所有命令都在**仓库根**（`C:\git\dsh-Agentline\.collab\worktrees\001`）下用 **pwsh 7** 执行；每条单独判定。“通过”指退出码 0 并且输出与期望一致。
- `node -e` 里的 JS 只用单引号、不含 `$` 和反引号，可以直接粘进 pwsh。
- 下列命令供下游 dev/review 在实现后执行，本轮 design 不执行 git、不启动会写日志的 Host、不创建测试文件。多步骤命令块由下游保存到系统临时目录的 `.ps1`（`Set-Content -Encoding utf8NoBOM`），用 `pwsh -NoProfile -File <临时脚本绝对路径>` 从仓库根运行；不要保存到仓库。原生命令后检查 `$LASTEXITCODE`，非零立即退出。验收失败不得用修改断言代替修复实现。

---

## AC-1 client.js 语法

```pwsh
node --check plugin/lib/client.js
```

期望：退出码 0，无输出。

## AC-2 index.js 语法

```pwsh
node --check plugin/lib/index.js
```

期望：退出码 0，无输出。

## AC-3 Tab 壳、首页区块与数据端点（静态）

```pwsh
node -e "const s=require('fs').readFileSync('plugin/lib/client.js','utf8');const need=['首页','Studio','Blueprint','Build','设置','项目组合','现在卡在哪','待处理','运行中','最近事件','斜杠命令','agentline.tab','overflow-x:auto','/agentline/summary','/agentline/notices','/agentline/pipeline','/agentline/catalog','/agentline/projects'];const miss=need.filter((w)=>!s.includes(w));if(miss.length){console.log('MISSING: '+miss.join(' | '));process.exit(1)}console.log('OK tabs+home')"
```

期望：退出码 0，输出 `OK tabs+home`。

## AC-4 既有任务列表 / 详情操作仍在（静态）

```pwsh
node -e "const s=require('fs').readFileSync('plugin/lib/client.js','utf8');const re=[/control\(.stop.\)/,/control\(.stop-now.\)/,/control\(.inject./,/control\(.answer./,/doMerge\(.permission.\)/,/doMerge\(.grant.\)/,/doMerge\(.check.\)/,/resumeFlow\(detail\.task\)/,/\/agentline\/control\?action=/,/\/agentline\/merge\?task=/,/\/agentline\/flow\?task=/,/\/agentline\/task. \+/,/\/agentline\/tasks. \+/,/\/agentline\/routing\?project=/,/\/agentline\/models/,/\/agentline\/live/,/K1 step ledger/,/阶段轨迹/,/执行记录/,/确认合并/,/预授权合并/,/分档检查/,/继续运行/,/原始 JSON/,/可读视图/,/designer 等待回答/,/function HeaderChips/,/function SettingsSection/,/function focusTask/];const miss=re.filter((r)=>!r.test(s)).map(String);if(miss.length){console.log('MISSING: '+miss.join(' | '));process.exit(1)}console.log('OK legacy ops')"
```

期望：退出码 0，输出 `OK legacy ops`。

## AC-5 不含 mockup 假数据（静态）

```pwsh
node -e "const s=require('fs').readFileSync('plugin/lib/client.js','utf8');const bad=['gpt-6.1-sol','claude-opus-5-5','claude-sonnet-5-5','gemini-4-argon','kimi-k3.1-pro','Shimeji','Q-03','Q-05','T-002','F-07','9f2c1a7b3d4e','静态模拟','12/12','4/9 merged'].filter((w)=>s.includes(w));if(bad.length){console.log('MOCK DATA: '+bad.join(' | '));process.exit(1)}console.log('OK no mock data')"
```

期望：退出码 0，输出 `OK no mock data`。

## AC-6 空状态 / 未实现文案（静态，对应 design.md §5）

```pwsh
node -e "const s=require('fs').readFileSync('plugin/lib/client.js','utf8');const need=['读取中…','没有需要你处理的事项。','没有已登记的项目','当前没有运行中的任务','暂无事件','这个项目还没有 Studio 记录','这个项目还没有 Blueprint 记录','状态：未开始','G1：未实现','暂无任务','选择一个任务查看详情','旧任务：无来源记录','T gate：未实现','暂无模型目录数据','暂无 Provider 数据','未实现'];const miss=need.filter((w)=>!s.includes(w));if(miss.length){console.log('MISSING: '+miss.join(' | '));process.exit(1)}console.log('OK empty states')"
```

期望：退出码 0，输出 `OK empty states`。

## AC-7 设置页迁入与斜杠命令面板（静态）

```pwsh
node -e "const s=require('fs').readFileSync('plugin/lib/client.js','utf8');const need=['角色路由 · 仅影响本项目','全局：哪些模型可以在哪些角色上使用','保存全局设置','模型目录（只读）','Provider（只读）','/agentline <目标>','/agentline --project <路径> <目标>','agentline_status','复制'];const miss=need.filter((w)=>!s.includes(w));if(miss.length||s.includes('routeOpen')){console.log('MISSING: '+miss.join(' | ')+(s.includes('routeOpen')?' | routeOpen still present':''));process.exit(1)}console.log('OK settings+slash')"
```

期望：退出码 0，输出 `OK settings+slash`（`routeOpen` 已删除）。

## AC-8 Host 路由：旧 12 条保留 + 新 2 条只读（静态）

```pwsh
node -e "const s=require('fs').readFileSync('plugin/lib/index.js','utf8');const q=String.fromCharCode(39);const names=['metrics','projects','tasks','task','merge','models','routing','live','control','summary','notices','flow','pipeline','catalog'];const miss=names.filter((n)=>!s.includes('route('+q+'/agentline/'+n+q+','));const gets=s.split('GET only').length-1;if(miss.length||gets<2){console.log('MISSING: '+miss.join(' | ')+' GET-only='+gets);process.exit(1)}console.log('OK host routes 14')"
```

期望：退出码 0，输出 `OK host routes 14`。

## AC-9 五个 Tab 都能渲染（用桩 React 实际执行 client.js）

把 client.js 装进桩 `window.__ModuleLoader__`，用最小 React 桩（hooks 只返回初值、effect 不执行、不发网络请求）通过 `apply()` 拿到 main slot 组件，分别以 `localStorage['agentline.tab']` = home/studio/blueprint/build/settings 渲染，并展开成纯文本检查。不存 tab 时默认渲染首页。

```pwsh
node -e "const fs=require('fs');const src=fs.readFileSync('plugin/lib/client.js','utf8');let factory=null;const store={};global.window={__ModuleLoader__:{load:(m)=>{factory=m.factory}},localStorage:{getItem:(k)=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v)},removeItem:(k)=>{delete store[k]}},setInterval:()=>0,clearInterval:()=>{},setTimeout:()=>0,clearTimeout:()=>{}};global.fetch=()=>Promise.reject(new Error('offline'));new Function(src)();const FRAG=Symbol('frag');class Component{constructor(p){this.props=p}}const R={Fragment:FRAG,Component,createElement:(type,props,...children)=>({type,props:props||{},children}),useState:(i)=>[typeof i==='function'?i():i,()=>{}],useEffect:()=>{},useLayoutEffect:()=>{},useRef:(v)=>({current:v}),useMemo:(f)=>f(),useCallback:(f)=>f,useReducer:(r,i)=>[i,()=>{}]};const mod=factory((n)=>{if(n==='react')return R;throw new Error('unexpected require '+n)});let main=null;mod.apply({slots:{inject:(n,f)=>f(),register:(meta,C)=>{if(meta.name==='main')main=C}},configForms:null});const text=(el)=>{if(el==null||el===false||el===true)return '';if(typeof el==='string'||typeof el==='number')return String(el);if(Array.isArray(el))return el.map(text).join(' ');const t=el.type;const kids=el.children||[];if(typeof t==='function'){if(t.prototype&&t.prototype.render)return text(kids);return text(t(Object.assign({},el.props,{children:kids})))}return text(kids)};const render=(tab)=>{for(const k of Object.keys(store))delete store[k];if(tab)store['agentline.tab']=tab;return text(R.createElement(main,{}))};const tabs=['首页','Studio','Blueprint','Build','设置'];const need={home:['现在卡在哪','项目组合','待处理','运行中','最近事件','斜杠命令'],studio:['Studio 会话'],blueprint:['Blueprint 会话'],build:['暂无任务','选择一个任务查看详情'],settings:['角色路由 · 仅影响本项目','全局：哪些模型可以在哪些角色上使用','模型目录（只读）','Provider（只读）']};const bad=[];for(const tab of Object.keys(need)){const s=render(tab);for(const w of tabs.concat(need[tab]))if(!s.includes(w))bad.push(tab+': missing '+w)}if(!render(null).includes('现在卡在哪'))bad.push('default tab is not home');if(bad.length){console.log(bad.join('\n'));process.exit(1)}console.log('OK render 5 tabs')"
```

期望：退出码 0，输出 `OK render 5 tabs`。任何异常（渲染抛错）或缺字都算失败。

同一验收项还须执行以下快照与交互检查。仅在内存中把现有命名 state 的初始化替换为夹具注入，不改产品文件、不联网；fixture 只使用 design.md 已定义的响应字段。它验证数据投影和点击目标，不声称覆盖浏览器布局或异步轮询时序。

```pwsh
$ErrorActionPreference = 'Stop'
@'
const assert = require('node:assert/strict');
const fs = require('node:fs');
let state = {}, factory, main;
global.seed = (name, initial) => {
  if (!(name in state)) state[name] = typeof initial === 'function' ? initial() : initial;
  return [state[name], v => { state[name] = typeof v === 'function' ? v(state[name]) : v; }];
};
global.window = {
  __ModuleLoader__: {load: m => { factory = m.factory; }},
  localStorage: {getItem: () => null, setItem() {}, removeItem() {}},
  setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {}
};
global.fetch = () => { throw new Error('unexpected network request'); };
const source = fs.readFileSync('plugin/lib/client.js', 'utf8').replace(
  /const\s+\[(\w+),\s*(\w+)\]\s*=\s*React\.useState\(/g,
  (_, name, setter) => 'const [' + name + ', ' + setter + '] = seed(' + JSON.stringify(name) + ', '
);
new Function(source)();
class Component { constructor(props) { this.props = props; } }
const R = {
  Component, Fragment: Symbol('fragment'),
  createElement: (type, props, ...children) => ({type, props: props || {}, children}),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {}, useLayoutEffect() {}, useRef: current => ({current}),
  useMemo: f => f(), useCallback: f => f
};
factory(n => { assert.equal(n, 'react'); return R; }).apply({slots: {
  inject: (name, f) => f(), register: (meta, C) => { if (meta.name === 'main') main = C; }
}});
assert.equal(typeof main, 'function');
const expand = el => {
  if (el == null || typeof el === 'boolean') return null;
  if (Array.isArray(el)) return el.map(expand);
  if (typeof el !== 'object') return el;
  if (typeof el.type === 'function') {
    const props = {...el.props, children: el.children};
    return expand(el.type.prototype?.render ? new el.type(props).render() : el.type(props));
  }
  return {...el, children: el.children.map(expand)};
};
const text = el => el == null ? '' : Array.isArray(el) ? el.map(text).join(' ') :
  typeof el === 'object' ? text(el.children) : String(el);
const nodes = el => !el || typeof el !== 'object' ? [] :
  Array.isArray(el) ? el.flatMap(nodes) : [el, ...nodes(el.children)];
const render = (tab, values = {}) => {
  state = {tab, project: 'A', projects: [], tasks: [], live: [],
    summary: {running: [], blocked: [], prOpen: []}, notices: [], ...values};
  return expand(R.createElement(main));
};
const has = (tree, words) => { for (const word of words) assert.ok(text(tree).includes(word), 'missing ' + word); };
const stage = {status: 'not_started', sessions: []};
const empty = {ok: true, summary: {stages: {studio: stage, blueprint: stage}, tasks: []}};
has(render('studio', {pipeline: empty}), ['这个项目还没有 Studio 记录']);
has(render('blueprint', {pipeline: empty}), ['这个项目还没有 Blueprint 记录', '状态：未开始', 'G1：未实现']);
for (const tab of ['studio', 'blueprint']) {
  const full = {ok: true, summary: {stages: {
    studio: {status: 'running', sessions: [{id: 'studio-fixture', status: 'running', updated_at: null}]},
    blueprint: {status: 'blocked', sessions: [{id: 'blueprint-fixture', status: 'blocked', updated_at: null}]}
  }, tasks: []}};
  has(render(tab, {pipeline: full}), [tab + '-fixture', tab === 'studio' ? 'running' : 'blocked']);
  const failure = render(tab, {pipeline: {ok: false, error: 'fixture-read-error'}});
  has(failure, ['fixture-read-error']);
  assert.ok(!text(failure).includes('这个项目还没有'));
}
has(render('home'), ['没有需要你处理的事项。', '暂无事件']);
has(render('settings', {catalog: {ok: true, catalog: {models: []}, discovery: null}}),
  ['暂无模型目录数据', '暂无 Provider 数据']);
has(render('settings', {catalog: {ok: false, error: 'fixture-catalog-error'}}), ['fixture-catalog-error']);
assert.ok(!text(render('settings', {catalog: {ok: false, error: 'fixture-catalog-error'}})).includes('暂无 Provider 数据'));
const catalogTree = render('settings', {catalog: {ok: true, catalog: {models: [
  {key: 'fixture-model', provider: 'fixture-provider', id: 'fixture-id', tier: 'unknown',
    identity: 'unverified', availability: 'discovered', source: 'discovery'}
]}, discovery: {generatedAt: null, providers: ['fixture-provider', 'fixture-empty-provider']}}});
has(catalogTree, ['fixture-model', 'fixture-id', 'fixture-provider', 'fixture-empty-provider', 'unverified', 'discovered']);
const projects = [
  {path: 'A', title: 'fixture-A', tasks: {total: 1, active: 0, last: 'merged'}},
  {path: 'B', title: 'fixture-B', tasks: {total: 2, active: 1, last: 'blocked'}}
];
let tree = render('home', {projects});
has(tree, ['fixture-A', 'fixture-B', 'merged', 'blocked']);
const projectRow = nodes(tree).find(n => typeof n.props?.onClick === 'function' && text(n).includes('fixture-B'));
assert.ok(projectRow, 'missing project switch');
projectRow.props.onClick();
assert.equal(state.project, 'B');
assert.equal(state.current, null);
assert.equal(state.detail, null);
tree = render('home', {projects, summary: {running: [], prOpen: [], blocked: [
  {project: 'fixture-B', projectPath: 'B', task: '002', reason: 'awaiting_human'}
]}});
const answer = nodes(tree).find(n => typeof n.props?.onClick === 'function' && text(n) === '去回答');
assert.ok(answer, 'missing answer navigation');
answer.props.onClick();
assert.equal(state.tab, 'build');
assert.equal(state.project, 'B');
assert.deepEqual(state.pendingFocus, {project: 'B', task: '002'});
console.log('OK data projection+navigation');
'@ | node -
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

期望：退出码 0，输出 `OK data projection+navigation`；空会话、已有会话、读取失败均走不同渲染分支，项目卡片切换到 B，问题卡片进入 B 的 Build 并定位任务 002。

## AC-10 Host 新路由真实执行：空项目只返回“未开始”、非 GET 拒绝、旧路由正常

用桩 ctx 调真实 `index.js` 的 `apply()`。`agentlineHome` 与两个项目都放在系统临时目录；只复制三个只读模块和已提交的基础配置，不读取本机配置、发现缓存或已登记项目。Host 初始化日志也只落在临时目录。断言 GET 前后整个隔离目录内容一致，覆盖空项目、已有会话、模型目录、拒绝写方法及旧 projects 路由。以下多步骤块按文件开头约定由下游保存为临时 `.ps1` 执行，本轮 design 不执行。

```pwsh
$ErrorActionPreference = 'Stop'
@'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const parent = fs.realpathSync(os.tmpdir());
const tmp = fs.mkdtempSync(path.join(parent, 'agl-p5-'));
const home = path.join(tmp, 'home');
const empty = path.join(tmp, 'empty');
const full = path.join(tmp, 'full');
const routes = {};
const timers = [];
const oldTimeout = globalThis.setTimeout;
const oldInterval = globalThis.setInterval;
globalThis.setTimeout = (...args) => { const t = oldTimeout(...args); timers.push(t); return t; };
globalThis.setInterval = (...args) => { const t = oldInterval(...args); timers.push(t); return t; };
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
};
const snapshot = (dir) => fs.readdirSync(dir, {withFileTypes: true})
  .sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? [[path.relative(tmp, p), 'directory'], ...snapshot(p)] :
      [[path.relative(tmp, p), fs.readFileSync(p).toString('base64')]];
  });
let failed = false;
try {
  for (const dir of [path.join(home, 'lib'), path.join(home, 'config'), empty, full])
    fs.mkdirSync(dir, {recursive: true});
  for (const name of ['pipeline.mjs', 'config.mjs', 'model-catalog.mjs'])
    fs.copyFileSync(path.resolve('orchestrator/lib', name), path.join(home, 'lib', name));
  fs.copyFileSync(path.resolve('orchestrator/config/agentline.config.json'), path.join(home, 'config/agentline.config.json'));
  const at = '2026-11-06T00:00:00.000Z';
  write(path.join(full, '.collab/studio/s1/session.json'), {status: 'running', updated_at: at});
  write(path.join(full, '.collab/blueprint/b1/state.json'), {status: 'blocked', updated_at: at});
  write(path.join(home, 'config/agentline.models.json'), {
    generatedAt: at, providers: {'fixture-provider': {models: [{id: 'fixture-model'}]}}
  });
  const ctx = {
    inject(deps, cb) {
      if (deps.includes('webServer')) cb({effect: f => f(), webServer: {
        register(r) { routes[r.path] = r.handler; }
      }});
    },
    effect() {}
  };
  const m = await import(pathToFileURL(path.resolve('plugin/lib/index.js')).href);
  m.apply(ctx, {agentlineHome: home, defaultRepo: empty});
  // 初始化后取消补投计时器，隔离测试只执行显式调用的路由。
  for (const t of timers) { clearTimeout(t); clearInterval(t); }
  const call = async (url, method = 'GET') => {
    let body;
    const res = {statusCode: 200, setHeader() {}, end(b) { body = b; }};
    await routes[url.split('?')[0]]({url, method, on() {}}, res);
    return {code: res.statusCode, json: JSON.parse(body)};
  };
  for (const name of ['metrics','projects','tasks','task','merge','models','routing','live','control','summary','notices','flow','pipeline','catalog'])
    assert.equal(typeof routes['/agentline/' + name], 'function', name);
  const before = snapshot(tmp);
  const p = await call('/agentline/pipeline?project=' + encodeURIComponent(empty));
  assert.equal(p.code, 200);
  assert.equal(p.json.ok, true);
  for (const kind of ['studio', 'blueprint'])
    assert.deepEqual(p.json.summary.stages[kind], {status: 'not_started', sessions: []});
  assert.deepEqual(p.json.summary.tasks, []);
  const f = await call('/agentline/pipeline?project=' + encodeURIComponent(full));
  assert.equal(f.json.ok, true);
  assert.deepEqual(f.json.summary.stages.studio.sessions, [{id: 's1', status: 'running', updated_at: at}]);
  assert.deepEqual(f.json.summary.stages.blueprint.sessions, [{id: 'b1', status: 'blocked', updated_at: at}]);
  const c = await call('/agentline/catalog');
  assert.equal(c.code, 200);
  assert.equal(c.json.ok, true);
  assert.ok(c.json.catalog.models.some(x => x.id === 'fixture-model'));
  assert.ok(c.json.discovery.providers.includes('fixture-provider'));
  for (const url of ['/agentline/pipeline?project=' + encodeURIComponent(empty), '/agentline/catalog']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await call(url, method);
      assert.equal(r.code, 405);
      assert.equal(r.json.ok, false);
    }
  }
  const pr = await call('/agentline/projects');
  assert.equal(pr.json.ok, true);
  assert.deepEqual(pr.json.projects.map(x => x.path), [empty]);
  assert.deepEqual(snapshot(tmp), before, 'route changed fixture files');
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  globalThis.setTimeout = oldTimeout;
  globalThis.setInterval = oldInterval;
  for (const t of timers) { clearTimeout(t); clearInterval(t); }
  const resolved = fs.realpathSync(tmp);
  assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
  assert.ok(path.basename(resolved).startsWith('agl-p5-'));
  fs.rmSync(resolved, {recursive: true, force: true});
}
if (failed) process.exit(1);
console.log('OK host routes runtime');
'@ | node --input-type=module -
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

期望：退出码 0，输出 `OK host routes runtime`。

## AC-11 orchestrator 测试

```pwsh
pwsh -NoProfile -Command 'Set-Location orchestrator; node --test; exit $LASTEXITCODE'
```

期望：退出码 0；`node --test` 汇总行包含 `# fail 0`。（本任务不改 orchestrator，这一条用来确认没有间接破坏。）

## AC-12 写入范围

```pwsh
$changed = @(git diff --name-only 9efb19992f3d68f760082f0cda600c5e6d6b1ee9)
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$expected = @('plugin/lib/client.js', 'plugin/lib/index.js', '.collab/tasks/001/brief.md', '.collab/tasks/001/design.md', '.collab/tasks/001/acceptance.md', '.collab/tasks/001/impl.md', '.gitignore')
if (@(Compare-Object ($expected | Sort-Object) ($changed | Sort-Object)).Count -ne 0) {
  throw ('Unexpected changed paths: ' + ($changed -join ', '))
}
Write-Output 'OK write scope'
```

期望：退出码 0，输出 `OK write scope`；相对既有基准恰好修改两个允许的产品文件。基准不存在或读取失败必须失败，不得改用 HEAD 规避校验。（此命令由下游执行，design 角色不执行 git。）

```pwsh
$untracked = @(git ls-files --others --exclude-standard)
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($untracked.Count -ne 0) { throw ('Unexpected untracked paths: ' + ($untracked -join ', ')) }
Write-Output 'OK no untracked files'
```

期望：退出码 0，输出 `OK no untracked files`（没有新增的未忽略文件）。front matter 的 write_scope 必须仍仅包含上述两个文件；不能为通过检查扩大范围。

---

## 人工观察（不作为自动判定，review 时在 DSH 里抽查即可）

1. 打开左栏 AgentLine：默认停在“首页”；窄窗口下 Tab 条可以横向滚动。
2. 点项目组合某一行 → 顶栏项目下拉同步切换，Build Tab 列表换成该项目的任务。
3. 对话头部 AG 灯弹层里点一个任务 → 驾驶舱切到 Build Tab 并选中该任务。
4. 在没有 `.collab/studio`、`.collab/blueprint` 的项目里，Studio/Blueprint 页显示“这个项目还没有 … 记录”，没有任何轮次、gate、示例模型名。
5. Build 详情里 ⏸ / ⏹ / note / amend / 回答 / 确认合并 / 预授权合并 / 分档检查都还在，并且能用。

