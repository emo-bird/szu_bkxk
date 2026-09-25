/**
 * 报文构造测试 —— 形状与字段顺序按 HAR 实测（docs/bkxk.szu.edu.cn-*.har）。
 * 注意：这些用例曾在重构中丢失过一次，导致 addParam 少包一层 data 的 bug 未被发现，
 *      故单独成文件，不要再合并进其它测试。
 */
import { test, eq, ok, loadNS, run } from './harness.mjs';

const NS = loadNS();

// ---------------- 抢课（写） ----------------

test('抢课报文：顶层必须包一层 data', () => {
  const body = NS.api.buildVolunteerBody({
    studentCode: '2026280121',
    electiveBatchCode: '915b08e32a184201b214960563a4d3e6',
    teachingClassId: '202620271990176000101',
    teachingClassType: 'FANKC',
  });
  ok(body.startsWith('addParam='), '前缀必须是 addParam=');
  const json = JSON.parse(decodeURIComponent(body.slice('addParam='.length)));
  eq(Object.keys(json), ['data'], '顶层只能有 data 一层');
});

test('抢课报文：内层字段顺序固定', () => {
  const body = NS.api.buildVolunteerBody({
    studentCode: '2026280121',
    electiveBatchCode: '915b08e32a184201b214960563a4d3e6',
    teachingClassId: '202620271990176000101',
    teachingClassType: 'FANKC',
  });
  const json = JSON.parse(decodeURIComponent(body.slice('addParam='.length)));
  eq(Object.keys(json.data), [
    'operationType',
    'studentCode',
    'electiveBatchCode',
    'teachingClassId',
    'isMajor',
    'campus',
    'teachingClassType',
  ], '顺序不得变动');
  eq(json.data.operationType, '1', 'operationType 固定为 1');
  eq(json.data.isMajor, '1', 'isMajor 默认 1');
  eq(json.data.campus, '01', 'campus 默认 01');
});

test('抢课报文：与 HAR 抓包逐字节一致', () => {
  // 取自 docs/bkxk.szu.edu.cn-1.har 中 volunteer.do 的原始请求体
  const expected =
    'addParam=%7B%22data%22%3A%7B%22operationType%22%3A%221%22%2C%22studentCode%22%3A%222026280121%22' +
    '%2C%22electiveBatchCode%22%3A%22915b08e32a184201b214960563a4d3e6%22%2C%22teachingClassId%22' +
    '%3A%22202620271990176000101%22%2C%22isMajor%22%3A%221%22%2C%22campus%22%3A%2201%22' +
    '%2C%22teachingClassType%22%3A%22FANKC%22%7D%7D';
  const actual = NS.api.buildVolunteerBody({
    studentCode: '2026280121',
    electiveBatchCode: '915b08e32a184201b214960563a4d3e6',
    teachingClassId: '202620271990176000101',
    teachingClassType: 'FANKC',
  });
  eq(actual, expected);
});

test('抢课报文：所有值都被转成字符串', () => {
  const body = NS.api.buildVolunteerBody({
    studentCode: 2026280121,
    electiveBatchCode: 'abc',
    teachingClassId: 123,
    teachingClassType: 'MOOC',
  });
  const json = JSON.parse(decodeURIComponent(body.slice('addParam='.length)));
  eq(typeof json.data.studentCode, 'string', 'studentCode');
  eq(typeof json.data.teachingClassId, 'string', 'teachingClassId');
  eq(typeof json.data.teachingClassType, 'string', 'teachingClassType');
});

test('抢课报文：operationType 不可被外部覆盖', () => {
  const body = NS.api.buildVolunteerBody({
    studentCode: '1', electiveBatchCode: 'b', teachingClassId: 't',
    teachingClassType: 'FANKC', operationType: '2',
  });
  const json = JSON.parse(decodeURIComponent(body.slice('addParam='.length)));
  eq(json.data.operationType, '1', '始终为 1');
});

