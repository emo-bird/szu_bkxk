/**
 * 课表页：给「自定义课程」的原生卡片打上【自定义】标签。
 *
 * 【为什么不再自己插块】
 *   自定义课程已经由 hijack.js 注入到 `teachingTime.do` 的返回里，
 *   站点会**原生渲染**出卡片。若这里再插一个块，就会与原生卡片重叠
 *   （真机反馈的「覆盖」问题）。所以这里只负责**找到原生卡片并打标签**。
 *
 * 【怎么找】我们的注入条目会渲染成：
 *   第 1 行 = 课程名[-课序号]，第 2 行 = `<weekName><起>节-<止>节`，地点、教师。
 *   故按「所在星期列 + 文本含课程名 + 文本含 `起-止节`」三点定位，
 *   不依赖站点具体排版与空格。
 *
 * 依赖：hijack 的课表注入（关闭后课表里不会有自定义课程，自然也无从打标签）。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var TT = (NS.timetable = NS.timetable || {});

  var STYLE_ID = 'szu-tt-style';
  var TAG_ATTR = 'data-szu-tagged';

  TT.injectStyle = function () {
    if (root.document.getElementById(STYLE_ID)) return;
    var s = root.document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.szu-tt-tag{display:inline-block;font-size:11px;line-height:1.3;padding:0 4px;',
      'margin:2px 0 0 0;border-radius:2px;background:#047ADC;color:#fff;',
      'vertical-align:middle;}',
    ].join('');
    (root.document.head || root.document.documentElement).appendChild(s);
  };

  /** 课表容器；找不到返回 null（非课表页或结构变了）。 */
  TT.findTable = function () {
    var doc = root.document;
    return doc.getElementById('myCourseTable') ||
      (doc.querySelector ? doc.querySelector('.cv-my-course') : null);
  };

  /** 找某一天的列容器。day: 1=周一 … 7=周日。 */
  TT.findDayColumn = function (table, day) {
    var cols = table.querySelectorAll ? table.querySelectorAll('.cv-col.cv-right') : [];
    var names = ['周一', '周二', '周三', '周四', '周五', '周六', '周七'];
    var want = names[day - 1];
    for (var i = 0; i < cols.length; i++) {
      var head = cols[i].querySelector ? cols[i].querySelector('.cv-head') : null;
      if (head && NS.util.text(head).indexOf(want) !== -1) return cols[i];
    }
    return cols[day - 1] || null;
  };

  /** 给一张卡片打【自定义】标签（幂等）。 */
  TT.tagCard = function (card) {
    if (card.getAttribute(TAG_ATTR) === '1') return false;
    card.setAttribute(TAG_ATTR, '1');
    var tag = root.document.createElement('span');
    tag.className = 'szu-tt-tag';
    tag.textContent = '自定义';
    card.appendChild(tag);
    return true;
  };

  /** 在一张卡片里找是否含某段的时间特征（`起-止节`）。 */
  function cardMatches(card, name, seg) {
    var t = NS.util.text(card);
    if (t.indexOf(name) === -1) return false;
    var span = seg.sectionFrom + '-' + seg.sectionTo + '节';
    if (t.indexOf(span) !== -1) return true;
    // 单节次站点可能渲染成 `3-3节`，两种都认
    var single = seg.sectionFrom + '节';
    return seg.sectionFrom === seg.sectionTo && t.indexOf(single) !== -1;
  }

  /**
   * 扫描课表，给匹配到的自定义课程卡片打标签。
   * @returns {number} 本次新打标签的卡片数
   */
  TT.tagCustom = function () {
    var table = TT.findTable();
    if (!table) return 0;
    var n = 0;
    var items = NS.custom.items || [];

    for (var i = 0; i < items.length; i++) {
      var c = items[i];
      if (!c || c.enabled === false) continue;
      for (var j = 0; j < c.segs.length; j++) {
        var seg = c.segs[j];
        if (seg.day === null) continue;
        var col = TT.findDayColumn(table, seg.day);
        if (!col) continue;
        var cards = col.querySelectorAll ? col.querySelectorAll('.cv-course-card-single') : [];
        for (var k = 0; k < cards.length; k++) {
          if (cards[k].getAttribute(TAG_ATTR) === '1') continue;
          if (!cardMatches(cards[k], c.name, seg)) continue;
          if (TT.tagCard(cards[k])) n++;
        }
      }
    }
    if (n) NS.info('课表已标记 ' + n + ' 张自定义课程卡片');
    return n;
  };

  /** 统计当前已打标签的数量（供界面显示）。 */
  TT.taggedCount = function () {
    var table = TT.findTable();
    if (!table || !table.querySelectorAll) return 0;
    return table.querySelectorAll('.szu-tt-tag').length;
  };

  /** 兼容旧调用点。 */
  TT.render = function () {
    TT.injectStyle();
    return TT.tagCustom();
  };

  /** 入口：站点是异步渲染课表，找不到容器就重试；渲染后跟着重新打标签。 */
  TT.start = function () {
    TT.injectStyle();
    var tableTries = 0;
    var patchTries = 0;

    function attempt() {
      var table = TT.findTable();
      if (!table) {
        if (++tableTries < 20) setTimeout(attempt, 500);
        else NS.warn('未找到课表容器 #myCourseTable，放弃标记');
        return;
      }

      TT.tagCustom();

      // 卡片可能晚于容器出现，补几轮直到标记到位（最多 8 轮）
      (function patch() {
        if (NS.custom.items.length && TT.taggedCount() > 0) return;
        if (patchTries++ >= 8) return;
        TT.tagCustom();
        setTimeout(patch, 600);
      })();

      if (root.MutationObserver) {
        var pending = false;
        var mo = new root.MutationObserver(function () {
          if (pending) return;
          pending = true;
          setTimeout(function () {
            pending = false;
            if (TT.findTable()) TT.tagCustom();
          }, 300);
        });
        mo.observe(table, { childList: true, subtree: true });
      }
      NS.info('课表自定义标记已启动');
    }
    attempt();
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
