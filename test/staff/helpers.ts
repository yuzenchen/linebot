import { createStaffService, type StaffService } from '../../src/staff/service.js';
import type { EmployeeRow, ShiftSource } from '../../src/staff/repo.js';
import { taipeiInstant } from '../../src/staff/time.js';
import { memoryDb } from '../db/helpers.js';

export const OPTS = { minHourlyWage: 196, maxShiftHours: 16 };
export const ADMIN = 'Uadmin';

export function setup() {
  const db = memoryDb();
  const svc = createStaffService(db, OPTS);
  return { db, svc };
}

/** Taipei wall-clock → instant (`tp('2026-11-12', 9, 0)`), optional seconds. */
export function tp(date: string, hour: number, minute = 0, second = 0): Date {
  return new Date(taipeiInstant(date, hour, minute).getTime() + second * 1000);
}

/** Registers and approves an employee; wage effective from the approval day. */
export function hire(
  svc: StaffService,
  userId: string,
  name: string,
  wage: number,
  approvedAt: Date,
  groupId: string | null = 'Cgroup',
): EmployeeRow {
  const r = svc.register(userId, name, groupId, new Date(approvedAt.getTime() - 3_600_000));
  if (r.kind !== 'requested') throw new Error(`unexpected ${r.kind}`);
  const a = svc.approveRegistration(ADMIN, r.employee.id, wage, approvedAt);
  if (a.kind !== 'approved') throw new Error(`unexpected ${a.kind}`);
  return a.employee;
}

/** Inserts a shift directly (fixtures for payroll / overlap). */
export function addShift(
  svc: StaffService,
  employeeId: number,
  startAt: Date,
  endAt: Date | null,
  source: ShiftSource = 'punch',
): number {
  return svc.repo.shifts.insert(
    { employeeId, startAt, endAt, startSource: source, endSource: endAt ? source : null },
    startAt,
  );
}
