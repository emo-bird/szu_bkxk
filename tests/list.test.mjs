/**
 * P0 列表增强测试。
 * 核心验证：教学班来源是全局 courseDataList[row.index].tcList（站点真实机制），
 * 以及「抢课模块」注入到课程行**内部**、纵向两行（ID / 按钮）。
 */
import { test, eq, ok, loadNS, run } from './harness.mjs';

/** 最小 DOM 元素。 */
function el(tag) {
  const e = {
    tagName: tag.toUpperCase(), childNodes: [], attrs: {}, _t: '', parentNode: null, nodeType: 1,
    style: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      contains(c) { return this._s.has(c); },
    },
    // textContent 聚合子节点文本（与真实 DOM 一致）
    get textContent() {
      if (!this.childNodes.length) return this._t;
      return this.childNodes.map((c) => (c.nodeType === 3 ? c.textContent : c.textContent)).join('');
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
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return e;
}

/** 文本节点：需带 nodeType，供 textContent 聚合时识别。 */
function textNode(t) { return { nodeType: 3, textContent: t, parentNode: null }; }

/** 构造一个课程行（带 index 属性，教学班在全局数据里）。 */
function courseRow(index, name, tcIdAttr) {
  const r = el('div');
  r.setAttribute('class', 'cv-row');
  r.setAttribute('index', String(index));
  const course = el('div');
  course.setAttribute('class', 'cv-course');
  course.textContent = name;
  r.appendChild(course);
  if (tcIdAttr) {
    const a = el('a');
    a.setAttribute('class', 'cv-choice');
    a.setAttribute('tcId', tcIdAttr);
    a.setAttribute('number', '01');
    r.appendChild(a);
  }
  r.querySelector = (sel) => {
    const kids = r.childNodes.filter((c) => c.nodeType === 1);
    if (sel.includes('cv-choice')) return kids.find((c) => (c.attrs['class'] || '').includes('cv-choice')) || null;
    if (sel.includes('cv-course')) return kids.find((c) => (c.attrs['class'] || '').includes('cv-course')) || null;
    if (sel.includes('cv-title-col')) return null;
    return null;
  };
  return r;
}

/** 构造一个列表容器。 */
function body(id, rows) {
  const b = el('div');
  b.setAttribute('id', id);
  b.childNodes.push(...rows);
  rows.forEach((r) => { r.parentNode = b; });
  b.querySelectorAll = (sel) => (sel.includes('cv-row') ? rows : []);
  return b;
}

function mkDoc(bodies) {
  return {
    getElementById(id) { return bodies.find((b) => b.getAttribute('id') === id) || null; },
    createElement(tag) { return el(tag); },
    createTextNode(t) { return textNode(t); },
    querySelectorAll(sel) {
      if (!sel.includes('cv-row')) return [];
      const out = [];
      bodies.forEach((b) => b.childNodes.forEach((c) => { if (c.nodeType === 1 && c.getAttribute('class') === 'cv-row') out.push(c); }));
      return out;
    },
    addEventListener() {},
    readyState: 'complete',
  };
}

/** 注入全局 courseDataList（站点真实数据源）。 */
function withDataList(NS, list) { NS.__setCourseDataList(list); }

function blocksOf(row) {
  return row.childNodes.filter((c) => c.nodeType === 1 && (c.getAttribute('class') || '').includes('szu-block'));
}

// ---- 用例 ----

test('教学班来自全局 courseDataList[row.index].tcList', () => {
  const r = courseRow(0, '高等数学A(1)');
  const b = body('programBody', [r]);
  const NS = loadNS(mkDoc([b]));
  withDataList(NS, [{ courseNumber: '1900600001', tcList: [{ teachingClassID: 'T1' }, { teachingClassID: 'T2' }] }]);

  const classes = NS.list.classesForRow(r);
  eq(classes.length, 2, '取到 2 个教学班');
  eq(classes.map((c) => c.teachingClassID), ['T1', 'T2']);
});

test('module 注入到课程行内部，且为纵向两行（ID / 按钮）', () => {
  const r = courseRow(0, '高等数学A(1)');
  const b = body('programBody', [r]);
  const NS = loadNS(mkDoc([b]));
  withDataList(NS, [{ tcList: [{ teachingClassID: 'T1', courseIndex: '18' }] }]);

  NS.list.enhanceRow(r);

  const blocks = blocksOf(r);
  eq(blocks.length, 1, '行内出现 1 个抢课模块');
  const blk = blocks[0];
  eq(blk.childNodes.length, 2, '模块纵向两行');
  eq(blk.childNodes[0].getAttribute('class'), 'szu-id', '第一行是 ID 行');
  eq(blk.childNodes[1].getAttribute('class'), 'szu-ops', '第二行是按钮行');
  ok(blk.childNodes[0].textContent.includes('T1'), 'ID 行含教学班ID');
  eq(blk.childNodes[1].childNodes.length, 2, '两个按钮');
});

test('多教学班 → 行内多个模块', () => {
  const r = courseRow(0, '课');
  const b = body('programBody', [r]);
  const NS = loadNS(mkDoc([b]));
  withDataList(NS, [{ tcList: [{ teachingClassID: 'T1' }, { teachingClassID: 'T2' }, { teachingClassID: 'T3' }] }]);

  NS.list.enhanceRow(r);
  eq(blocksOf(r).length, 3, '3 个模块');
});

test('幂等：同一行不重复增强', () => {
  const r = courseRow(0, '课');
  const b = body('programBody', [r]);
  const NS = loadNS(mkDoc([b]));
  withDataList(NS, [{ tcList: [{ teachingClassID: 'T1' }] }]);

  ok(NS.list.enhanceRow(r), '首次 true');
  ok(!NS.list.enhanceRow(r), '再次 false');
  eq(blocksOf(r).length, 1, '仍只 1 个模块');
});

test('行本身带 tcId（公选/慕课）也能增强', () => {
  const r = courseRow(0, '视听说', 'T9');
  const b = body('publicBody', [r]);
  const NS = loadNS(mkDoc([b]));
  withDataList(NS, null);

  NS.list.enhanceRow(r);
  eq(blocksOf(r).length, 1, '1 个模块');
  ok(blocksOf(r)[0].childNodes[0].textContent.includes('T9'), 'ID 正确');
});

test('拿不到教学班的行不增强', () => {
  const r = courseRow(5, '孤立课');
  const b = body('programBody', [r]);
  const NS = loadNS(mkDoc([b]));
  withDataList(NS, []);

  ok(!NS.list.enhanceRow(r), '返回 false');
  eq(blocksOf(r).length, 0, '无模块');
});

test('scan 遍历多个列表容器', () => {
  const r1 = courseRow(0, '课一');
  const r2 = courseRow(0, '课二');
  const b1 = body('programBody', [r1]);
  const b2 = body('publicBody', [r2]);
  const NS = loadNS(mkDoc([b1, b2]));
  withDataList(NS, [{ tcList: [{ teachingClassID: 'T1' }] }]);

  const n = NS.list.scan();
  eq(n, 2, '两个容器各增强 1 行');
});

test('isFull=1 时模块带 szu-full 标记', () => {
  const r = courseRow(0, '课');
  const b = body('programBody', [r]);
  const NS = loadNS(mkDoc([b]));
  withDataList(NS, [{ tcList: [{ teachingClassID: 'T1', isFull: '1' }] }]);

  NS.list.enhanceRow(r);
  ok((blocksOf(r)[0].getAttribute('class') || '').includes('szu-full'), '含 szu-full');
});

test('增强不会把模块插到行外（父节点仍是行）', () => {
  const r = courseRow(0, '课');
  const b = body('programBody', [r]);
  const NS = loadNS(mkDoc([b]));
  withDataList(NS, [{ tcList: [{ teachingClassID: 'T1' }] }]);

  NS.list.enhanceRow(r);
  ok(blocksOf(r)[0].parentNode === r, '模块父节点是课程行');
  eq(b.childNodes.filter((c) => c.nodeType === 1 && (c.getAttribute('class') || '').includes('szu-block')).length, 0,
    '容器直接子节点里没有模块（未被插到行外）');
});

await run();
