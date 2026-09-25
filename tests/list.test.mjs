/**
 * P0 列表增强测试：横幅插入位置 / 扁平与嵌套结构 / 幂等性。
 * 用手写的最小 DOM 模拟，不引入 jsdom（开发文档：不写 DOM 测试，但插入位置是
 * 上一轮真机暴露的 bug，属核心正确性，保留少量用例）。
 */
import { test, eq, ok, loadNS, run } from './harness.mjs';

const NS = loadNS({
  getElementById() { return null; },
  createElement(tag) { return el(tag); },
  querySelectorAll(sel) { return sel.includes('cv-row') ? globalRows : []; },
  addEventListener() {},
  readyState: 'complete',
});

/** 当前用例注册的行，供 querySelectorAll 使用。 */
let globalRows = [];

/** 最小 DOM 元素。 */
function el(tag) {
  const e = {
    tagName: tag.toUpperCase(), childNodes: [], attrs: {}, _t: '', parentNode: null, nodeType: 1,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); } },
    get textContent() { return this._t; },
    set textContent(v) { this._t = String(v); },
    set className(v) { this.attrs['class'] = String(v); },
    get className() { return this.attrs['class'] || ''; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    get nextElementSibling() {
      if (!this.parentNode) return null;
      const s = this.parentNode.childNodes, i = s.indexOf(this);
      for (let j = i + 1; j < s.length; j++) if (s[j].nodeType === 1) return s[j];
      return null;
    },
    appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; },
    insertBefore(n, ref) {
      n.parentNode = this;
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
      return n;
    },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  };
  return e;
}

function row(courseNumber, tcId, name) {
  const r = el('div');
  r.setAttribute('class', 'cv-row');
  if (courseNumber) r.setAttribute('coursenumber', courseNumber);
  if (tcId) {
    const a = el('a');
    a.setAttribute('class', 'cv-choice');
    a.setAttribute('tcId', tcId);
    a.setAttribute('number', '01');
    r.appendChild(a);
  }
  const t = el('div');
  t.setAttribute('class', 'cv-title-col');
  t.textContent = name;
  r.appendChild(t);
  r.querySelector = (sel) => {
    const kids = r.childNodes.filter((c) => c.nodeType === 1);
    if (sel.includes('cv-choice')) return kids.find((c) => (c.attrs['class'] || '').includes('cv-choice')) || null;
    if (sel.includes('cv-title-col')) return kids.find((c) => (c.attrs['class'] || '').includes('cv-title-col')) || null;
    return null;
  };
  return r;
}

function barsOf(container) {
  return container.childNodes.filter((c) => c.nodeType === 1 && c.getAttribute('class') === 'szu-bar');
}

test('横条插入在各自行的紧后面（nextElementSibling）', () => {
  const r1 = row('C1', 'T1', '课一');
  const r2 = row('C2', 'T2', '课二');
  const c = el('div');
  c.appendChild(r1);
  c.appendChild({ nodeType: 3, textContent: '\n', parentNode: null });
  c.appendChild(r2);

  NS.list.enhanceRow(r1);
  NS.list.enhanceRow(r2);

  eq(r1.nextElementSibling.getAttribute('class'), 'szu-bar', 'r1 后紧跟横条');
  eq(r2.nextElementSibling.getAttribute('class'), 'szu-bar', 'r2 后紧跟横条');
  eq(barsOf(c).length, 2, '共 2 条');
});

test('横条含教学班ID + 两个按钮', () => {
  const r = row('C1', 'T1', '课一');
  el('div').appendChild(r);
  NS.list.enhanceRow(r);
  const bar = r.nextElementSibling;
  const idEl = bar.childNodes[0];
  const ops = bar.childNodes[1];
  eq(idEl.textContent, 'T1', 'ID 文本');
  eq(ops.childNodes.length, 2, '两个按钮');
  eq(ops.childNodes[0].textContent, '添加抢课');
  eq(ops.childNodes[1].textContent, '添加监控');
});

test('同一行不会被重复增强', () => {
  const r = row('C1', 'T1', '课一');
  const c = el('div');
  c.appendChild(r);
  ok(NS.list.enhanceRow(r), '首次增强返回 true');
  ok(!NS.list.enhanceRow(r), '再次增强返回 false');
  eq(barsOf(c).length, 1, '只有一条横条');
});

test('没有 tcId 的行不被增强（交给拦截模块）', () => {
  const r = row('C1', null, '课程级行');
  el('div').appendChild(r);
  ok(!NS.list.enhanceRow(r), '返回 false');
  eq(r.nextElementSibling, null, '未插入任何东西');
});

test('嵌套结构 flatten：dataList → tcList', () => {
  const cls = NS.courses.flatten({
    data: { dataList: [{ courseNumber: 'C1', tcList: [{ teachingClassID: 'T1' }, { teachingClassID: 'T2' }] }] },
  });
  eq(cls.length, 2);
  eq(cls.map((x) => x.teachingClassID), ['T1', 'T2']);
});

test('扁平结构 flatten：publicCourse 无 tcList，一行即一个教学班', () => {
  const cls = NS.courses.flatten({
    data: { dataList: [{ teachingClassID: 'T9', courseName: '视听说' }] },
  });
  eq(cls.length, 1);
  eq(cls[0].teachingClassID, 'T9');
});

test('嵌套时教学班级 null 不覆盖课程级字段', () => {
  const cls = NS.courses.flatten({
    data: {
      dataList: [{
        courseName: '高等数学A(1)', teacherName: '尹乐', credit: '5.0',
        tcList: [{ teachingClassID: 'T1', courseName: null, teacherName: null, credit: null }],
      }],
    },
  });
  eq(cls[0].courseName, '高等数学A(1)', '课程名回退到课程级');
  eq(cls[0].teacherName, '尹乐', '教师回退到课程级');
  eq(cls[0].credit, '5.0', '学分回退到课程级');
});

test('拦截补渲染：课程级行按 courseNumber 匹配到教学班', () => {
  const r = row('C1', null, '高等数学A(1)');
  const c = el('div');
  c.appendChild(r);
  globalRows = [r];
  NS.intercept.handleListResponse({
    data: { dataList: [{ courseNumber: 'C1', tcList: [{ teachingClassID: 'T1' }, { teachingClassID: 'T2' }] }] },
  });
  eq(barsOf(c).length, 2, '补渲染 2 条');
});

test('拦截补渲染幂等：同一课程行不重复补', () => {
  const r = row('C1', null, '课');
  const c = el('div');
  c.appendChild(r);
  globalRows = [r];
  const payload = { data: { dataList: [{ courseNumber: 'C1', tcList: [{ teachingClassID: 'T1' }] }] } };
  NS.intercept.handleListResponse(payload);
  NS.intercept.handleListResponse(payload);
  eq(barsOf(c).length, 1, '仍只有 1 条');
});

test('拦截补渲染：courseNumber 对不上的行不动', () => {
  const r = row('C9', null, '别的课');
  const c = el('div');
  c.appendChild(r);
  globalRows = [r];
  NS.intercept.handleListResponse({
    data: { dataList: [{ courseNumber: 'C1', tcList: [{ teachingClassID: 'T1' }] }] },
  });
  eq(barsOf(c).length, 0, '不该补到别的课上');
});

await run();
