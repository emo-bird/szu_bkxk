/**
 * P0 列表增强测试 —— 两种形态：
 *   (1) 课程 → 教学班：模块注入到 .cv-course-card 内部
 *   (2) 直接即教学班（公选/慕课）：在「操作」列右侧新增「抢课模块」列
 */
import { test, eq, ok, loadNS, run } from './harness.mjs';

function el(tag) {
  const e = {
    tagName: tag.toUpperCase(), childNodes: [], attrs: {}, _t: '', parentNode: null, nodeType: 1,
    style: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); } },
    get textContent() {
      if (!this.childNodes.length) return this._t;
      return this.childNodes.map((c) => c.textContent).join('');
    },
    set textContent(v) { this._t = String(v); this.childNodes.length = 0; },
    set className(v) { this.attrs['class'] = String(v); },
    get className() { return this.attrs['class'] || ''; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; },
    insertBefore(n, ref) {
      n.parentNode = this;
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
      return n;
    },
    addEventListener() {},
    querySelector(sel) {
      const all = this._all();
      if (sel.includes('cv-choice')) return all.find((c) => (c.getAttribute('class') || '').includes('cv-choice')) || null;
      if (sel.includes('collection-img')) return all.find((c) => (c.getAttribute('class') || '').includes('collection-img')) || null;
      if (sel.includes('cv-info-title')) return all.find((c) => (c.getAttribute('class') || '').includes('cv-info-title')) || null;
      if (sel.includes('cv-setting-col')) return all.find((c) => (c.getAttribute('class') || '').includes('cv-setting-col')) || null;
      if (sel.includes('cv-title-col')) return all.find((c) => (c.getAttribute('class') || '').includes('cv-title-col')) || null;
      if (sel.includes('cv-teacher-col')) return all.find((c) => (c.getAttribute('class') || '').includes('cv-teacher-col')) || null;
      if (sel.includes('cv-time-col')) return all.find((c) => (c.getAttribute('class') || '').includes('cv-time-col')) || null;
      if (sel.includes('cv-head')) return all.find((c) => (c.getAttribute('class') || '') === 'cv-head') || null;
      return null;
    },
    querySelectorAll(sel) {
      const all = this._all();
      if (sel.includes('cv-course-card')) return all.filter((c) => (c.getAttribute('class') || '').includes('cv-course-card'));
      if (sel.includes('cv-row')) return all.filter((c) => (c.getAttribute('class') || '').includes('cv-row'));
      return [];
    },
    _all() {
      const out = [];
      const walk = (n) => { n.childNodes.forEach((c) => { if (c.nodeType === 1) { out.push(c); walk(c); } }); };
      walk(this);
      return out;
    },
    closest() { return this._closest || null; },
  };
  return e;
}

function mk(tag, cls, text) {
  const e = el(tag);
  if (cls) e.setAttribute('class', cls);
  if (text !== undefined) e.textContent = text;
  return e;
}

function mkDoc(bodies) {
  const allCards = [];
  const allRows = [];
  bodies.forEach((b) => {
    b._all().forEach((c) => {
      const cl = c.getAttribute('class') || '';
      if (cl.includes('cv-course-card')) allCards.push(c);
      if (cl.includes('cv-row')) allRows.push(c);
    });
  });
  return {
    _cards: allCards, _rows: allRows,
    getElementById(id) { return bodies.find((b) => b.getAttribute('id') === id) || null; },
    createElement(tag) { return el(tag); },
    createTextNode(t) { return { nodeType: 3, textContent: t, parentNode: null }; },
    querySelectorAll(sel) {
      if (sel.includes('cv-course-card')) return allCards;
      if (sel.includes('cv-row')) return allRows;
      return [];
    },
    addEventListener() {},
    readyState: 'complete',
  };
}

function blocksOf(node) {
  return node.childNodes.filter((c) => c.nodeType === 1 && (c.getAttribute('class') || '').includes('szu-block'));
}

// ---------- (1) 教学班卡片 ----------

/** 构造教学班卡片（模拟 CVCourseCard.getHtml 的产物关键部分）。 */
function card(tcId, teacher) {
  const c = mk('div', 'cv-course-card');
  c.setAttribute('id', tcId + '_courseDiv');
  const info = mk('div', 'cv-info');
  const h5 = mk('h5');
  h5.appendChild(mk('span', 'cv-info-title', teacher || '张老师'));
  info.appendChild(h5);
  const img = mk('img', 'collection-img');
  img.setAttribute('tcId', tcId);
  info.appendChild(img);
  c.appendChild(info);
  return c;
}

test('卡片：抢课模块注入到卡片内部', () => {
  const c = card('T1', '张胜利');
  const body = mk('div');
  body.setAttribute('id', 'programBody');
  body.appendChild(c);
  const NS = loadNS(mkDoc([body]));

  ok(NS.list.enhanceCard(c), '增强成功');
  const blocks = blocksOf(c);
  eq(blocks.length, 1, '卡片内有 1 个模块');
  ok(blocks[0].parentNode === c, '模块父节点是卡片');
});

