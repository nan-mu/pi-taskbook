from html import escape
import json, subprocess
from pathlib import Path
import argparse, base64, sys, tempfile
repo=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description="Render the four HTML statecharts and embed the active Pi method packets and source files.")
parser.add_argument("output", type=Path, nargs="?", default=repo.parent/'deliverables/pi-taskbook-statecharts.html')
pagefile=parser.parse_args().output
page=(repo/'tools/statecharts-template.html').read_text()
def embed(name, data, mime):
    global page
    marker='__ASSET_'+name+'__'
    assert page.count(marker)==1, marker
    page=page.replace(marker,'data:'+mime+';base64,'+base64.b64encode(data).decode('ascii'))
for file in ["taskbook.ts","project-memory.ts","reviewer.ts","design-worker.ts","index.ts","methods/magpie-memory/SKILL.md"]:
    source=repo/file
    embed(source.name, source.read_bytes(), "text/plain")
with tempfile.TemporaryDirectory() as temp:
    catalog=Path(temp)/"pi-skill-catalog.html"
    subprocess.run([sys.executable,str(repo/"tools/render-catalog.py"),str(catalog)],check=True)
    embed(catalog.name, catalog.read_bytes(), "text/html")
data_script="""
import {pinUpstreamInputs, loadUpstreamInputs} from './upstream.ts';
import {stages} from './workflow.ts';
const pins=pinUpstreamInputs();
console.log(JSON.stringify(Object.fromEntries(['new-feature','fix-feature','new-experiment','fix-experiment'].map(t=>[t,
 Object.fromEntries(stages.map(s=>[s,loadUpstreamInputs(pins,s,t)]))]))));
"""
phases=json.loads(subprocess.check_output(['node','--input-type=module','-e',data_script],cwd=repo,text=True))
for stage_map in phases.values():
 for methods in stage_map.values():
  for m in methods:
   who,part=m['source'].split('@',1); rev,path=part.split(':',1)
   owner='cursor/plugins' if who=='pstack' else 'mattpocock/skills'
   m['url']=f'https://github.com/{owner}/blob/{rev}/{path}'
   m['name'],m['text']=m['text'].split('\n',1)
   m['name']=m['name'].removeprefix('通用方法 ')
panels={'memory':['fact-check','fact-review'],'design':['design','implement'],'review':['correctness','quality','performance']}
labels={'fact-check':'事实核查 · 主会话','fact-review':'事实审核 · 独立会话','design':'设计 · 主会话与可选独立顾问','implement':'执行 · 主会话','correctness':'规格审核 · 独立会话','quality':'质量审核 · 独立会话','performance':'正式测量 · 主会话'}

for name in panels:
 start=page.index('<section',page.index('id="'+name+'"')-40)
 end=page.index('</section>',start)
 final=page.rindex('</li>',start,end)
 pos=page.rfind('</span>',start,final)
 if pos<0: pos=final
 button=f' <button class="method-open" type="button" data-methods="{name}">查看本章附加的提示词</button>'
 page=page[:pos]+button+page[pos:]
html='''<dialog id="phase-methods" aria-labelledby="method-heading"><div class="method-head"><h2 id="method-heading">本章实际附加的提示词</h2><button id="method-close" type="button">关闭</button></div>
<label>任务类型 <select id="method-kind"><option value="new-feature">新增功能</option><option value="fix-feature">修复功能</option><option value="new-experiment">新增实验</option><option value="fix-experiment">修复实验</option></select></label>
<div id="method-list"></div></dialog>'''
js='''
const methodBox=document.getElementById('phase-methods'), kind=document.getElementById('method-kind'), methodList=document.getElementById('method-list');
let chapter='';
function el(tag,text){ const n=document.createElement(tag); if(text)n.textContent=text;return n; }
function drawMethods(){ const items=[]; for(const phase of panels[chapter]){
 items.push(el('h3',labels[phase]));for(const item of packets[kind.value][phase]){const details=el('details'); details.append(el('summary',item.name),el('pre',item.text));
 const a=el('a','查看固定版本上游原文');a.href=item.url;a.rel='noreferrer';a.target='_blank';details.append(a);items.push(details);}}methodList.replaceChildren(...items);}
kind.onchange=drawMethods;
for(const b of document.querySelectorAll('[data-methods]')) b.onclick=()=>{chapter=b.dataset.methods;drawMethods();methodBox.showModal();};
document.getElementById('method-close').onclick=()=>methodBox.close();
methodBox.addEventListener('keydown',event=>event.stopPropagation());
'''
css='''.method-open{font:inherit;font-size:.85em;text-decoration:underline;color:inherit;background:none;border:0;padding:0;cursor:pointer}
#phase-methods{background:#111;color:#fff;border:1px solid #999;padding:24px;width:min(820px,90vw);max-height:80vh;overflow:auto}
#phase-methods::backdrop{background:#000b}.method-head{display:flex;align-items:center;justify-content:space-between;gap:1em}.method-head h2{margin:0}
#phase-methods button,#phase-methods select{font:inherit;background:#222;color:white;border:1px solid #aaa;padding:.25em .6em}
#phase-methods label{display:block;margin:1em 0}#phase-methods h3{margin:1.5em 0 .5em}
#phase-methods details{border-top:1px solid #444;padding:.6em .1em}#phase-methods summary{cursor:pointer}
#phase-methods pre{white-space:pre-wrap;font:inherit;line-height:1.6}#phase-methods a{color:inherit;text-decoration:underline}'''
conf='const packets='+json.dumps(phases,ensure_ascii=False).replace('<','\\u003c')+',panels='+json.dumps(panels)+',labels='+json.dumps(labels,ensure_ascii=False)+';'
page=page.replace('</style>',css+'</style>',1).replace('</body>',html+'<script>{'+conf+js+'}</script></body>')
pagefile.parent.mkdir(parents=True,exist_ok=True)
pagefile.write_text(page)
