/**
 * ui/panel.js 的纯函数部分 + ui/recon.js 的离屏单测。
 *
 * 【为什么只测这些】面板的 DOM 交互只能在真实浏览器里验证（见交付给用户的自测清单）；
 * 但"位置钳位"与"侦察取数"是纯逻辑，必须离线钉住，避免上线后才发现算错。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');

require('../src/core/ns.js');
require('../src/core/session.js');
require('../src/core/task.js');
require('../src/ui/recon.js');
require('../src/ui/panel.js');
require('../src/ui/tasks.js');

const NS = globalThis.SZUBKXK;
const UI = NS.ui;

/** 造一个假 document（只实现侦察用到的部分）。 */
function fakeDoc(counts, title) {
  return {
    title: title || '(无标题)',
    readyState: 'complete',
    querySelectorAll: (sel) => ({ length: Object.prototype.hasOwnProperty.call(counts, sel) ? counts[sel] : 0 }),
  };
}

/** 造一个假 window。 */
function fakeWin(extra) {
  return Object.assign(
    {
      location: { href: 'http://bkxk.szu.edu.cn/xsxkapp/sys/xsxkapp/*default/grablessons.do?token=T' },
      document: fakeDoc({ '.cv-course-card': 13, '.cv-row': 13, table: 2 }, '选课'),
      sessionStorage: null,
    },
    extra || {}
  );
}

section('ui/panel.js 位置钳位（纯函数）');

test('视口内不动', () => {
  eq(UI.panel.clampPosition(100, 100, 380, 240, { width: 1024, height: 768 }), { left: 100, top: 100 });
});

test('超出右下边界时贴边', () => {
  eq(UI.panel.clampPosition(1000, 800, 380, 240, { width: 1024, height: 768 }), { left: 636, top: 520 });
});

test('负坐标被拉回最小边距', () => {
  eq(UI.panel.clampPosition(-100, -100, 380, 240, { width: 1024, height: 768 }), { left: 8, top: 8 });
});

test('面板比视口还大时退化为最小边距', () => {
  eq(UI.panel.clampPosition(0, 0, 2000, 2000, { width: 1024, height: 768 }), { left: 8, top: 8 });
});

test('视口未知（0x0）时不炸，退化为最小边距', () => {
  eq(UI.panel.clampPosition(50, 50, 380, 240, { width: 0, height: 0 }), { left: 8, top: 8 });
  eq(UI.panel.clampPosition(50, 50, 380, 240, null), { left: 8, top: 8 });
});

section('ui/recon.js 页面识别');

test('按 URL 识别页面类型', () => {
  eq(UI.recon.detectPage('http://bkxk.szu.edu.cn/xsxkapp/sys/xsxkapp/*default/grablessons.do?token=T'), 'grablessons(选课页)');
  eq(UI.recon.detectPage('http://bkxk.szu.edu.cn/xsxkapp/sys/xsxkapp/*default/curriculum.do'), 'curriculum(课表页)');
  eq(UI.recon.detectPage('http://bkxk.szu.edu.cn/xsxkapp/sys/xsxkapp/*default/courseResult.do'), 'courseResult(已选结果)');
  eq(UI.recon.detectPage('http://bkxk.szu.edu.cn/xsxkapp/sys/xsxkapp/*default/index.do'), 'index(首页)');
  eq(UI.recon.detectPage('http://example.com/'), '非选课站点页');
});

section('ui/recon.js 站点库探测');

test('探测到 jQuery 版本与其它库的有无', () => {
  const libs = UI.recon.detectLibs(
    fakeWin({ jQuery: { fn: { jquery: '2.1.1' } }, Sortable: {}, SockJS: {}, Stomp: {} })
  );
  eq(libs.jQuery, '2.1.1');
  eq(libs.Sortable, true);
  eq(libs.SockJS, true);
  eq(libs.Stomp, true);
  eq(libs.jQWidgets, false);
  eq(libs.Chart, false);
  eq(libs.FlipClock, false);
});

test('库探测抛异常时归为缺失，不影响整体', () => {
  const bad = {
    get jQuery() {
      throw new Error('boom');
    },
  };
  const libs = UI.recon.detectLibs(bad);
  eq(libs.jQuery, false);
  eq(libs.Chart, false);
});

section('ui/recon.js 事实收集');

