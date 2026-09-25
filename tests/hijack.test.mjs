/**
 * 响应接管测试（分支 feature/api-response-hijack）。
 *
 * 样本按真机返回的真实形状手写并脱敏（docs/*.do.json 含学号，不入库）。
 * 覆盖：周次位图、课表注入、冲突改写、不覆盖站点已算冲突、开关关闭不接管。
 */
import { test, eq, ok, loadNS, run } from './harness.mjs';

const NS = loadNS();
const H = NS.hijack;

/** 脱敏的 teachingTime.do 样本（形状同真机）。 */
function timetableSample() {
  return {
    totalCount: 2,
    dataList: [
      {
        dayOfWeekName: '星期二', teachingClassID: 'TC-A', courseNumber: '1300680002',
        studentCode: 'X', courseName: '线性代数', courseIndex: '08', teacherName: '张勇',
        teachingPlace: '致理楼L1-302', sportCode: null, timeType: '1', sportName: null,
        studyMode: '01', weekName: '5-18周', beginSection: '9', endSection: '10',
        week: '000011111111111111', dayOfWeek: '2', wid: null,
      },
      {
        dayOfWeekName: '星期三', teachingClassID: 'TC-B', courseNumber: '1900000001',
        studentCode: 'X', courseName: 'C程序设计', courseIndex: '06', teacherName: '李',
        teachingPlace: '致理楼L3-708', sportCode: null, timeType: '1', sportName: null,
        studyMode: '01', weekName: '5-18周', beginSection: '3', endSection: '4',
        week: '000011111111111111', dayOfWeek: '3', wid: null,
      },
    ],
    msg: '查询学生课表成功', code: '1', timestamp: null,
  };
}

/** 脱敏的 programCourse.do 样本（嵌套 tcList）。 */
function listSample() {
  return {
    totalCount: 1,
    dataList: [{
      courseNumber: '1902210003', courseName: '线性代数',
      tcList: [
        {
          teachingClassID: 'T1', courseIndex: '06', teachingPlace: '5-18周星期三3-5节致理楼L1-207',
          isConflict: '0', conflictDesc: null, isFull: '1',
        },
        {
          teachingClassID: 'T2', courseIndex: '07', teachingPlace: '5-18周星期三3-4节致理楼L1-307',
          isConflict: '1', conflictDesc: 'C程序设计(5-18周星期三3-4节)', isFull: '1',
        },
      ],
    }],
    msg: '查询方案内选课成功', code: '1', timestamp: null,
  };
}

function resetCustom() {
  NS.custom.items = [];
  NS.saveSettings({ hijackTimetable: true, hijackListConflict: true });
}

// ---------- 周次位图 ----------

test('周次位图：5-18周 与真机样本一致', () => {
  eq(H.buildWeekBitmap(5, 18, null, 18), '000011111111111111');
});

test('周次位图：7-11周(单) 与真机样本一致', () => {
  eq(H.buildWeekBitmap(7, 11, '单', 18), '000000101010000000');
  eq(H.buildWeekBitmap(7, 11, '单', 11), '00000010101', '短位图也与样本一致');
});

test('周次位图：双周只取偶数周', () => {
  eq(H.buildWeekBitmap(1, 6, '双', 6), '010101');
});

test('周次文字：单周 / 区间 / 单双周标注', () => {
  eq(H.weekText({ weekFrom: 5, weekTo: 18, parity: null }), '5-18周');
  eq(H.weekText({ weekFrom: 3, weekTo: 3, parity: null }), '3周');
  eq(H.weekText({ weekFrom: 7, weekTo: 11, parity: '单' }), '7-11周(单)');
});

// ---------- 课表注入 ----------

test('课表注入：自定义课程追加为条目，星期/节次/周次正确', () => {
  resetCustom();
  NS.custom.add({ name: '旁听课', teacher: '王', place: '5-18周 星期二 3-4节 致理楼L1-100' });
  const src = timetableSample();
  const r = H.augmentTimetable(src, NS.custom.items);

  eq(r.added, 1, '追加 1 条');
  eq(src.dataList.length, 3, '原有 2 条 + 新增 1 条');
  const e = src.dataList[2];
  eq(e.dayOfWeek, '2', '星期二');
  eq(e.dayOfWeekName, '星期二');
  eq(e.beginSection, '3');
  eq(e.endSection, '4');
  eq(e.weekName, '5-18周');
  eq(e.week, '000011111111111111');
  eq(e.courseName, '旁听课');
  eq(e.teacherName, '王');
  eq(e.teachingPlace, '致理楼L1-100');
  eq(e.szuCustom, true, '带自定义标记');
  ok(String(e.teachingClassID).indexOf('szu-custom-') === 0, '教学班ID带前缀，避免与真实ID撞车');
});