test('卡片：模块为纵向两行 —— ID 行 + 按钮行', () => {
  const c = card('202620271130086001108', '张胜利');
  const body = mk('div');
  body.setAttribute('id', 'programBody');
  body.appendChild(c);
  const NS = loadNS(mkDoc([body]));

  NS.list.enhanceCard(c);
  const blk = blocksOf(c)[0];
  eq(blk.childNodes.length, 2, '两行');
  eq(blk.childNodes[0].getAttribute('class'), 'szu-id', '第一行 ID');
  eq(blk.childNodes[1].getAttribute('class'), 'szu-ops', '第二行按钮');
  ok(blk.childNodes[0].textContent.includes('202620271130086001108'), 'ID 正确');
  eq(blk.childNodes[1].childNodes.length, 2, '两个按钮');
  eq(blk.childNodes[1].childNodes[0].textContent, '添加抢课');
  eq(blk.childNodes[1].childNodes[1].textContent, '添加监控');
});

test('卡片：从 id 兜底解析 tcId', () => {
  const c = mk('div', 'cv-course-card');
  c.setAttribute('id', 'T9_courseDiv');
  const body = mk('div');
  body.setAttribute('id', 'programBody');
  body.appendChild(c);
  const NS = loadNS(mkDoc([body]));

  ok(NS.list.enhanceCard(c), '无 img 时也能从 id 拿到');
  ok(blocksOf(c)[0].childNodes[0].textContent.includes('T9'));
});

test('卡片：幂等，不重复注入', () => {
  const c = card('T1');
  const body = mk('div');
  body.setAttribute('id', 'programBody');
  body.appendChild(c);
  const NS = loadNS(mkDoc([body]));

  ok(NS.list.enhanceCard(c), '首次 true');
  ok(!NS.list.enhanceCard(c), '再次 false');
  eq(blocksOf(c).length, 1, '仍 1 个');
});

// ---------- (2) 直接即教学班（公选/慕课） ----------

function directRow(tcId, name) {
  const r = mk('div', 'cv-row');
  r.appendChild(mk('div', 'cv-title-col', name));
  r.appendChild(mk('div', 'cv-teacher-col', '侯佳彤'));
  const a = mk('a', 'cv-choice');
  a.setAttribute('tcId', tcId);
  a.setAttribute('number', '05019');
  r.appendChild(a);
  const setting = mk('div', 'cv-setting-col');
  setting.appendChild(a);
  r.appendChild(setting);
  return r;
}

function directBody(rows) {
  const list = mk('div', 'cv-list public-list');
  const head = mk('div', 'cv-head');
  head.appendChild(mk('div', 'cv-normalcv-setting-col', '操作'));
  list.appendChild(head);
  const body = mk('div');
  body.setAttribute('id', 'publicBody');
  rows.forEach((r) => body.appendChild(r));
  list.appendChild(body);
  body._closest = list;
  return { list, head, body };
}

test('公选/慕课：表头新增「抢课模块」列', () => {
  const { head, body } = directBody([directRow('T1', '艺术陶冶')]);
  const NS = loadNS(mkDoc([body]));

  NS.list.ensureHeadColumn('publicBody');
  const cols = head.childNodes.filter((c) => (c.getAttribute('class') || '').includes('szu-head-col'));
  eq(cols.length, 1, '新增 1 列表头');
  eq(cols[0].textContent, '抢课模块');
});

test('公选/慕课：行内新增「抢课模块」单元格，插在「操作」列之后', () => {
  const r = directRow('202620271050199035810', '艺术陶冶与审美体验');
  const { body } = directBody([r]);
  const NS = loadNS(mkDoc([body]));

  ok(NS.list.enhanceDirectRow(r), '增强成功');
  const setting = r.childNodes.find((c) => (c.getAttribute('class') || '').includes('cv-setting-col'));
  const next = r.childNodes[r.childNodes.indexOf(setting) + 1];
  ok(next && (next.getAttribute('class') || '').includes('szu-direct-col'), '紧随操作列之后');
  const blk = blocksOf(next)[0];
  eq(blk.childNodes.length, 2, '纵向两行');
  ok(blk.childNodes[0].textContent.includes('202620271050199035810'), 'ID 正确');
  eq(blk.childNodes[1].childNodes.length, 2, '两个按钮');
});

test('公选/慕课：幂等，不重复加列', () => {
  const r = directRow('T1', '课');
  const { body } = directBody([r]);
  const NS = loadNS(mkDoc([body]));

  ok(NS.list.enhanceDirectRow(r), '首次 true');
  ok(!NS.list.enhanceDirectRow(r), '再次 false');
  const cols = r.childNodes.filter((c) => (c.getAttribute('class') || '').includes('szu-direct-col'));
  eq(cols.length, 1, '只有 1 个新列');
});

test('scan 同时处理卡片与直接行', () => {
  const c = card('T1');
  const body1 = mk('div');
  body1.setAttribute('id', 'programBody');
  body1.appendChild(c);

  const r = directRow('T2', '公选课');
  const { body: body2 } = directBody([r]);

  const NS = loadNS(mkDoc([body1, body2]));
  const n = NS.list.scan();
  eq(n, 2, '各增强 1 处');
  eq(blocksOf(c).length, 1, '卡片有模块');
  eq(r.childNodes.filter((x) => (x.getAttribute('class') || '').includes('szu-direct-col')).length, 1, '行有新列');
});

test('isFull=1 时模块带 szu-full', () => {
  const c = card('T1');
  c.setAttribute('isFull', '1');
  const body = mk('div');
  body.setAttribute('id', 'programBody');
  body.appendChild(c);
  const NS = loadNS(mkDoc([body]));

  NS.list.enhanceCard(c);
  ok((blocksOf(c)[0].getAttribute('class') || '').includes('szu-full'), '含 szu-full');
});

await run();
