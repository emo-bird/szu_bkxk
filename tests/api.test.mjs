/**
 * 响应分类测试 —— 判定顺序按实测行为，不得调整。
 * 样例取自 HAR 真实响应。
 */
import { test, eq, ok, loadNS, run } from './harness.mjs';

const NS = loadNS();
const K = NS.api.RESP_KIND;

test('code=1 → 成功（真实 capacity.do 响应）', () => {
  const text = JSON.stringify({
    data: { mainClassCapacity: '55', mainElectiveNumber: '52' },
    msg: '查询教学班课容量成功',
    code: '1',
    timestamp: null,
  });
  const c = NS.api.classify({ status: 200, text });
  eq(c.kind, K.OK);
  eq(c.data.mainClassCapacity, '55');
});

test('code=2 → 业务拒绝，msg 即原因', () => {
  const c = NS.api.classify({ status: 200, text: JSON.stringify({ code: '2', msg: '已选人数超过课容量' }) });
  eq(c.kind, K.BUSINESS);
  eq(c.msg, '已选人数超过课容量');
});

test('code=302 → 登录失效', () => {
  const c = NS.api.classify({ status: 200, text: JSON.stringify({ code: '302', msg: '请重新登录' }) });
  eq(c.kind, K.UNAUTHENTICATED);
});

test('HTTP 401/403 → 登录失效（优先于内容判定）', () => {
  eq(NS.api.classify({ status: 401, text: '{"code":"1"}' }).kind, K.UNAUTHENTICATED);
  eq(NS.api.classify({ status: 403, text: '{"code":"1"}' }).kind, K.UNAUTHENTICATED);
});

test('非 JSON → 未识别', () => {
  const c = NS.api.classify({ status: 200, text: '<html>登录超时</html>' });
  eq(c.kind, K.UNKNOWN);
});

test('code 未知但 msg 含「登录」→ 登录失效（兜底分支）', () => {
  eq(NS.api.classify({ status: 200, text: '{"code":"999","msg":"登录状态已失效"}' }).kind, K.UNAUTHENTICATED);
  eq(NS.api.classify({ status: 200, text: '{"code":"999","msg":"统一身份认证失败"}' }).kind, K.UNAUTHENTICATED);
});

test('其它未知 code → 未识别（调用方须全量落档）', () => {
  eq(NS.api.classify({ status: 200, text: '{"code":"888","msg":"系统繁忙"}' }).kind, K.UNKNOWN);
});

test('code 是数字类型也能识别', () => {
  eq(NS.api.classify({ status: 200, text: '{"code":1,"msg":"ok"}' }).kind, K.OK);
  eq(NS.api.classify({ status: 200, text: '{"code":2,"msg":"no"}' }).kind, K.BUSINESS);
});

test('JSON 顶层是数组 → 未识别', () => {
  eq(NS.api.classify({ status: 200, text: '[1,2,3]' }).kind, K.UNKNOWN);
});

test('capacity 余量：55-52=3（真实响应）', () => {
  eq(NS.api.capacityRemain({ mainClassCapacity: '55', mainElectiveNumber: '52' }), 3);
});

test('capacity 余量：字段缺失必须返回 null，不能是 0', () => {
  eq(NS.api.capacityRemain({}), null, '空对象');
  eq(NS.api.capacityRemain({ mainClassCapacity: '55' }), null, '缺 mainElectiveNumber');
  eq(NS.api.capacityRemain({ mainElectiveNumber: '52' }), null, '缺 mainClassCapacity');
  eq(NS.api.capacityRemain(null), null, 'null 输入');
  eq(NS.api.capacityRemain({ mainClassCapacity: null, mainElectiveNumber: null }), null, '两者皆 null');
});

test('capacity 余量：可为 0 与负数', () => {
  eq(NS.api.capacityRemain({ mainClassCapacity: '55', mainElectiveNumber: '55' }), 0, '满课为 0');
  eq(NS.api.capacityRemain({ mainClassCapacity: '55', mainElectiveNumber: '58' }), -3, '超额为负');
});

test('未识别落档包含原文与长度', () => {
  const dump = NS.dumpUnknown({ action: 'act', url: 'u', body: 'b', text: 'RAW_BODY_TEXT' });
  ok(dump.includes('[未识别返回]'), '含标记');
  ok(dump.includes('RAW_BODY_TEXT'), '含原文');
  ok(dump.includes('长度: 13'), '含长度');
});

test('从列表响应提取 batchCode（课程的 electiveBatchCode 字段）', () => {
  const json = { data: { dataList: [{ electiveBatchCode: '915b08e32a184201b214960563a4d3e6', tcList: [] }] } };
  const got = NS.api.extractBatchCode(json);
  eq(got.batchCode, '915b08e32a184201b214960563a4d3e6');
});

await run();
