/**
 * 自定义课程 + 课表标记测试（P2 / M4 后续）。
 *
 * 真机反馈：课表里已经由 hijack 注入的响应**原生渲染**出卡片，
 * 若再自己插块就会重叠。故改为「找到原生卡片 → 打【自定义】标签」。
 */
import { test, eq, ok, loadNS, run } from './harness.mjs';

function el(tag) {
  const e = {
    tagName: tag.toUpperCase(), childNodes: [], attrs: {}, _t: '', parentNode: null, nodeType: 1,
    style: {}, _cls: new Set(),
    get className() { return this.attrs['class'] || ''; },
    set className(v) { this.attrs['class'] = String(v); },
    get textContent() {
      if (!this.childNodes.length) return this._t;
      return this.childNodes.map((c) => c.textContent).join('');
    },
    set textContent(v) { this._t = String(v); this.childNodes.length = 0; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; },
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) { this.childNodes.splice(i, 1); c.parentNode = null; } return c; },
    addEventListener() {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    _all() {
      const out = [];
      const walk = (n) => { n.childNodes.forEach((c) => { if (c.nodeType === 1) { out.push(c); walk(c); } }); };
      walk(this);
      return out;
    },
    querySelectorAll(sel) { return this._all().filter((c) => selMatches(c, sel)); },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    closest() { return null; },
  };
  return e;
}

function selMatches(e, sel) {
  const cls = (e.getAttribute('class') || '').split(/\s+/);
  if (sel.startsWith('#')) return e.getAttribute('id') === sel.slice(1);
  if (sel === '.cv-col.cv-right') return cls.includes('cv-col') && cls.includes('cv-right');
  if (sel.startsWith('.')) return cls.includes(sel.slice(1));
  return false;
}

