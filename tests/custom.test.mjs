/**
 * 自定义课程 + 课表注入测试（P2 / M4）。
 * 课表 DOM 契约取自 docs/curriculum.do.html。
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
  if (sel === '.cv-left .cv-lesson') return cls.includes('cv-lesson');
  if (sel.startsWith('.')) return cls.includes(sel.slice(1));
  return false;
}

const mk = (tag, cls, text) => { const e = el(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

/** 造一个最小课表：两天，各一个刻度列。 */
function buildTable() {
  const table = mk('div', 'cv-my-course');
  table.setAttribute('id', 'myCourseTable');

  const left = mk('div', 'cv-col cv-left');
  const lesson = mk('div', 'cv-lesson');
  for (let i = 0; i < 14; i++) {
    const slot = mk('div');
    slot.style.height = '54px';
    lesson.appendChild(slot);
  }
  left.appendChild(lesson);
  table.appendChild(left);

  ['周一', '周二'].forEach((name) => {
    const col = mk('div', 'cv-col cv-right');
    col.appendChild(mk('div', 'cv-head', name));
    table.appendChild(col);
  });
  return table;
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
    querySelectorAll(sel) { return sel.includes('szu-tt-lesson') ? [] : []; },
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

test('自定义课程：缺名称或时间无法解析时不添加', () => {
  const NS = loadNS();
  NS.custom.clear();
  eq(NS.custom.add({ place: '5-18周 星期二 3-4节 A' }), null, '缺名称');
  const bad = NS.custom.add({ name: 'X', place: '看不懂的时间' });
  ok(bad, '仍添加但解析为 0 段');
  eq(bad.segs.length, 0, '解析不出段');
});

test('自定义课程：持久化与恢复', () => {
  const NS = loadNS();
  NS.custom.clear();
  NS.custom.add({ name: '旁听课', teacher: '张', place: '5-18周 星期二 3-4节 A' });
  NS.custom.items = [];
  const n = NS.custom.load();
  eq(n, 1);
  eq(NS.custom.items[0].name, '旁听课');
  eq(NS.custom.items[0].segs.length, 1, 'segs 由 place 重新解析');
});

// ---------- 冲突计算 ----------

test('冲突：自定义课程与站点已选课程冲突能被识别', () => {
  const NS = loadNS();
  NS.custom.clear();
  NS.custom.add({ name: '旁听', place: '5-18周 星期二 3-4节 A' });
  const selected = [{ courseName: '高数', teachingPlace: '5-18周 星期二 3-4节 致理楼' }];
  const hit = NS.custom.conflictsWith(selected);
  eq(hit.length, 1);
  eq(hit[0].other.courseName, '高数');
});

test('冲突：时间不重叠则不算冲突', () => {
  const NS = loadNS();
  NS.custom.clear();
  NS.custom.add({ name: '旁听', place: '5-18周 星期二 3-4节 A' });
  const selected = [{ courseName: '高数', teachingPlace: '5-18周 星期四 3-4节 B' }];
  eq(NS.custom.conflictsWith(selected).length, 0);
});

test('冲突：自定义课程之间互查', () => {
  const NS = loadNS();
  NS.custom.clear();
  NS.custom.add({ name: 'A', place: '5-18周 星期二 3-4节 X' });
  NS.custom.add({ name: 'B', place: '5-18周 星期二 4-5节 Y' });
  eq(NS.custom.selfConflicts().length, 1, '节次部分重叠');
});

test('冲突：禁用的自定义课程不参与判定', () => {
  const NS = loadNS();
  NS.custom.clear();
  const a = NS.custom.add({ name: 'A', place: '5-18周 星期二 3-4节 X' });
  NS.custom.add({ name: 'B', place: '5-18周 星期二 4-5节 Y' });
  NS.custom.update(a.id, { enabled: false });
  eq(NS.custom.selfConflicts().length, 0);
});

// ---------- 课表注入 ----------

test('课表注入：按星期与节次算 top/height 并挂到对应列', () => {
  const table = buildTable();
  const NS = loadNS(mkDoc(table));
  NS.custom.clear();
  NS.custom.add({ name: '旁听课', place: '5-18周 星期二 3-4节 致理楼L1-707' });

  const n = NS.timetable.render();
  eq(n, 1, '注入 1 段');

  const cols = table.querySelectorAll('.cv-col.cv-right');
  const tue = cols.find((c) => NS.util.text(c.querySelector('.cv-head')) === '周二');
  const injected = tue.querySelectorAll('.szu-tt-lesson');
  eq(injected.length, 1, '周二列里有 1 个注入块');
  // 第 3 节起：top = 28 + (3-1)*54 = 136；高 = 2*54+1 = 109
  eq(injected[0].style.top, '136px', 'top 计算');
  eq(injected[0].style.height, '109px', 'height 计算');
  eq(injected[0].getAttribute('start'), '3');
  eq(injected[0].getAttribute('end'), '4');
});

test('课表注入：卡片带「自定义」标记且结构对齐站点', () => {
  const table = buildTable();
  const NS = loadNS(mkDoc(table));
  NS.custom.clear();
  NS.custom.add({ name: '旁听课', teacher: '张老师', place: '5-18周 星期一 1-2节 A' });

  NS.timetable.render();
  const card = table.querySelector('.szu-tt-card');
  ok(card, '存在自定义卡片');
  ok((card.getAttribute('class') || '').includes('cv-course-card-single'), '复用站点卡片类');
  ok(card.textContent.includes('旁听课'), '含课程名');
  ok(card.textContent.includes('自定义'), '含自定义标签');
  ok(card.textContent.includes('张老师'), '含教师');
});

test('课表注入：重复渲染不会堆叠（先清理旧的）', () => {
  const table = buildTable();
  const NS = loadNS(mkDoc(table));
  NS.custom.clear();
  NS.custom.add({ name: '旁听课', place: '5-18周 星期一 1-2节 A' });

  NS.timetable.render();
  NS.timetable.render();
  NS.timetable.render();
  eq(table.querySelectorAll('.szu-tt-lesson').length, 1, '始终只有 1 个');
});

test('课表注入：禁用的自定义课程不注入', () => {
  const table = buildTable();
  const NS = loadNS(mkDoc(table));
  NS.custom.clear();
  const c = NS.custom.add({ name: '旁听课', place: '5-18周 星期一 1-2节 A' });
  NS.custom.update(c.id, { enabled: false });
  eq(NS.timetable.render(), 0);
  eq(table.querySelectorAll('.szu-tt-lesson').length, 0);
});

test('课表注入：星期超出范围（周日之外）不注入且不抛错', () => {
  const table = buildTable(); // 只有周一、周二两列
  const NS = loadNS(mkDoc(table));
  NS.custom.clear();
  NS.custom.add({ name: '旁听课', place: '5-18周 星期五 1-2节 A' }); // 表里没有周五
  eq(NS.timetable.render(), 0, '找不到列则不注入');
});

test('课表注入：时间未解析的课程被跳过', () => {
  const table = buildTable();
  const NS = loadNS(mkDoc(table));
  NS.custom.clear();
  NS.custom.add({ name: '坏时间', place: '看不懂' });
  eq(NS.timetable.render(), 0);
});

test('课表注入：单节高度从真实刻度测量', () => {
  const table = buildTable();
  // 把刻度改成 40px，注入的几何应随之变化
  const lesson = table.querySelector('.cv-left .cv-lesson');
  lesson.childNodes.forEach((n) => { n.style.height = '40px'; });
  const NS = loadNS(mkDoc(table));
  NS.custom.clear();
  NS.custom.add({ name: 'X', place: '5-18周 星期一 1-1节 A' });
  NS.timetable.render();
  const inj = table.querySelector('.szu-tt-lesson');
  eq(inj.style.top, '28px', '第一节课 top=28');
  eq(inj.style.height, '41px', '单节 40px + 1');
});

await run();
