"""Render the pinned Pi method catalogs into a self-contained HTML file."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT.parent / "deliverables" / "pi-skill-catalog.html"


def load_entries():
    entries = []
    for owner in ("pstack", "matt"):
        document = json.loads((ROOT / "method-catalogs" / f"{owner}.json").read_text())
        remote = document["repo"]
        if not remote.startswith("https://"):
            remote = f"https://github.com/{remote}"
        prefix = f"{remote}/blob/{document['commit']}/"
        for collection in ("skills", "playbooks", "automationSkills"):
            for row in document.get(collection, []):
                playbook = collection == "playbooks"
                group = {"playbooks": ["poteto-mode"], "automationSkills": ["benny"]}.get(collection, [])
                entry_id = ":".join([owner, *group, row["name"]])
                entries.append({
                    **row, "owner": owner, "id": entry_id, "playbook": playbook, "collection": collection,
                    "commit": document["commit"], "source": prefix + row["path"],
                    "references": [{"label": path.rsplit("/", 1)[-1], "link": prefix + path}
                                   for path in row.get("references", [])],
                })
    if len(entries) != len({row["id"] for row in entries}):
        raise ValueError("Duplicate catalog identifiers")
    return entries


PAGE = r'''<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>Pi 任务书插件 · 方法目录</title>
    <style>
      :root {
        --ink: #172922;
        --muted: #52675d;
        --green: #075943;
        --line: #cad5cc;
        --canvas: #f5f6ef;
        --paper: #fffefa;
        --tint: #e4eee5;
        --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Consolas, monospace;
        font-family:
          "Source Sans 3",
          system-ui,
          -apple-system,
          "PingFang SC",
          "Microsoft YaHei",
          sans-serif;
        color: var(--ink);
        background: var(--canvas);
        font-size: 16px;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
      }
      a {
        color: var(--green);
        text-underline-offset: 0.2em;
      }
      button,
      select,
      input {
        font: inherit;
      }
      input,
      select,
      button {
        color: var(--ink);
      }
      button {
        cursor: pointer;
      }
      button:focus-visible,
      a:focus-visible,
      input:focus-visible,
      select:focus-visible,
      [tabindex]:focus-visible {
        outline: 3px solid #ac5a17;
        outline-offset: 2px;
      }
      header {
        background: #132f26;
        color: #fff;
        padding: 22px max(calc((100% - 1430px) / 2), 4vw) 27px;
        border-bottom: 4px solid #a1ce75;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 9px;
        font-size: 0.82rem;
        color: #d4e4cc;
      }
      .brand svg {
        width: 22px;
        height: 22px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.6;
      }
      h1 {
        font-size: clamp(1.85rem, 4vw, 2.9rem);
        letter-spacing: -0.035em;
        margin: 7px 0 8px;
        font-weight: 630;
      }
      .summary {
        color: #e0e9de;
        font-size: 0.92rem;
        line-height: 1.55;
      }
      .shell {
        width: min(1430px, 92vw);
        margin: 0 auto;
      }
      .filters {
        display: grid;
        grid-template-columns: minmax(190px, 2.5fr) repeat(4, minmax(110px, 1fr)) auto;
        gap: 12px;
        align-items: end;
        padding: 18px 0;
        border-bottom: 1px solid var(--line);
      }
      label {
        display: block;
        color: var(--muted);
        font-weight: 600;
        font-size: 0.78rem;
      }
      .filters input,
      .filters select,
      .reset {
        width: 100%;
        border: 1px solid #aebfb2;
        border-radius: 5px;
        background: var(--paper);
        min-height: 40px;
        padding: 6px 9px;
        margin-top: 4px;
        font-size: 0.87rem;
      }
      .reset {
        color: var(--green);
        background: transparent;
      }
      main {
        display: grid;
        grid-template-columns: minmax(240px, 29%) minmax(0, 1fr);
        gap: 25px;
        align-items: start;
        padding: 16px 0 40px;
      }
      .index {
        border: 1px solid var(--line);
        background: var(--paper);
        border-radius: 6px;
        overflow: hidden;
      }
      .indexHead {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 11px 14px;
        background: #e8ede5;
        font-size: 0.84rem;
        font-weight: bold;
      }
      .num {
        font: 600 0.8rem var(--mono);
        color: var(--green);
      }
      .list {
        height: min(69vh, 860px);
        overflow: auto;
        overscroll-behavior: contain;
      }
      .record {
        width: 100%;
        background: none;
        border: 0;
        border-bottom: 1px solid #e4e8df;
        padding: 10px 14px;
        display: grid;
        gap: 5px;
        text-align: left;
      }
      .record:hover {
        background: #f0f4ea;
      }
      .record[aria-current="true"] {
        background: #dcebdc;
        box-shadow: inset 4px 0 var(--green);
      }
      .name {
        font: 570 0.94rem var(--mono);
        overflow-wrap: anywhere;
      }
      .line {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        font-size: 0.73rem;
        color: var(--muted);
      }
      .record[aria-current="true"] .name {
        color: #124a32;
      }
      .detail {
        min-height: 440px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--paper);
        padding: clamp(18px, 3vw, 38px);
      }
      .meta {
        display: flex;
        gap: 7px;
        align-items: center;
        flex-wrap: wrap;
        font-size: 0.79rem;
        color: var(--muted);
      }
      .tag {
        border: 1px solid var(--line);
        padding: 2px 8px;
        border-radius: 4px;
      }
      .state {
        background: var(--tint);
        color: var(--green);
      }
      h2 {
        font: 600 clamp(1.35rem, 3vw, 2.05rem) var(--mono);
        letter-spacing: -0.035em;
        margin: 13px 0 8px;
        color: #172c23;
        overflow-wrap: anywhere;
      }
      .linkbar {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
        font-size: 0.83rem;
        color: var(--muted);
        margin: 12px 0 22px;
      }
      .linkbar code {
        font: inherit;
        font-family: var(--mono);
      }
      .panel {
        border-top: 1px solid var(--line);
        padding: 16px 0 0;
        margin-top: 17px;
      }
      .panel h3,
      h3 {
        font-size: 1rem;
        margin: 0 0 8px;
        font-weight: 690;
      }
      .panel p {
        margin: 0;
        line-height: 1.8;
        white-space: pre-line;
        overflow-wrap: anywhere;
      }
      .prompt {
        padding: 16px 19px;
        border-left: 3px solid #48885a;
        background: #f0f4e9;
      }
      .prompt p {
        font-size: 1.02rem;
      }
      .versions {
        display: flex;
        gap: 5px;
        flex-wrap: wrap;
        margin: 10px 0;
      }
      .versions button {
        border: 1px solid var(--line);
        border-radius: 4px;
        background: var(--paper);
        padding: 4px 9px;
        font-size: 0.8rem;
      }
      .versions button[aria-pressed="true"] {
        background: var(--green);
        color: #fff;
        border-color: var(--green);
      }
      .refs {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 16px;
        font: 0.84rem var(--mono);
      }
      .empty {
        padding: 20px;
        color: var(--muted);
        line-height: 1.65;
      }
      .stage {
        display: inline-block;
        color: var(--green);
        font-size: 0.77rem;
        margin-right: 7px;
      }
      .sr {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
      }
      .countnote {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 0.78rem;
        line-height: 1.6;
      }
      @media (max-width: 1000px) {
        .filters {
          grid-template-columns: repeat(4, minmax(0, 1fr));
        }
        .search {
          grid-column: span 3;
          grid-row: 1;
        }
        .reset {
          grid-column: 4;
          grid-row: 1;
        }
        main {
          gap: 14px;
        }
      }
      @media (max-width: 690px) {
        .shell {
          width: 94%;
        }
        header {
          padding: 15px 3% 17px;
        }
        .filters {
          grid-template-columns: 1fr 1fr;
          gap: 6px;
          padding: 12px 0;
        }
        .search {
          grid-column: 1;
        }
        .reset {
          grid-column: 2;
        }
        .filters input,
        .filters select,
        .reset {
          min-height: 36px;
        }
        main {
          grid-template-columns: 1fr;
          padding-top: 10px;
        }
        .list {
          max-height: 175px;
        }
        .detail {
          min-height: 260px;
        }
        .record {
          padding: 7px 12px;
          gap: 2px;
        }
        .indexHead {
          padding: 7px 12px;
        }
        .panel {
          margin-top: 14px;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="brand">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="m3 6 8-3 10 3-9 4zM3 11l9 4 9-4M3 16l9 4 9-4" /></svg
        ><span>Pi 任务书插件</span>
      </div>
      <h1>方法目录</h1>
      <div class="summary" id="summary"></div>
    </header>
    <div class="shell">
      <div class="filters" role="search" aria-label="筛选方法">
        <label class="search"
          >搜索<input id="q" type="search" placeholder="搜索方法名、提示词或适用条件" /></label
        ><label
          >来源<select id="owner">
            <option value="">全部来源</option>
            <option value="pstack">PStack</option>
            <option value="matt">Matt</option>
          </select></label
        ><label
          >阶段<select id="stage">
            <option value="">全部阶段</option>
          </select></label
        ><label
          >类型<select id="kind">
            <option value="">全部类型</option>
            <option value="method">任务提示词</option>
            <option value="mixed">流程及提示词</option>
          </select></label
        ><label
          >迁移状态<select id="status">
            <option value="">全部状态</option>
            <option value="integrated">已纳入方法</option>
            <option value="partial">部分迁移</option>
            <option value="callable">可按阶段调用</option>
            <option value="roles">有角色版本</option>
          </select></label
        ><button class="reset" id="reset" type="button">清除筛选</button>
      </div>
      <main>
        <nav class="index" aria-label="条目目录">
          <div class="indexHead">
            <span>匹配条目</span><span id="matches" class="num" aria-live="polite"></span>
          </div>
          <div class="list" id="list"></div>
        </nav>
        <article class="detail" id="detail" aria-label="方法详情"></article>
      </main>
    </div>
    <script id="catalog" type="application/json">
      ___DATA___
    </script>
    <script>
      "use strict";
      const rows = JSON.parse(document.querySelector("#catalog").textContent);
      const stages = {
        intake: "接受任务书",
        fact: "事实核查",
        design: "设计",
        experiment: "实验",
        implement: "执行",
        escalate: "阻塞升级",
        review: "独立审核",
        memory: "事实与术语",
        exit: "退出",
      };
      const owners = { pstack: "PStack", matt: "Matt" },
        kinds = { method: "任务提示词", mixed: "流程及提示词", workflow: "流程" },
        statuses = { integrated: "已纳入方法", partial: "部分迁移", excluded: "已排除" },
        roles = {
          "fact-check": "事实核查",
          implement: "执行",
          "fact-review": "事实审核",
          correctness: "规格审核",
          quality: "质量审核",
        };
      const $ = (id) => document.getElementById(id);
      function el(tag, cls = "", value = "") {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        n.textContent = value;
        return n;
      }
      function link(label, href) {
        const a = el("a", "", label);
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        return a;
      }
      function callable(r) {
        return (
          !r.playbook && r.kind !== "workflow" && r.status !== "excluded" && Boolean(r.adaptation.trim())
        );
      }
      function tag(label, cls = "") {
        return el("span", "tag " + cls, label);
      }
      function statusText(r) {
        return statuses[r.status];
      }
      const pstackCount = rows.filter(r => r.owner === "pstack").length;
      $("summary").textContent =
        `随包编审方法 ${rows.length} 项（PStack ${pstackCount}，Matt ${rows.length - pstackCount}）。`;
      function typeLabel(r) {
        if (r.playbook) return "内嵌 playbook";
        if (r.collection === "automationSkills") return "Benny 自动化包";
        return kinds[r.kind];
      }
      function matchesType(r, kind) {
        if (!kind) return true;
        if (kind === "playbook") return r.playbook;
        if (kind === "automationSkills") return r.collection === kind;
        return r.collection === "skills" && r.kind === kind;
      }
      for (const [key, value] of Object.entries(stages)) $("stage").add(new Option(value, key));
      const searchText = new Map(
        rows.map((r) => [
          r.id,
          [
            r.id,
            r.name,
            r.path,
            typeLabel(r),
            r.applies,
            r.adaptation,
            r.reason,
            r.omissions,
            owners[r.owner],
            ...r.stage.map((s) => stages[s]),
            ...Object.values(r.roleAdaptations || {}),
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase(),
        ]),
      );
      const criteria = ["q", "owner", "stage", "kind", "status"];
      const readHash = () => {
        try {
          return decodeURIComponent(location.hash.slice(1));
        } catch {
          return "";
        }
      };
      let selected = readHash() || "matt:code-review";
      let shownRole = "";
      function selectedURL(id) {
        const url = new URL(location.href);
        url.hash = id;
        return url.href;
      }
      function select(id, fromClick) {
        selected = id;
        shownRole = "";
        if (fromClick) history.replaceState(null, "", selectedURL(id));
        draw();
      }
      function section(title, body, cls = "") {
        const s = el("section", "panel " + cls);
        s.append(el("h3", "", title), el("p", "", body));
        return s;
      }
      function detail(r) {
        const d = $("detail");
        d.replaceChildren();
        if (!r) {
          d.append(el("h2", "", "无匹配条目"), el("p", "empty", "请减少筛选条件或更换搜索词。"));
          return;
        }
        const meta = el("div", "meta");
        meta.append(
          tag(owners[r.owner]),
          tag(typeLabel(r)),
          tag(statusText(r), "state"),
        );
        if (r.distribution) meta.append(el("span", "", r.distribution));
        const locations = el("div");
        r.stage.forEach((key) => locations.append(el("span", "stage", stages[key] || key)));
        const links = el("div", "linkbar");
        links.append(link("查看上游原文 ↗", r.source), el("code", "", r.commit.slice(0, 10)));
        const permalink = el("a", "", "本条定位");
        permalink.href = selectedURL(r.id);
        permalink.addEventListener("click", (e) => {
          e.preventDefault();
          location.hash = r.id;
        });
        links.append(permalink);
        for (const line of r.verbatimLines || []) links.append(link("原文第 " + line + " 行", r.source + "#L" + line));
        d.append(meta, el("h2", "", r.name), locations, links, section("适用条件", r.applies || r.reason));
        const versions = r.roleAdaptations || {};
        const variants = Object.keys(versions);
        const isCallable = callable(r);
        if (isCallable) {
          const s = el("section", "panel prompt");
          s.append(el("h3", "", "Pi 提示词"));
          if (variants.length) {
            const buttons = el("div", "versions");
            for (const key of ["", ...variants]) {
              const b = el("button", "", roles[key] || key || "通用方法");
              b.type = "button";
              b.setAttribute("aria-pressed", String(shownRole === key));
              b.onclick = () => {
                shownRole = key;
                detail(r);
                const all = [...$("detail").querySelectorAll(".versions button")];
                all.find((item) => item.textContent === b.textContent)?.focus({ preventScroll: true });
              };
              buttons.append(b);
            }
            s.append(buttons);
          }
          s.append(el("p", "", versions[shownRole] || r.adaptation));
          d.append(s);
        } else if (r.status !== "excluded") {
          d.append(section("迁移到 Pi 的流程设计", r.adaptation));
        }
        d.append(section(r.status === "excluded" ? "排除依据" : "设计依据", r.reason));
        if (r.omissions && r.status !== "excluded") d.append(section("与上游的差异", r.omissions));
        if (r.sourceSections?.length) {
          const s = el("section", "panel");
          s.append(el("h3", "", "原文对应章节"));
          const sections = el("div", "refs");
          for (const ref of r.sourceSections) sections.append(link(ref.label, ref.url));
          s.append(sections);
          d.append(s);
        }
        if (r.references?.length) {
          const s = el("section", "panel");
          s.append(el("h3", "", "上游配套材料"));
          const refs = el("div", "refs");
          for (const ref of r.references) refs.append(link(ref.label, ref.link));
          s.append(refs);
          d.append(s);
        }
        d.append(
          el(
            "p",
            "countnote",
            r.playbook
              ? "此条属于 poteto-mode，其数量在技能统计外单列。"
              : r.collection === "automationSkills"
                ? "此条属于 Benny 自动化包，计入全树技能数。上游公开技能清单未收录该入口。"
              : r.kind === "workflow"
                ? "流程条目只用于追溯设计；插件按自己的状态转移运行。"
                : r.status === "excluded"
                  ? "该来源保留在盘点清单中。"
                  : "方法按角色、阶段和任务条件选用。",
          ),
        );
      }
      function draw() {
        const q = $("q").value.trim().toLowerCase(),
          owner = $("owner").value,
          stage = $("stage").value,
          kind = $("kind").value,
          status = $("status").value;
        const matches = rows.filter(
          (r) =>
            (!owner || owner === r.owner) &&
            (!stage || r.stage.includes(stage)) &&
            matchesType(r, kind) &&
            (!status ||
              (status === "callable"
                ? callable(r)
                : status === "roles"
                  ? Object.keys(r.roleAdaptations || {}).length > 0
                  : r.status === status)) &&
            (!q || q.split(/\s+/u).every((word) => searchText.get(r.id).includes(word))),
        );
        let active = matches.find((r) => r.id === selected) || matches[0];
        if (active?.id !== selected) {
          selected = active?.id || "";
          shownRole = "";
        }
        $("matches").textContent = matches.length + " / " + rows.length;
        const items = document.createDocumentFragment();
        for (const r of matches) {
          const b = el("button", "record");
          b.type = "button";
          b.dataset.id = r.id;
          b.setAttribute("aria-current", String(r.id === selected));
          b.append(
            el("span", "name", r.name),
            el(
              "span",
              "line",
              owners[r.owner] + " · " + typeLabel(r) + " · " + statusText(r),
            ),
          );
          b.onclick = () => {
            const at = $("list").scrollTop;
            select(r.id, true);
            $("list").scrollTop = at;
            const item = $("list").querySelector("[aria-current=true]");
            item?.focus({ preventScroll: true });
          };
          items.append(b);
        }
        if (!matches.length) items.append(el("p", "empty", "未找到相符的条目。"));
        $("list").replaceChildren(items);
        detail(active);
      }
      for (const id of criteria)
        $(id).addEventListener(id === "q" ? "input" : "change", () => {
          shownRole = "";
          $("list").scrollTop = 0;
          draw();
        });
      $("reset").addEventListener("click", () => {
        for (const id of criteria) $(id).value = "";
        draw();
        $("q").focus();
      });
      window.addEventListener("hashchange", () => {
        const id = readHash();
        if (rows.some((r) => r.id === id)) {
          for (const name of criteria) $(name).value = "";
          select(id, false);
          $("list").querySelector("[aria-current=true]")?.scrollIntoView({ block: "nearest" });
        }
      });
      draw();
      const initial = $("list").querySelector("[aria-current=true]");
      if (initial && innerWidth > 690) $("list").scrollTop = initial.offsetTop - $("list").offsetTop;
    </script>
  </body>
</html>
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, nargs="?", default=DEFAULT_OUTPUT)
    output = parser.parse_args().output
    data = json.dumps(load_entries(), ensure_ascii=False, separators=(",", ":"))
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(PAGE.replace("___DATA___", data.replace("<", "\\u003c")), encoding="utf-8")


if __name__ == "__main__":
    main()