const mk = (tag, cls, text) => {
  const e = el(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** 造最小课表：两天列，可选每列放若干卡片。 */
function buildTable(dayNames) {
  const table = mk('div', 'cv-my-course');
  table.setAttribute('id', 'myCourseTable');

  const left = mk('div', 'cv-col cv-left');
  const lesson = mk('div', 'cv-lesson');
  for (let i = 0; i < 14; i++) { const s = mk('div'); s.style.height = '54px'; lesson.appendChild(s); }
  left.appendChild(lesson);
  table.appendChild(left);

  (dayNames || ['周一', '周二']).forEach((name) => {
    const col = mk('div', 'cv-col cv-right');
    col.appendChild(mk('div', 'cv-head', name));
    table.appendChild(col);
  });
  return table;
}

/** 站点渲染出的卡片：名-序号 / 周次节次 / 地点 / 教师。 */
function addCard(table, dayName, lines) {
  const cols = table.querySelectorAll('.cv-col.cv-right');
  const col = cols.find((c) => c._all().some((x) => (x.getAttribute('class') || '') === 'cv-head' && x.textContent === dayName));
  if (!col) throw new Error('测试数据错误：没有 ' + dayName + ' 列');
  const lessonBox = mk('div', 'cv-lesson');
  const inner = mk('div');
  const card = mk('div', 'cv-course-card-single');
  const body = mk('div');
  lines.forEach((t) => body.appendChild(mk('div', undefined, t)));
  card.appendChild(body);
  inner.appendChild(card);
  lessonBox.appendChild(inner);
  col.appendChild(lessonBox);
  return card;
}

function mkDoc(table) {
  return {
    readyState: 'complete',
    body: el('body'),
    head: el('head'),
    getElementById(id) { return (table && table.getAttribute('id') === id) ? table : null; },
    createElement(tag) { return el(tag); },
    createTextNode(t) { return { nodeType: 3, textContent: String(t), parentNode: null }; },
    addEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    documentElement: el('html'),
  };
}

// ---------- 自定义课程数据 ----------

test('自定义课程：添加并解析时间', () => {
  const NS = loadNS();
  NS.custom.clear();
  const c = NS.custom.add({ name: '旁听课', place: '5-18周 星期二 3-4节 致理楼L1-707' });
  ok(c, '返回记录');
  eq(c.segs.length, 1, '解析出 1 段');
  eq(c.segs[0].day, 2);
  eq(c.segs[0].sectionFrom, 3);
});

test('自定义课程：多段与单双周都能解析', () => {
  const NS = loadNS();
  NS.custom.clear();
  const c = NS.custom.add({ name: 'X', place: '5-18周 星期二 3-4节 A,1-16周(单) 星期四 1-2节 B' });
  eq(c.segs.length, 2);
  eq(c.segs[1].parity, '单');
});

test('自定义课程：缺名称不添加；时间无法解析时仍添加但 0 段', () => {
  const NS = loadNS();
  NS.custom.clear();
  eq(NS.custom.add({ place: '5-18周 星期二 3-4节 A' }), null, '缺名称');
  const bad = NS.custom.add({ name: 'X', place: '看不懂的时间' });
  ok(bad, '仍添加');
  eq(bad.segs.length, 0, '解析不出段');
});

test('自定义课程：持久化与恢复（segs 由 place 重新解析）', () => {
  const NS = loadNS();
  NS.custom.clear();
  NS.custom.add({ name: '旁听课', teacher: '张', place: '5-18周 星期二 3-4节 A' });
  NS.custom.items = [];
  eq(NS.custom.load(), 1);
  eq(NS.custom.items[0].name, '旁听课');
  eq(NS.custom.items[0].segs.length, 1);
});

// ---------- 冲突计算 ----------

test('冲突：自定义课程与站点已选课程冲突能被识别', () => {
  const NS = loadNS();
  NS.custom.clear();
  NS.custom.add({ name: '旁听', place: '5-18周 星期二 3-4节 A' });
  const hit = NS.custom.conflictsWith([{ courseName: '高数', teachingPlace: '5-18周 星期二 3-4节 致理楼' }]);
  eq(hit.length, 1);
  eq(hit[0].other.courseName, '高数');
});

test('冲突：时间不重叠则不算冲突', () => {
  const NS = loadNS();
  NS.custom.clear();
  NS.custom.add({ name: '旁听', place: '5-18周 星期二 3-4节 A' });
  eq(NS.custom.conflictsWith([{ courseName: '高数', teachingPlace: '5-18周 星期四 3-4节 B' }]).length, 0);
});

test('冲突：自定义课程之间互查', () => {
  const NS = loadNS();
  NS.custom.clear();
  NS.custom.add({ name: 'A', place: '5-18周 星期二 3-4节 X' });
  NS.custom.add({ name: 'B', place: '5-18周 星期二 4-5节 Y' });
  eq(NS.custom.selfConflicts().length, 1);
});

test('冲突：禁用的自定义课程不参与判定', () => {
  const NS = loadNS();
  NS.custom.clear();
  const a = NS.custom.add({ name: 'A', place: '5-18周 星期二 3-4节 X' });
  NS.custom.add({ name: 'B', place: '5-18周 星期二 4-5节 Y' });
  NS.custom.update(a.id, { enabled: false });
  eq(NS.custom.selfConflicts().length, 0);
});

// ---------- 课表标记（不再插块） ----------

test('课表标记：找到原生卡片并打【自定义】标签', () => {
  const table = buildTable();
  addCard(table, '周二', ['旁听课-', '5-18周3-4节', '致理楼L1-100', '王老师']);
  const NS = loadNS(mkDoc(table));
  NS.custom.clear();
  NS.custom.add({ name: '旁听课', teacher: '王老师', place: '5-18周 星期二 3-4节 致理楼L1-100' });

  eq(NS.timetable.tagCustom(), 1, '标记 1 张');
  const tag = table.querySelector('.szu-tt-tag');
  ok(tag, '标签已加');
  eq(tag.textContent, '自定义');
});

test('课表标记：不再自己插入任何课表块（避免与原生卡片重叠）', () => {
  const table = buildTable();
  addCard(table, '周二', ['旁听课-', '5-18周3-4节', 'A', '王']);
  const NS = loadNS(mkDoc(table));
  NS.custom.clear();
  NS.custom.add({ name: '旁听课', place: '5-18周 星期二 3-4节 A' });

  const before = table.querySelectorAll('.cv-lesson').length;
  NS.timetable.tagCustom();
  eq(table.querySelectorAll('.szu-tt-lesson').length, 0, '没有插入新块');
  eq(table.querySelectorAll('.cv-lesson').length, before, '课表原有容器数量未变');
  eq(table.querySelectorAll('.cv-course-card-single').length, 1, '也没有多出卡片');
});

test('课表标记：课程名对不上不打标签', () => {
  const table = buildTable();
  addCard(table, '周二', ['别的课-01', '5-18周3-4节', 'A', '王']);
  const NS = loadNS(mkDoc(table));
  NS.custom.clear();
  NS.custom.add({ name: '旁听课', place: '5-18周 星期二 3-4节 A' });
  eq(NS.timetable.tagCustom(), 0);
  eq(table.querySelectorAll('.szu-tt-tag').length, 0);
});

test('课表标记：节次对不上不打标签', () => {
  const table = buildTable();
  addCard(table, '周二', ['旁听课-', '5-18周5-6节', 'A', '王']);
  const NS = loadNS(mkDoc(table));
  NS.custom.clear();
  NS.custom.add({ name: '旁听课', place: '5-18周 星期二 3-4节 A' });
  eq(NS.timetable.tagCustom(), 0);
});

test('课表标记：星期列对不上不打标签（同名同节次但在别的天）', () => {
  const table = buildTable();
  addCard(table, '周一', ['旁听课-', '5-18周3-4节', 'A', '王']);
  const NS = loadNS(mkDoc(table));
  NS.custom.clear();
  NS.custom.add({ name: '旁听课', place: '5-18周 星期二 3-4节 A' }); // 周二
  eq(NS.timetable.tagCustom(), 0, '周二找不到，不应误标周一的卡');
});

test('课表标记：幂等，重复调用不重复加标签', () => {
  const table = buildTable();
  addCard(table, '周二', ['旁听课-', '5-18周3-4节', 'A', '王']);
  const NS = loadNS(mkDoc(table));
  NS.custom.clear();
  NS.custom.add({ name: '旁听课', place: '5-18周 星期二 3-4节 A' });

  eq(NS.timetable.tagCustom(), 1);
  eq(NS.timetable.tagCustom(), 0, '第二次不再新标');
  eq(table.querySelectorAll('.szu-tt-tag').length, 1, '只有一个标签');
});

test('课表标记：单节次课程也能匹配', () => {
  const table = buildTable();
  addCard(table, '周一', ['单节课-', '5-18周3-3节', 'A', '王']);
  const NS = loadNS(mkDoc(table));
  NS.custom.clear();
  NS.custom.add({ name: '单节课', place: '5-18周 星期一 3节 A' });
  eq(NS.timetable.tagCustom(), 1);
});

test('课表标记：禁用的自定义课程不打标签', () => {
  const table = buildTable();
  addCard(table, '周二', ['旁听课-', '5-18周3-4节', 'A', '王']);
  const NS = loadNS(mkDoc(table));
  NS.custom.clear();
  const c = NS.custom.add({ name: '旁听课', place: '5-18周 星期二 3-4节 A' });
  NS.custom.update(c.id, { enabled: false });
  eq(NS.timetable.tagCustom(), 0);
});

test('课表标记：多段课程分别标记各自所在的那张卡', () => {
  const table = buildTable();
  addCard(table, '周一', ['多段课-', '5-18周1-2节', 'A', '王']);
  addCard(table, '周二', ['多段课-', '5-18周3-4节', 'B', '王']);
  const NS = loadNS(mkDoc(table));
  NS.custom.clear();
  NS.custom.add({ name: '多段课', place: '5-18周 星期一 1-2节 A,5-18周 星期二 3-4节 B' });
  eq(NS.timetable.tagCustom(), 2, '两张卡各打一次');
});

test('课表标记：找不到课表容器时返回 0 且不抛错', () => {
  const NS = loadNS(mkDoc(null));
  NS.custom.clear();
  NS.custom.add({ name: 'X', place: '5-18周 星期二 3-4节 A' });
  eq(NS.timetable.tagCustom(), 0);
  eq(NS.timetable.taggedCount(), 0);
});

test('课表标记：cardMatches 依赖的文本聚合正确（名 + 起-止节）', () => {
  const table = buildTable();
  addCard(table, '周二', ['旁听课-', '5-18周3-4节', '致理楼L1-100', '王老师']);
  const NS = loadNS(mkDoc(table));
  NS.custom.clear();
  NS.custom.add({ name: '旁听课', place: '5-18周 星期二 3-4节 X' });
  const card = table.querySelector('.cv-course-card-single');
  ok(card.textContent.indexOf('旁听课') !== -1, '含课程名');
  ok(card.textContent.indexOf('3-4节') !== -1, '含节次');
});

await run();
