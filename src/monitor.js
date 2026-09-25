/**
 * 容量监控：两种模式 + 轮询执行 + 命中自动抢。
 *
 * 【两种模式（用户指定，默认类别）】
 *   单独监控 SINGLE   —— 逐个教学班查 `teachingclass/capacity.do`，精确、报文极小
 *   类别监控 CATEGORY —— 拉该类别列表（programCourse.do 等），一次拿到一类里
 *                        所有教学班的余量；余量 = classCapacity - numberOfFirstVolunteer
 *
 * 【命中后】写接口开启则自动抢（MONITOR_HIT 最高优先级插队）；关闭则只提醒。
 *
 * 【安全】所有请求经 core 的限流队列；轮询只在用户显式点「开始监控」后启动
 * （红线⑤：不自动启动任务）。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var M = (NS.monitor = NS.monitor || {});

  M.MODE = { SINGLE: 'single', CATEGORY: 'category' };

  /** 已登记的教学班。 */
  M.items = [];
  M.polling = false;
  M.lastPollAt = null;
  M.pollCount = 0;
  M.hitCount = 0;
  M._timer = null;

  var STORE_KEY = 'monitor';

  /**
   * 落盘 / 加载。
   * 【刻意不存】轮询运行状态（刷新后不自动续跑，红线⑤）与任何凭证（红线③）。
   * 余量数据也一并存下，刷新后界面仍能看到上次结果。
   */
  M.save = function () {
    var slim = [];
    for (var i = 0; i < M.items.length; i++) {
      var m = M.items[i];
      slim.push({
        teachingClassID: m.teachingClassID,
        courseName: m.courseName, teacherName: m.teacherName,
        teachingPlace: m.teachingPlace, category: m.category,
        remain: m.remain, checkedAt: m.checkedAt, hits: m.hits,
        lastMsg: m.lastMsg,
      });
    }
    NS.store.set(STORE_KEY, { items: slim, hitCount: M.hitCount });
  };

  M.load = function () {
    var data = NS.store.get(STORE_KEY, null);
    if (!data || !Array.isArray(data.items)) return 0;
    M.items = data.items.map(function (m) {
      return {
        teachingClassID: String(m.teachingClassID || ''),
        courseName: m.courseName || '',
        teacherName: m.teacherName || '',
        teachingPlace: m.teachingPlace || '',
        category: m.category || '',
        remain: typeof m.remain === 'number' ? m.remain : null,
        checkedAt: m.checkedAt || null,
        hits: m.hits || 0,
        lastMsg: m.lastMsg || '',
      };
    }).filter(function (m) { return !!m.teachingClassID; });
    M.hitCount = data.hitCount || 0;
    // 刷新后一律不处于轮询态
    M.polling = false;
    if (M.items.length) NS.info('已恢复 ' + M.items.length + ' 个监控项');
    return M.items.length;
  };

  M.has = function (tcId) {
    for (var i = 0; i < M.items.length; i++) {
      if (M.items[i].teachingClassID === tcId) return true;
    }
    return false;
  };

  M.byId = function (tcId) {
    for (var i = 0; i < M.items.length; i++) {
      if (M.items[i].teachingClassID === tcId) return M.items[i];
    }
    return null;
  };

  M.add = function (info) {
    if (!info || !info.teachingClassID) return null;
    if (M.has(info.teachingClassID)) return null;
    var s = NS.settings();
    var rec = {
      teachingClassID: info.teachingClassID,
      courseName: info.courseName || '',
      teacherName: info.teacherName || '',
      teachingPlace: info.teachingPlace || '',
      category: info.category || '',
      remain: null,
      checkedAt: null,
      hits: 0,
      lastMsg: '',
    };
    void s;
    M.items.push(rec);
    M.save();
    NS.info('加入监控 ' + rec.teachingClassID, rec.courseName);
    return rec;
  };

  M.remove = function (tcId) {
    for (var i = 0; i < M.items.length; i++) {
      if (M.items[i].teachingClassID === tcId) {
        M.items.splice(i, 1);
        M.save();
        return true;
      }
    }
    return false;
  };

  M.clear = function () {
    M.items = [];
    M.hitCount = 0;
    M.save();
  };

  /** 当前模式。 */
  M.mode = function () {
    var s = NS.settings();
    return s.monitorMode === 'category' ? M.MODE.CATEGORY : M.MODE.SINGLE;
  };

  /** 一次「检查」：依模式选择端点。 */
  M.pollOnce = function () {
    M.lastPollAt = Date.now();
    M.pollCount += 1;
    if (!M.items.length) return Promise.resolve({ checked: 0, hits: [] });
    return (M.mode() === M.MODE.CATEGORY ? M._pollCategory() : M._pollSingle()).then(function (res) {
      return M._afterCheck(res);
    });
  };

  /* ---------------- 单独监控：逐课查 capacity.do ---------------- */

  M.checkOne = function (tcId) {
    var ctx = NS.list.sessionContext();
    if (!ctx.batchCode) {
      return Promise.resolve({ remain: null, kind: 'nobatch', msg: '批次码为空（请刷新选课页）' });
    }
    var body = NS.api.buildCapacityBody(tcId, ctx.batchCode);
    return NS.api
      .send({
        action: '查容量 ' + tcId,
        url: NS.api.url(NS.api.EP.CAPACITY),
        method: 'POST',
        body: body,
      })
      .then(function (r) {
        if (r.cls.kind !== NS.api.RESP_KIND.OK) {
          NS.warn('查容量失败 [' + r.cls.kind + '] ' + r.cls.msg + ' | ' + tcId);
          return { remain: null, kind: r.cls.kind, msg: r.cls.msg };
        }
        var remain = NS.api.capacityRemain(r.cls.data);
        M._apply(tcId, remain);
        return { remain: remain, kind: 'ok', msg: r.cls.msg };
      });
  };

  /** 逐个检查（串行，队列本身已限流）。 */
  M._pollSingle = function () {
    var ids = [];
    for (var i = 0; i < M.items.length; i++) ids.push(M.items[i].teachingClassID);
    var out = [];
    return ids
      .reduce(function (chain, id) {
        return chain.then(function () {
          return M.checkOne(id).then(function (r) {
            out.push({ teachingClassID: id, remain: r.remain, kind: r.kind });
          });
        });
      }, Promise.resolve())
      .then(function () { return { checked: out.length, hits: M._hits(out) }; });
  };

  /* ---------------- 类别监控：拉类别列表 ---------------- */

  /** 列表响应的余量算法：classCapacity - numberOfFirstVolunteer。 */
  M.remainOfClass = function (c) {
    if (!c) return null;
    if (c.classCapacity === undefined || c.classCapacity === null || c.classCapacity === '') return null;
    if (c.numberOfFirstVolunteer === undefined || c.numberOfFirstVolunteer === null || c.numberOfFirstVolunteer === '') return null;
    var cap = Number(c.classCapacity);
    var used = Number(c.numberOfFirstVolunteer);
    if (!isFinite(cap) || !isFinite(used)) return null;
    return cap - used;
  };

  /** 拉一个类别的全部页（最多 MAX_PAGES 页，防止无限翻页）。 */
  M.fetchCategory = function (category) {
    var MAX_PAGES = 4;
    var PAGE_SIZE = 50;
    var ctx = NS.list.sessionContext();
    var all = [];
    var page = 0;
    function step() {
      if (page >= MAX_PAGES) return Promise.resolve(all);
      return NS.courses
        .fetchCategory({
          category: category,
          studentCode: ctx.studentCode,
          batchCode: ctx.batchCode,
          token: NS.api.sessionToken(),
          pageNumber: page,
          pageSize: PAGE_SIZE,
        })
        .then(function (r) {
          if (r.kind !== NS.api.RESP_KIND.OK) {
            NS.warn('类别监控拉取失败 [' + r.kind + '] ' + r.msg + ' | ' + category);
            return all;
          }
          all = all.concat(r.classes || []);
          page += 1;
          if (!r.classes || r.classes.length < PAGE_SIZE) return all;
          return step();
        });
    }
    return step();
  };

  /** 按类别分组拉取，再把余量回填到对应的监控项。 */
  M._pollCategory = function () {
    var byCat = {};
    for (var i = 0; i < M.items.length; i++) {
      var cat = M.items[i].category;
      if (!cat) continue;
      if (!byCat[cat]) byCat[cat] = [];
      byCat[cat].push(M.items[i]);
    }
    var cats = Object.keys(byCat);
    if (!cats.length) {
      NS.warn('类别监控：监控项都缺类别代码，无法按类别查询');
      return Promise.resolve({ checked: 0, hits: [] });
    }
    var out = [];
    return cats
      .reduce(function (chain, cat) {
        return chain.then(function () {
          return M.fetchCategory(cat).then(function (classes) {
            var index = {};
            for (var k = 0; k < classes.length; k++) {
              index[classes[k].teachingClassID] = classes[k];
            }
            for (var j = 0; j < byCat[cat].length; j++) {
              var item = byCat[cat][j];
              var cls = index[item.teachingClassID];
              var remain = cls ? M.remainOfClass(cls) : null;
              M._apply(item.teachingClassID, remain);
              out.push({
                teachingClassID: item.teachingClassID,
                remain: remain,
                kind: cls ? 'ok' : 'notfound',
              });
            }
          });
        });
      }, Promise.resolve())
      .then(function () { return { checked: out.length, hits: M._hits(out) }; });
  };

  /* ---------------- 公共 ---------------- */

  M._apply = function (tcId, remain) {
    var item = M.byId(tcId);
    if (!item) return;
    item.remain = remain;
    item.checkedAt = Date.now();
    if (remain !== null && remain > 0) item.hits += 1;
    M.save();
  };

  M._hits = function (rows) {
    var hits = [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].remain !== null && rows[i].remain > 0) hits.push(rows[i]);
    }
    return hits;
  };

  /** 检查完的收尾：有命中则提醒，写接口开启时自动抢。 */
  M._afterCheck = function (res) {
    var hits = res.hits || [];
    if (hits.length) {
      M.hitCount += hits.length;
      M.save();
      var summary = hits.map(function (h) {
        var it = M.byId(h.teachingClassID);
        return (it && it.courseName ? it.courseName : h.teachingClassID) + ' 余量' + h.remain;
      }).join('；');
      NS.info('监控命中余量：' + summary);
      if (NS.ui) NS.ui.toast('发现余量：' + summary);

      if (!NS.isWriteAllowed(NS.settings())) {
        NS.warn('监控命中余量，但写接口未开启，只提醒不自动抢');
      } else {
        // 依次自动抢（队列会串行化，不会同时打服务器）
        hits.reduce(function (chain, h) {
          return chain.then(function () {
            var item = M.byId(h.teachingClassID);
            return item ? M.grabNow(item) : null;
          });
        }, Promise.resolve());
      }
    }
    if (NS.ui) NS.ui.render();
    return res;
  };

  /**
   * 监控命中后立即抢一次（走 MONITOR_HIT 最高优先级插队）。
   * 失败不在这里重试 —— 交给下一轮轮询再判断，避免死循环。
   */
  M.grabNow = function (item) {
    var s = NS.settings();
    if (!NS.isWriteAllowed(s)) return Promise.resolve({ ok: false, reason: 'write-disabled' });
    var ctx = NS.list.sessionContext();
    if (!ctx.batchCode || !ctx.studentCode) return Promise.resolve({ ok: false, reason: 'no-session' });
    if (!item.category) return Promise.resolve({ ok: false, reason: 'no-category' });

    var body = NS.api.buildVolunteerBody({
      studentCode: ctx.studentCode,
      electiveBatchCode: ctx.batchCode,
      teachingClassId: item.teachingClassID,
      campus: ctx.campus,
      teachingClassType: item.category,
    });
    return NS.api
      .send({
        action: '监控自动抢 ' + item.teachingClassID,
        url: NS.api.url(NS.api.EP.VOLUNTEER),
        method: 'POST',
        body: body,
        priority: NS.Queue.PRIORITY.MONITOR_HIT,
      })
      .then(function (r) {
        if (r.cls.kind === NS.api.RESP_KIND.OK) {
          NS.info('监控自动抢成功：' + (item.courseName || item.teachingClassID));
          if (NS.ui) NS.ui.toast('监控抢到：' + (item.courseName || item.teachingClassID));
          M.remove(item.teachingClassID);
          return { ok: true };
        }
        item.lastMsg = r.cls.msg || r.cls.kind;
        NS.warn('监控自动抢未成功 [' + r.cls.kind + '] ' + item.lastMsg);
        return { ok: false, reason: r.cls.kind, msg: item.lastMsg };
      });
  };

  /* ---------------- 轮询 ---------------- */

  M.startPolling = function () {
    if (M.polling) return false;
    if (!M.items.length) return false;
    M.polling = true;
    NS.info('开始监控轮询（' + (M.mode() === M.MODE.CATEGORY ? '类别' : '单独') + '模式）');
    if (NS.ui) NS.ui.toast('已开始监控轮询');
    M._loop();
    return true;
  };

  M._loop = function () {
    if (!M.polling) return;
    M.pollOnce().then(function () {
      if (!M.polling) return;
      var iv = NS.util.clamp(NS.settings().pollIntervalMs, 1000, 60000, 5000);
      M._timer = setTimeout(M._loop, iv);
    });
  };

  M.stopPolling = function () {
    M.polling = false;
    if (M._timer) {
      clearTimeout(M._timer);
      M._timer = null;
    }
    NS.info('已停止监控轮询');
    return true;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
