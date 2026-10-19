import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, next, describe, describeCalendar, validateCron, CronError } from "./cron";

test("parse mirrors the runtime: field forms, names, full ranges, rejections, the launchd cap", () => {
  const c = parse("0,30 7-9 * * 1-5");
  assert.deepEqual([...c.minute], [0, 30]);
  assert.deepEqual([...c.hour], [7, 8, 9]);
  assert.deepEqual(c.restricted, { dom: false, dow: true });
  assert.deepEqual([...parse("*/15 9 * * *").minute], [0, 15, 30, 45]);
  assert.deepEqual([...parse("0 9 * jan,jul *").month], [1, 7]);
  assert.deepEqual([...parse("0 9 * * sun,SAT").dow], [0, 6]);
  assert.equal(parse("0 9 * * 0-7").restricted.dow, false);
  for (const bad of ["", "0 9 * *", "60 9 * * *", "0 9 1 * 1", "*/15 * * * *", "a 9 * * *", "0 9 * * mond"]) {
    assert.throws(() => parse(bad), CronError, bad);
  }
  assert.equal(validateCron("0 13 * * *"), null);
  assert.match(validateCron("0 25 * * *") ?? "", /hour/);
});

test("next: strictly after, weekends skipped, month boundary, DST-safe", () => {
  const fri = new Date(2026, 8, 18, 20, 0);
  const [n1, n2] = next("45 7 * * 1-5", fri, 2);
  assert.deepEqual([n1.getDay(), n1.getDate(), n1.getHours(), n1.getMinutes()], [1, 21, 7, 45]);
  assert.equal(n2.getDate(), 22);
  const [jan] = next("0 9 1 * *", new Date(2026, 11, 31, 10, 0));
  assert.deepEqual([jan.getFullYear(), jan.getMonth(), jan.getDate()], [2027, 0, 1]);
  assert.deepEqual(next("0 9 30 feb *", new Date(2026, 0, 1)), []);
});

test("describe: the same phrases the CLI prints", () => {
  assert.equal(describe("0 13 * * *"), "Every day at 13:00");
  assert.equal(describe("45 7 * * 1-5"), "Weekdays at 07:45");
  assert.equal(describe("0 18 * * 0"), "Sundays at 18:00");
  assert.equal(describe("0 9 * * 1,3,5"), "Mon, Wed, Fri at 09:00");
  assert.equal(describe("0 9 1,15 * *"), "Monthly on days 1, 15 at 09:00");
  assert.equal(describe("*/30 * * * *"), "Every 30 minutes");
  assert.equal(describe("0 */6 * * *"), "Every 6 hours");
  assert.equal(describe("15 * * * *"), "Hourly at :15");
  assert.equal(describe("nope"), "nope");
});

test("describeCalendar: launchd entries back to a cadence", () => {
  assert.equal(describeCalendar([1, 2, 3, 4, 5].map((Weekday) => ({ Minute: 45, Hour: 7, Weekday }))), "Weekdays at 07:45");
  assert.equal(describeCalendar([{ Minute: 0, Hour: 13 }]), "Every day at 13:00");
  assert.equal(describeCalendar([{ Minute: 0, Hour: 9, Month: 1, Day: 1 }]), "1 calendar entries");
  assert.equal(describeCalendar([]), "no calendar");
});
