/**
 * 容量监控（本轮只做「登记 + 查询」，「自动轮询执行」留待 P1）。
 *
 * 两种模式（用户指定，默认类别模式）：
 *   - 单独监控：capacity.do，单课精确、报文极小
 *   - 类别监控：列表页，一次拿一类课程的余量
 *
 * 证据：capacity.do 响应除 mainClassCapacity / mainElectiveNumber 外几乎全为 null，
 * 因此必须自己记住教学班ID → 课程的对应关系，不能指望响应回填。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var M = (NS.monitor = NS.monitor || {});

  /** 已登记的教学班：teachingClassID → 记录。 */
  M.items = [];

  M.has = function (tcId) {
    for (var i = 0; i < M.items.length; i++) {
      if (M.items[i].teachingClassID === tcId) return true;
    }
    return false;
  };

  M.add = function (info) {
    if (!info || !info.teachingClassID) return null;
    if (M.has(info.teachingClassID)) return null;
    var rec = {
      teachingClassID: info.teachingClassID,
      courseName: info.courseName || '',
      teacherName: info.teacherName || '',
      teachingPlace: info.teachingPlace || '',
      category: info.category || '',
      mode: info.mode || 'single',
      remain: null,
      checkedAt: null,
      hits: 0,
    };
    M.items.push(rec);
    NS.info('加入监控 [' + rec.mode + '] ' + rec.teachingClassID, rec.courseName);
    return rec;
  };

  M.remove = function (tcId) {
    for (var i = 0; i < M.items.length; i++) {
      if (M.items[i].teachingClassID === tcId) {
        M.items.splice(i, 1);
        return true;
      }
    }
    return false;
  };

  /**
   * 查单个教学班的余量（只读，走限流队列）。
   * batchCode 必须用**页面会话里**的值（站点 capacity.do 用的就是它），
   * 不能只看设置里手填的那个 —— 之前用错来源导致 batchCode 为空。
   * @returns {Promise<{remain:(number|null), kind:string, msg:string}>}
   */
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
        for (var i = 0; i < M.items.length; i++) {
          if (M.items[i].teachingClassID === tcId) {
            M.items[i].remain = remain;
            M.items[i].checkedAt = Date.now();
            if (remain !== null && remain > 0) M.items[i].hits += 1;
          }
        }
        return { remain: remain, kind: 'ok', msg: r.cls.msg };
      });
  };

  /** 逐个查所有监控项（串行，队列本身已限流）。 */
  M.checkAll = function () {
    var ids = M.items.map(function (x) { return x.teachingClassID; });
    var out = [];
    return ids.reduce(function (chain, id) {
      return chain.then(function () {
        return M.checkOne(id).then(function (r) {
          out.push({ teachingClassID: id, remain: r.remain, kind: r.kind });
        });
      });
    }, Promise.resolve()).then(function () { return out; });
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