// ---------------- 查容量（只读） ----------------

test('查容量报文：teachingClassId=..&batchCode=..', () => {
  const body = NS.api.buildCapacityBody('202620271130086001108', '915b08e32a184201b214960563a4d3e6');
  eq(body, 'teachingClassId=202620271130086001108&batchCode=915b08e32a184201b214960563a4d3e6');
});

// ---------------- 列表查询（只读） ----------------

test('列表查询报文：querySetting=<urlencode(JSON)>，含 data 与分页', () => {
  const body = NS.api.buildQueryBody({
    studentCode: '2026280121',
    electiveBatchCode: '915b08e32a184201b214960563a4d3e6',
    teachingClassType: 'TJKC',
  });
  ok(body.startsWith('querySetting='), '前缀必须是 querySetting=');
  const setting = JSON.parse(decodeURIComponent(body.slice('querySetting='.length)));
  eq(Object.keys(setting).slice(0, 2), ['data', 'pageSize'], '顶层结构');
  eq(setting.data.teachingClassType, 'TJKC');
  eq(setting.data.checkConflict, '2');
  eq(setting.data.checkCapacity, '2');
  eq(setting.pageSize, '10');
  eq(setting.pageNumber, '0');
  eq(setting.orderBy, 'courseNumber');
});

// ---------------- 通用 ----------------

test('id 与 batchCode 被正确 urlencode', () => {
  eq(NS.api.buildCapacityBody('a b&c', 'x=y'), 'teachingClassId=a%20b%26c&batchCode=x%3Dy');
});

test('URL 追加 13 位毫秒时间戳；已有 query 时用 &', () => {
  ok(/\?timestamp=\d{13}$/.test(NS.api.appendTimestamp('/a/b.do', 1790276333220)), '无 query');
  eq(NS.api.appendTimestamp('/a/b.do?x=1', 1790276333220), '/a/b.do?x=1&timestamp=1790276333220');
});

test('请求头含 token，且不含 cookie（同源自动附带）', () => {
  const h = NS.api.headers('TOKEN123');
  eq(h.token, 'TOKEN123');
  eq(h['X-Requested-With'], 'XMLHttpRequest');
  ok(!('cookie' in h) && !('Cookie' in h), '不得手工设置 cookie');
});

test('端点路径与实测一致', () => {
  eq(NS.api.EP.CAPACITY, 'elective/teachingclass/capacity.do');
  eq(NS.api.EP.VOLUNTEER, 'elective/volunteer.do');
  eq(NS.api.EP.PROGRAM_COURSE, 'elective/programCourse.do');
  eq(NS.api.EP.PUBLIC_COURSE, 'elective/publicCourse.do');
});

test('类别代码到端点的分派存在', () => {
  eq(NS.api.CATEGORY_EP.FANKC, 'elective/programCourse.do');
  eq(NS.api.CATEGORY_EP.MOOC, 'elective/publicCourse.do');
  eq(NS.api.CATEGORY_EP.TJKC, 'elective/recommendedCourse.do');
  eq(NS.api.CATEGORY_EP.XGXK, 'elective/publicCourse.do');
  eq(NS.api.CATEGORIES.length, 8, '含重修 CXKC（开发文档漏列）');
  ok(NS.api.CATEGORIES.indexOf('CXKC') !== -1, 'CXKC 在列');
});

test('抢课报文：teachingClassType 用传入的类别，不被全局设置覆盖', () => {
  const body = NS.api.buildVolunteerBody({
    studentCode: '1', electiveBatchCode: 'b', teachingClassId: 't',
    teachingClassType: 'XGXK', campus: '02',
  });
  const json = JSON.parse(decodeURIComponent(body.slice('addParam='.length)));
  eq(json.data.teachingClassType, 'XGXK');
  eq(json.data.campus, '02', 'campus 可覆盖');
});

await run();