test('课表注入：totalCount 同步增加', () => {
  resetCustom();
  NS.custom.add({ name: 'A', place: '5-18周 星期一 1-2节 X' });
  const src = timetableSample();
  const before = src.totalCount;
  H.augmentTimetable(src, NS.custom.items);
  eq(src.totalCount, before + 1);
});

test('课表注入：多段课程每段各成一条', () => {
  resetCustom();
  NS.custom.add({ name: 'A', place: '5-18周 星期一 1-2节 X,5-18周 星期四 3-4节 Y' });
  const src = timetableSample();
  const r = H.augmentTimetable(src, NS.custom.items);
  eq(r.added, 2);
  eq(src.dataList[2].dayOfWeek, '1');
  eq(src.dataList[3].dayOfWeek, '4');
});

test('课表注入：禁用的自定义课程不注入', () => {
  resetCustom();
  const c = NS.custom.add({ name: 'A', place: '5-18周 星期一 1-2节 X' });
  NS.custom.update(c.id, { enabled: false });
  const src = timetableSample();
  eq(H.augmentTimetable(src, NS.custom.items).added, 0);
});

test('课表注入：时间无法解析的课程不注入', () => {
  resetCustom();
  NS.custom.add({ name: 'A', place: '看不懂' });
  const src = timetableSample();
  eq(H.augmentTimetable(src, NS.custom.items).added, 0);
});

test('课表注入：非课表结构不炸（无 dataList）', () => {
  resetCustom();
  eq(H.augmentTimetable({ data: null }, []).added, 0);
  eq(H.augmentTimetable(null, []).added, 0);
});

// ---------- 冲突改写 ----------

test('冲突改写：与自定义课程撞时间的教学班被标冲突', () => {
  resetCustom();
  NS.custom.add({ name: '旁听课', place: '5-18周 星期三 3-4节 致理楼L1-100' });
  const src = listSample();
  const r = H.augmentList(src, NS.custom.items);

  eq(r.marked, 2, '两个教学班都落在同一时段');
  const tc0 = src.dataList[0].tcList[0];
  eq(tc0.isConflict, '1');
  ok(tc0.conflictDesc.indexOf('自定义课程：旁听课') === 0, '冲突说明标明来源: ' + tc0.conflictDesc);
  eq(tc0.szuCustomConflict, true);
});

test('冲突改写：不撞时间的教学班不动', () => {
  resetCustom();
  NS.custom.add({ name: '旁听课', place: '5-18周 星期五 1-2节 X' });
  const src = listSample();
  const r = H.augmentList(src, NS.custom.items);
  eq(r.marked, 0);
  eq(src.dataList[0].tcList[0].isConflict, '0', '原本不冲突的仍为 0');
});

test('冲突改写：绝不覆盖站点已算出的冲突说明，只追加', () => {
  resetCustom();
  NS.custom.add({ name: '旁听课', place: '5-18周 星期三 3-4节 X' });
  const src = listSample();
  H.augmentList(src, NS.custom.items);
  const tc1 = src.dataList[0].tcList[1];
  ok(tc1.conflictDesc.indexOf('C程序设计(5-18周星期三3-4节)') === 0, '站点原文保留在前');
  ok(tc1.conflictDesc.indexOf('自定义课程：旁听课') !== -1, '我们的说明追加在后');
});

test('冲突改写：站点原本不冲突的不被误标', () => {
  resetCustom();
  const src = listSample();
  H.augmentList(src, NS.custom.items);
  eq(src.dataList[0].tcList[0].isConflict, '0', '没有自定义课程时保持原样');
});

