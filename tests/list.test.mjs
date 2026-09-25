/**
 * P0 列表增强测试。
 *   (1) 课程 → 教学班：模块插在卡片内 .cv-caption-red 与其后的 .cv-caption-text 之间
 *   (2) 直接即教学班（公选/慕课）：在「操作」列右侧新增「抢课模块」列
 * 模块：第一行教学班ID（不换行），第二行两个按钮。
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
    closest(cls) {
      let n = this;
      while (n) {
        if ((n.getAttribute('class') || '').split(/\s+/).includes(cls.replace('.', ''))) return n;
        n = n.parentNode;
      }
      return null;
    },
    querySelector(sel) {
      const all = this._all();
      const has = (c, s) => (c.getAttribute('class') || '').includes(s);
      if (sel.includes('cv-info') && !sel.includes('-title')) return all.find((c) => has(c, 'cv-info') && !has(c, 'cv-info-title')) || null;
      if (sel.includes('cv-info-title')) return all.find((c) => has(c, 'cv-info-title')) || null;
      if (sel.includes('collection-img')) return all.find((c) => has(c, 'collection-img')) || null;
      if (sel.includes('cv-choice')) return all.find((c) => has(c, 'cv-choice')) || null;
      if (sel.includes('cv-setting-col')) return all.find((c) => has(c, 'cv-setting-col')) || null;
      if (sel.includes('cv-title-col')) return all.find((c) => has(c, 'cv-title-col')) || null;
      if (sel.includes('cv-teacher-col')) return all.find((c) => has(c, 'cv-teacher-col')) || null;
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
  const allCards = [], allRows = [];
  bodies.forEach((b) => b._all().forEach((c) => {
    const cl = c.getAttribute('class') || '';
    if (cl.includes('cv-course-card')) allCards.push(c);
    if (cl.includes('cv-row') && !cl.includes('cv-head')) allRows.push(c);
  }));
  return {
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

/** 在节点子树内查找 szu-block（模块现位于 cv-info 内，非卡片直接子节点）。 */
function blocksOf(node) {
  return node._all().filter((c) => (c.getAttribute('class') || '').includes('szu-block'));
}

// ---------- 形态一：教学班卡片 ----------

/**
 * 构造卡片，复刻真实结构：
 * .cv-course-card > .cv-info > [h5(.cv-info-title), div, div, div, .cv-caption-text,
 *                               .cv-caption-text, div.cv-caption-red, .cv-caption-text(退选), img]
 */
function card(tcId, withRed) {
  const c = mk('div', 'cv-course-card');
  c.setAttribute('id', tcId + '_courseDiv');
  const info = mk('div', 'cv-info');
  const h5 = mk('h5');
  h5.appendChild(mk('span', 'cv-info-title', '张胜利'));
  info.appendChild(h5);
  info.appendChild(mk('div', 'cv-caption-text', '主选课容量:已满/50'));
  if (withRed !== false) info.appendChild(mk('div', 'cv-caption-red', '选课说明：无选课说明'));
  const after = mk('div', 'cv-caption-text');
  after.appendChild(mk('button', 'cv-btn cv-tag cv-delete-volunteer', '退选'));
  info.appendChild(after);
  const img = mk('img', 'collection-img');
  img.setAttribute('tcId', tcId);
  info.appendChild(img);
  c.appendChild(info);
  return { card: c, info, red: withRed !== false ? info.childNodes[3] : null, after };
}

test('卡片：模块插在 cv-caption-red 与其后的 cv-caption-text 之间', () => {
  const { card: c, info } = card('T1');
  const body = mk('div'); body.setAttribute('id', 'programBody'); body.appendChild(c);
  const NS = loadNS(mkDoc([body]));

  ok(NS.list.enhanceCard(c), '增强成功');
  const kids = info.childNodes.filter((n) => n.nodeType === 1);
  const redIdx = kids.findIndex((k) => (k.getAttribute('class') || '').includes('cv-caption-red'));
  const blkIdx = kids.findIndex((k) => (k.getAttribute('class') || '').includes('szu-block'));
  eq(blkIdx, redIdx + 1, '模块紧随 cv-caption-red 之后');
  const next = kids[blkIdx + 1];
  ok((next.getAttribute('class') || '').includes('cv-caption-text'), '其后是 cv-caption-text');
});

test('卡片：模块为纵向两行 —— ID 行 + 按钮行', () => {
  const { card: c } = card('202620271130086001108');
  const body = mk('div'); body.setAttribute('id', 'programBody'); body.appendChild(c);
  const NS = loadNS(mkDoc([body]));

  NS.list.enhanceCard(c);
  const blk = blocksOf(c)[0];
  eq(blk.childNodes.length, 2, '两行');
  eq(blk.childNodes[0].getAttribute('class'), 'szu-id', '第一行 ID');
  eq(blk.childNodes[1].getAttribute('class'), 'szu-ops', '第二行按钮');
  eq(blk.childNodes[0].textContent, '202620271130086001108', 'ID 原样显示（无前缀）');
  eq(blk.childNodes[1].childNodes.length, 2, '两个按钮');
  eq(blk.childNodes[1].childNodes[0].textContent, '添加抢课');
  eq(blk.childNodes[1].childNodes[1].textContent, '添加监控');
});

test('卡片：模块父节点是 cv-info（在卡片信息区内）', () => {
  const { card: c, info } = card('T1');
  const body = mk('div'); body.setAttribute('id', 'programBody'); body.appendChild(c);
  const NS = loadNS(mkDoc([body]));

  NS.list.enhanceCard(c);
  ok(blocksOf(c)[0].parentNode === info, '父节点是 cv-info');
});

