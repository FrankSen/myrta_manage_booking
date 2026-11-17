import { describe, expect, test } from 'vitest';
import { detectPage, freshText, hasNoTimeslotsMessage, loginProblem, hasTimeslotsData, parseBookingDetails, parseTimeslots } from '../src/site/parse.ts';

const html = (json: string) => `<html><script>var a = 1;</script><script>
  var timeslots = ${json};
  var other = {"x": "}"};
</script></html>`;

describe('parseTimeslots', () => {
  const json = JSON.stringify({
    ajaxresult: { slots: { listTimeSlot: [
      { startTime: '16/11/2026 8:00', availability: true, slotNumber: 4 },
      { startTime: '16/11/2026 8:30', availability: false, slotNumber: 5 },
      { startTime: '3/1/2027 15:30', availability: true, slotNumber: 9 },
    ] } },
  });
  test('解析日期、时间、是否可约', () => {
    expect(parseTimeslots(html(json))).toEqual([
      { date: '2026-11-16', time: '08:00', available: true, slotNumber: 4 },
      { date: '2026-11-16', time: '08:30', available: false, slotNumber: 5 },
      { date: '2027-01-03', time: '15:30', available: true, slotNumber: 9 },
    ]);
  });
  test('JSON 里的字符串含花括号也不影响取值', () => {
    const tricky = JSON.stringify({ note: 'a } b { c', ajaxresult: { slots: { listTimeSlot: [{ startTime: '1/1/2027 8:00', availability: true, slotNumber: 1 }] } } });
    expect(parseTimeslots(html(tricky))).toHaveLength(1);
  });
  test('页面没有 timeslots：返回空数组而不是抛错', () => {
    expect(parseTimeslots('<html>nothing</html>')).toEqual([]);
  });
  test('timeslots 内容损坏：抛错，调用方当作未知页面', () => {
    expect(() => parseTimeslots(html('{"ajaxresult": '))).toThrow();
  });
});

describe('hasTimeslotsData', () => {
  test('有数据脚本', () => expect(hasTimeslotsData('<script>var timeslots = {}</script>')).toBe(true));
  test('没有：可能没加载完，不能当作没有考位', () => expect(hasTimeslotsData('<html>Choose a time</html>')).toBe(false));
});

describe('hasNoTimeslotsMessage', () => {
  test('识别没有空位的提示', () => {
    expect(hasNoTimeslotsMessage('There are no timeslots available at this location.')).toBe(true);
    expect(hasNoTimeslotsMessage('Choose a time')).toBe(false);
  });
});

describe('parseBookingDetails', () => {
  const main = 'View booking\nBooking made:\t09/11/2026\nTest:\tCar : Driving Test (DT)\nTest location:\tSilverwater Service NSW Centre\nDate of test:\tWednesday, 30 December 2026\nTime of test:\t11:30 AM\nChange date/time';
  test('查看预约页', () => {
    expect(parseBookingDetails(main)).toEqual({ centreName: 'Silverwater Service NSW Centre', date: '2026-12-30', time: '11:30' });
  });
  test('确认页：考点后面跟着 "Change test location" 链接，不能被当作考点名', () => {
    const confirm = 'Confirm the following details:\nCustomer name:\tTest Person\nTest location:\tSilverwater Service NSW Centre\n« Change test location\nDate of test:\tThursday, 31 December 2026\nTime of test:\t8:00 AM\n« Change test date / time';
    expect(parseBookingDetails(confirm)).toEqual({ centreName: 'Silverwater Service NSW Centre', date: '2026-12-31', time: '08:00' });
  });
  test('下午和中午、午夜', () => {
    const t = (x: string) => parseBookingDetails(`Test location:\tA\nDate of test:\tMonday, 5 January 2026\nTime of test:\t${x}`).time;
    expect(t('3:30 PM')).toBe('15:30');
    expect(t('12:00 PM')).toBe('12:00');
    expect(t('12:30 AM')).toBe('00:30');
  });
  test('缺少字段：抛错', () => {
    expect(() => parseBookingDetails('Test location:\tA')).toThrow('日期');
    expect(() => parseBookingDetails('随便什么')).toThrow('考点');
  });
});

describe('detectPage', () => {
  const step = (n: number, name: string) => `step 1\ncompleted\nstep ${n}\nin progress\n${name}`;
  const main = 'https://www.myrta.com/wps/portal/extvp/myrta/licence/tbs/tbs-change-main/!ut/p/z1/xx';
  test('各步骤', () => {
    expect(detectPage('step 1\nin progress\nview booking', main)).toBe('main');
    expect(detectPage(step(2, 'choose location'), main)).toBe('choose_location');
    expect(detectPage(step(3, 'choose date/time'), main)).toBe('choose_time');
    expect(detectPage(step(4, 'confirm'), main)).toBe('confirm');
  });
  test('登录页：地址是 tbs-change 而不是 tbs-change-main', () => {
    expect(detectPage('Booking number\nFamily name', 'https://www.myrta.com/wps/portal/extvp/myrta/licence/tbs/tbs-change/!ut/p/z1/xx')).toBe('login');
  });
  test('被拦截页', () => {
    expect(detectPage('Service temporarily unavailable\nThis service is temporarily unavailable', 'https://www.myrta.com/')).toBe('blocked');
  });
  test('验证码', () => {
    expect(detectPage('Please complete the CAPTCHA to continue', main)).toBe('captcha');
  });
  test('不认识的页面：unknown，不抛错', () => {
    expect(detectPage('乱七八糟', main)).toBe('unknown');
    expect(detectPage('', '')).toBe('unknown');
  });
});

describe('loginProblem：点 Continue 后页面上新出现的提示', () => {
  const before = 'Manage booking\nBooking number\nFamily name\nMake sure your details are correct and not invalid\nContinue';
  test('资料不对的各种说法', () => {
    for (const line of [
      // 2026-11-17 实测站点原话
      'The details you have entered are incorrect, please check the details and try again or call the Contact Centre on 13 22 13.',
      'We cannot find a booking with these details. Please check your details and try again.',
      'The booking number and family name do not match our records.',
      'No booking found',
      'Booking number is invalid',
      "We couldn't locate your booking",
    ]) {
      expect(loginProblem(before, `${before}\n${line}`)).toEqual({ kind: 'bad_credentials', line });
    }
  });
  test('本来就在页面上的说明文字不算', () => {
    expect(loginProblem(before, before)).toBeNull();
    expect(loginProblem(before, `${before}\nPlease wait…`)).toBeNull();
  });
  test('必填项为空：是控件没初始化，不是资料错', () => {
    expect(loginProblem(before, `${before}\nEnter all mandatory fields`)).toMatchObject({ kind: 'widgets_missing' });
  });
  test('freshText 只给新出现的文字', () => {
    expect(freshText(before, `${before}\nSomething odd\nhappened`)).toBe('Something odd happened');
  });
});