test('冲突改写：扁平结构（公选/慕课，一行即一个教学班）也覆盖', () => {
  resetCustom();
  NS.custom.add({ name: '旁听课', place: '5-18周 星期二 1-2节 X' });
  const flat = {
    code: '1',
    dataList: [{ teachingClassID: 'F1', teachingPlace: '5-18周星期二1-2节汇文楼H1-101', isConflict: '0', conflictDesc: null }],
  };
  const r = H.augmentList(flat, NS.custom.items);
  eq(r.marked, 1);
  eq(flat.dataList[0].isConflict, '1');
});

test('冲突改写：多个自定义课程同时撞上，说明里都列出', () => {
  resetCustom();
  NS.custom.add({ name: 'A', place: '5-18周 星期三 3-4节 X' });
  NS.custom.add({ name: 'B', place: '5-18周 星期三 4-5节 Y' });
  const src = listSample();
  H.augmentList(src, NS.custom.items);
  const desc = src.dataList[0].tcList[0].conflictDesc;
  ok(desc.indexOf('A') !== -1 && desc.indexOf('B') !== -1, '两个来源都出现: ' + desc);
});

// ---------- 端到端 transform + 开关 ----------

test('transform：课表端点返回改写后的 JSON 文本', () => {
  resetCustom();
  NS.custom.add({ name: '旁听课', place: '5-18周 星期二 3-4节 X' });
  const out = H.transform('timetable', JSON.stringify(timetableSample()));
  ok(out, '有改写');
  const j = JSON.parse(out);
  eq(j.dataList.length, 3);
  eq(j.dataList[2].courseName, '旁听课');
});

test('transform：开关关闭时不接管', () => {
  resetCustom();
  NS.custom.add({ name: '旁听课', place: '5-18周 星期二 3-4节 X' });
  NS.saveSettings({ hijackTimetable: false });
  eq(H.transform('timetable', JSON.stringify(timetableSample())), null, '课表接管已关');
  eq(H.enabled('timetable'), false);
  NS.saveSettings({ hijackListConflict: false });
  eq(H.transform('list', JSON.stringify(listSample())), null, '列表接管已关');
});

test('transform：两个开关互相独立', () => {
  resetCustom();
  NS.custom.add({ name: 'A', place: '5-18周 星期二 3-4节 X,5-18周 星期三 3-4节 Y' });
  NS.saveSettings({ hijackTimetable: false, hijackListConflict: true });
  eq(H.transform('timetable', JSON.stringify(timetableSample())), null);
  ok(H.transform('list', JSON.stringify(listSample())), '列表仍接管');
});

test('transform：code 非 1 的响应不接管', () => {
  resetCustom();
  NS.custom.add({ name: 'A', place: '5-18周 星期二 3-4节 X' });
  eq(H.transform('timetable', '{"code":"2","msg":"失败","dataList":[]}'), null);
});

test('transform：无改动时返回 null（不做无谓改写）', () => {
  resetCustom();
  eq(H.transform('timetable', JSON.stringify(timetableSample())), null, '没有自定义课程');
  eq(H.transform('list', JSON.stringify(listSample())), null);
});

test('transform：非 JSON 文本不接管也不抛错', () => {
  resetCustom();
  eq(H.transform('timetable', '<html>登录超时</html>'), null);
});

// ---------- URL 识别 ----------

test('kindOf：正确区分课表端点、列表端点与无关端点', () => {
  eq(H.kindOf('http://x/xsxkapp/sys/xsxkapp/elective/teachingTime.do?timestamp=1'), 'timetable');
  eq(H.kindOf('http://x/xsxkapp/sys/xsxkapp/elective/programCourse.do'), 'list');
  eq(H.kindOf('http://x/xsxkapp/sys/xsxkapp/elective/publicCourse.do'), 'list');
  eq(H.kindOf('http://x/xsxkapp/sys/xsxkapp/elective/recommendedCourse.do'), 'list');
  eq(H.kindOf('http://x/xsxkapp/sys/xsxkapp/elective/teachingclass/capacity.do'), null, '查容量不接管');
  eq(H.kindOf('http://x/xsxkapp/sys/xsxkapp/elective/volunteer.do'), null, '抢课写接口不接管');
  eq(H.kindOf('http://x/xsxkapp/sys/xsxkapp/elective/noArranged.do'), null, '未安排时间本轮不注入');
});

await run();