test('卡片：无 cv-caption-red 时退化为按「选课说明」定位', () => {
  const c = mk('div', 'cv-course-card');
  const info = mk('div', 'cv-info');
  info.appendChild(mk('span', 'cv-info-title', '师'));
  info.appendChild(mk('div', 'cv-caption-text', '选课说明：无选课说明'));
  info.appendChild(mk('div', 'cv-caption-text', '退选'));
  const img = mk('img', 'collection-img'); img.setAttribute('tcId', 'T7');
  info.appendChild(img);
  c.appendChild(info);
  const body = mk('div'); body.setAttribute('id', 'programBody'); body.appendChild(c);
  const NS = loadNS(mkDoc([body]));

  ok(NS.list.enhanceCard(c), '仍能增强');
  eq(blocksOf(c).length, 1);
});

test('卡片：从 id 兜底解析 tcId', () => {
  const c = mk('div', 'cv-course-card');
  c.setAttribute('id', 'T9_courseDiv');
  const info = mk('div', 'cv-info');
  info.appendChild(mk('div', 'cv-caption-red', 'x'));
  info.appendChild(mk('div', 'cv-caption-text', 'y'));
  c.appendChild(info);
  const body = mk('div'); body.setAttribute('id', 'programBody'); body.appendChild(c);
  const NS = loadNS(mkDoc([body]));

  ok(NS.list.enhanceCard(c));
  eq(blocksOf(c)[0].childNodes[0].textContent, 'T9');
});

test('卡片：幂等，不重复注入', () => {
  const { card: c } = card('T1');
  const body = mk('div'); body.setAttribute('id', 'programBody'); body.appendChild(c);
  const NS = loadNS(mkDoc([body]));

  ok(NS.list.enhanceCard(c), '首次 true');
  ok(!NS.list.enhanceCard(c), '再次 false');
  eq(blocksOf(c).length, 1);
});

// ---------- 形态二：公选/慕课 ----------

function directRow(tcId, name) {
  const r = mk('div', 'cv-row');
  r.appendChild(mk('div', 'cv-title-col', name));
  r.appendChild(mk('div', 'cv-teacher-col', '侯佳彤'));
  const setting = mk('div', 'cv-setting-col');
  const a = mk('a', 'cv-choice');
  a.setAttribute('tcId', tcId);
  setting.appendChild(a);
  r.appendChild(setting);
  return r;
}

function directBody(rows) {
  const list = mk('div', 'cv-list public-list');
  const head = mk('div', 'cv-head');
  head.appendChild(mk('div', 'cv-normal cv-normalcv-setting-col', '操作'));
  list.appendChild(head);
  const body = mk('div');
  body.setAttribute('id', 'publicBody');
  rows.forEach((r) => body.appendChild(r));
  list.appendChild(body);
  return { list, head, body };
}

test('公选/慕课：表头新增「抢课模块」列，且带 cv-normal（抑制排序箭头）', () => {
  const { head, body } = directBody([directRow('T1', '艺术陶冶')]);
  const NS = loadNS(mkDoc([body]));

  NS.list.ensureHeadColumn('publicBody');
  const cols = head.childNodes.filter((c) => (c.getAttribute('class') || '').includes('szu-head-col'));
  eq(cols.length, 1, '新增 1 列表头');
  eq(cols[0].textContent, '抢课模块');
  ok((cols[0].getAttribute('class') || '').includes('cv-normal'), '带 cv-normal');
});

test('公选/慕课：行内单元格插在「操作」列之后', () => {
  const r = directRow('202620271050199035810', '艺术陶冶与审美体验');
  const { body } = directBody([r]);
  const NS = loadNS(mkDoc([body]));

  ok(NS.list.enhanceDirectRow(r));
  const setting = r.childNodes.find((c) => (c.getAttribute('class') || '').includes('cv-setting-col'));
  const after = r.childNodes[r.childNodes.indexOf(setting) + 1];
  ok(after && (after.getAttribute('class') || '').includes('szu-direct-col'), '紧随操作列');
  const blk = blocksOf(after)[0];
  eq(blk.childNodes.length, 2, '纵向两行');
  eq(blk.childNodes[0].textContent, '202620271050199035810', 'ID 原样');
  eq(blk.childNodes[1].childNodes.length, 2, '两个按钮');
});

test('公选/慕课：幂等，不重复加列', () => {
  const r = directRow('T1', '课');
  const { body } = directBody([r]);
  const NS = loadNS(mkDoc([body]));

  ok(NS.list.enhanceDirectRow(r), '首次 true');
  ok(!NS.list.enhanceDirectRow(r), '再次 false');
  eq(r.childNodes.filter((c) => (c.getAttribute('class') || '').includes('szu-direct-col')).length, 1);
});

test('表头幂等：不重复加表头列', () => {
  const { head, body } = directBody([directRow('T1', '课')]);
  const NS = loadNS(mkDoc([body]));

  ok(NS.list.ensureHeadColumn('publicBody'), '首次 true');
  ok(!NS.list.ensureHeadColumn('publicBody'), '再次 false');
  eq(head.childNodes.filter((c) => (c.getAttribute('class') || '').includes('szu-head-col')).length, 1);
});

test('scan 同时处理卡片与直接行', () => {
  const { card: c } = card('T1');
  const b1 = mk('div'); b1.setAttribute('id', 'programBody'); b1.appendChild(c);
  const r = directRow('T2', '公选课');
  const { body: b2 } = directBody([r]);

  const NS = loadNS(mkDoc([b1, b2]));
  eq(NS.list.scan(), 2, '各增强 1 处');
  eq(blocksOf(c).length, 1, '卡片有模块');
  eq(r.childNodes.filter((x) => (x.getAttribute('class') || '').includes('szu-direct-col')).length, 1, '行有新列');
});

await run();
