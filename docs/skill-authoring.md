# pi-studio Skill 写作规范

写新 skill（或改造现有 skill）时照本规范走。核心思想：**一个 skill 只做一件事，SKILL.md 瘦身、细节进 references、description 塞满 trigger 词、修复建议必须用项目自己的写法。**

---

## 1. 总原则

| 原则 | 说明 |
|------|------|
| 单一职责 | 一个 skill 只管一件事，并在开头写清「管什么、**不管什么**」（职责边界）。 |
| 瘦主文件 | `SKILL.md` 只留核心原则 + Quick Reference 表 + 工作流 + 输出格式，≤120 行。 |
| 细节后置 | 细节、清单、schema 放 `references/*.md`，按需加载，模型上下文才干净。 |
| 触发词驱动 | `description` 是 skill 能否被自动调用的唯一依据，必须塞满中英 trigger 词。 |
| 项目惯用法 | 写修复建议前先读项目代码；建议必须用项目自己的技术栈/token/写法，不引入第二套。 |
| 统一输出 | 审查类 skill 用同一套严重度分级 + findings 表 + verdict + finding 上限。 |

参考标杆：[jakubkrehel/skills](https://github.com/jakubkrehel/skills)（多领域 skill + 编排器模式）。

---

## 2. Frontmatter 三个字段

```yaml
---
name: my-skill-name
disable-model-invocation: true   # 可选：审查/危险操作类才加
description: >-
  一句话说清用途 + 触发场景。
  Triggers on: ...（中英 trigger 词都列）
---
```

| 字段 | 规则 | 校验失败后果 |
|------|------|------------|
| `name` | 小写字母 `a-z`、数字 `0-9`、连字符 `-`；≤64 字符；不能 `--`、不能首尾 `-` | skill 加载报错 |
| `description` | **必填**；≤1024 字符；塞满 trigger 词 | 缺失 → 完全不入 prompt |
| `disable-model-invocation` | `true` 时 skill 从 prompt 排除，只靠 `/skill:xxx` 显式触发 | — |

**trigger 词写法**：把用户可能说的话、你处理的场景、技术名词、中英文都列上。例：

```yaml
description: >-
  Turn a reference image into a procedural Three.js model...
  Triggers on: three.js, procedural modeling, image to 3d, 图片转3D, 三维建模,
  模型重建, 照片建模, PBR, 材质, 灯光, game prop, hero render.
```

---

## 3. SKILL.md 模板

```markdown
---
name: <kebab-case-name>
description: >-
  <一句话用途 + 触发场景>
  Triggers on: <中英 trigger 词>
---

# <标题>

<2-3 行：这个 skill 是什么、不是什么。> 职责边界：<管什么，不管什么>。

## Quick Reference

| Concern | Reference |
| --- | --- |
| <问题 A> | [<file>.md](references/<file>.md) |
| <问题 B> | [<file>.md](references/<file>.md) |

## 核心原则

1. <原则 1（一句话，能落地的）>
2. <原则 2>
3. ...

## 工作流

<编号步骤：做这件事的固定顺序；该跑什么脚本、读哪个 reference。>

## 输出格式

<分析类：固定返回 1. 2. 3. ...；实现类：先简述再改代码。>

## 失败处理

<做不了时怎么说不假话、要什么补充输入。>

## 职责边界

- <这个 skill 不覆盖什么，交给谁>
- <正确性/测试/安全/性能类问题：点名一次，转代码审查>
```

---

## 4. references/ 约定

- 每个文件一个主题：`helper-scripts.md`、`spec-schema.md`、`build-passes.md`、`implementation-rules.md`、`project-idiom.md`、`review-checklist.md`……（照这个命名风格）
- SKILL.md 里每引用一个 reference 都写 `[xxx.md](references/xxx.md)`，相对路径。
- **信息只搬不丢**：从主文件移细节时，确认内容完整迁移（例：本仓库 `object-to-threejs-procedural` 重构时把 review entry shape 补回了 `self-correction-loop.md`）。
- 项目惯用法单独放一个文件（如 `project-idiom.md`），写明：技术栈事实、标准代码姿势、硬性规则（禁止硬编码、深浅色都测、token 优先）、问题该往哪报。

---

## 5. 推送前校验清单

写完 skill，跑一遍这个清单再提交：

```bash
# 1) name / description 合法性 + 长度（≤64 / ≤1024）
node -e '
const fs=require("fs");
for(const p of process.argv.slice(1)){
  const raw=fs.readFileSync(p,"utf8");
  const m=raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm=m?m[1]:"";
  const name=fm.match(/name:\s*(\S+)/);
  const dis=fm.match(/disable-model-invocation:\s*(\S+)/);
  const dm=fm.match(/description:\s*[>|-]-?\r?\n([\s\S]*?)(?=\r?\n\S|$)/);
  const desc=dm?dm[1].split(/\r?\n/).map(l=>l.replace(/^\s+/,"")).join(" ").replace(/\s+/g," ").trim():"";
  console.log(p,
    "| name:",name?name[1]:"<missing>",
    name&&!/^[a-z0-9-]+$/.test(name[1])?"!! INVALID !!":"OK",
    "| disable:",dis?dis[1]:"no",
    "| desc:",desc.length,desc.length>1024?"!! OVER !!":"OK");
}' resources/pi-skills/<你的skill>/SKILL.md

# 2) SKILL.md 里的 references 链接都解析
grep -oE '\]\(references/[a-z0-9-]+\.md\)' resources/pi-skills/<你的skill>/SKILL.md \
  | sed 's/](references\///;s/)//' | sort -u \
  | while read f; do test -f "resources/pi-skills/<你的skill>/references/$f" && echo "OK $f" || echo "MISSING $f"; done

# 3) 无 mojibake（中文字符文件必查）
node -e '
const fs=require("fs");
const markers=["\u9239","\u9225","\u7487","\u93b5","\u95b0","\u7035","\u8930","\u9365","\u7459","\u5a11","\u6d7c","\u9422","\u9354","\u6769","\u6fb6","\u5bee","\u5ae8","\u6e6a","\u68ff","\u5f47","\u5553","\u567a","\u7edb"];
let bad=0;
for(const f of fs.readdirSync("resources/pi-skills",{recursive:true}).filter(x=>x.endsWith(".md")||x.endsWith(".py"))){
  const s=fs.readFileSync("resources/pi-skills/"+f,"utf8");
  if(markers.some(m=>s.includes(m))||s.includes("\uFFFD")){console.log("MOJIBAKE:",f);bad++;}
}
console.log(bad===0?"OK: no mojibake":"FAIL: "+bad+" files");'
```

注意：`pnpm run check:text` 只扫 `src/docs/scripts/package.json`，**不扫 `resources/pi-skills`**，所以上面的第 3 步手动 mojibake 检查不能省。

---

## 6. 提交信息风格

仓库用 conventional commits：

- 新增 skill：`feat(skills): add <name> ...`
- 重构 skill：`refactor(skills): ...`
- 只改文档：`docs(skills): ...`

例：`feat(skills): add interface-review skill; slim object-to-threejs-procedural`