test('collect 汇总 URL/页面/DOM/库/会话', () => {
  const win = fakeWin({
    jQuery: { fn: { jquery: '2.1.1' } },
    sessionStorage: {
      getItem: (k) =>
        ({
          token: 'TOKEN-ABCDEFGH',
          studentInfo: '{"studentCode":"2026000000"}',
          currentBatch: '{"code":"BATCH-1","schoolTerm":"2026-2027-1"}',
        })[k] || null,
    },
  });
  const facts = UI.recon.collect(win);
  eq(facts.page, 'grablessons(选课页)');
  eq(facts.libs.jQuery, '2.1.1');
  eq(facts.dom.courseCard, 13);
  eq(facts.dom.cvInfo, 0);
  eq(facts.dom.timetableTable, 2);
  eq(facts.session.ok, true);
  eq(facts.session.tokenPresent, true);
  eq(facts.session.schoolTerm, '2026-2027-1');
});

test('collect 对残缺环境不抛异常', () => {
  const facts = UI.recon.collect({});
  eq(facts.page, '非选课站点页');
  eq(facts.dom.courseCard, -1, '拿不到 document 时应为 -1');
  eq(facts.session.available, false);
});

test('format 产出可复制回传的文本，且不泄露完整凭证', () => {
  const win = fakeWin({
    jQuery: { fn: { jquery: '2.1.1' } },
    sessionStorage: {
      getItem: (k) =>
        ({
          token: 'TOKEN-ABCDEFGH',
          studentInfo: '{"studentCode":"2026000000"}',
          currentBatch: '{"code":"BATCH-1"}',
        })[k] || null,
    },
  });
  const text = UI.recon.format(UI.recon.collect(win));
  ok(text.indexOf('页面：') !== -1, '缺页面行');
  ok(text.indexOf('jQuery=2.1.1') !== -1, '缺库信息');
  ok(text.indexOf('.cv-course-card=13') !== -1, '缺 DOM 信息');
  ok(text.indexOf('TOKEN-ABCDEFGH') === -1, '不应出现完整 token');
  ok(text.indexOf('2026000000') === -1, '不应出现完整学号');
  ok(text.indexOf('CSP') !== -1, '应提示 CSP 需用 DevTools 查看');
});

test('format 对空输入有兜底', () => {
  eq(UI.recon.format(null), '(无侦察数据)');
});

section('ui/tasks.js 纯函数');

test('parseTargetIds 去空行、去空白、去重且保持顺序', () => {
  eq(UI.tasks.parseTargetIds('  A \n\n B\r\nA\n C '), ['A', 'B', 'C']);
  eq(UI.tasks.parseTargetIds(''), []);
  eq(UI.tasks.parseTargetIds(null), []);
});

test('timeInputToServerMs：空/非法输入 → null（立即开始）', () => {
  eq(UI.tasks.timeInputToServerMs('', null), null);
  eq(UI.tasks.timeInputToServerMs(null, null), null);
  eq(UI.tasks.timeInputToServerMs('乱填', null), null);
  eq(UI.tasks.timeInputToServerMs('25:00', null), null);
  eq(UI.tasks.timeInputToServerMs('10:99', null), null);
});

test('timeInputToServerMs：未来时刻落在今天', () => {
  // 服务器时间固定为 2023-11-14 12:00:00 UTC+8 的某个瞬间
  const serverMs = new Date(2023, 10, 14, 12, 0, 0).getTime();
  const clock = { serverNow: () => serverMs };
  const got = UI.tasks.timeInputToServerMs('18:30', clock);
  eq(new Date(got).getHours(), 18);
  eq(new Date(got).getMinutes(), 30);
  eq(new Date(got).getDate(), 14, '同一天');
});

test('timeInputToServerMs：已过的时刻顺延到明天（避免"填了却没生效"）', () => {
  const serverMs = new Date(2023, 10, 14, 12, 0, 0).getTime();
  const clock = { serverNow: () => serverMs };
  const got = UI.tasks.timeInputToServerMs('09:00', clock);
  eq(new Date(got).getDate(), 15, '应顺延到明天');
  eq(new Date(got).getHours(), 9);
  ok(got > serverMs, '必须晚于当前服务器时间');
});

test('timeInputToServerMs：支持 HH:MM:SS', () => {
  const serverMs = new Date(2023, 10, 14, 12, 0, 0).getTime();
  const clock = { serverNow: () => serverMs };
  eq(new Date(UI.tasks.timeInputToServerMs('13:00:30', clock)).getSeconds(), 30);
});

test('课程类别表覆盖逆向记录的 7 个类别', () => {
  eq(UI.tasks.CATEGORIES.map((c) => c.code), ['FANKC', 'FAWKC', 'TJKC', 'XGXK', 'TYKC', 'FXKC', 'MOOC']);
});
