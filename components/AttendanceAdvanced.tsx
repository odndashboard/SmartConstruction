'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
  Archive, ArrowRight, Building2, CalendarDays, Check, CheckCircle2, ChevronDown,
  CircleAlert, Clock3, HardHat, LoaderCircle, MapPin, Moon, Pencil, Plus,
  RotateCcw, Settings2, ShieldCheck, Timer, UserRound, UsersRound, X,
} from 'lucide-react';
import type { Member, WorkspaceData } from '@/lib/types';
import type { OperationsData } from '@/lib/operations-types';
import type {
  AdvancedPanelProps, AttendanceSummary, ConstructionSite, ExtendedAttendanceRecord,
  OperationsExtension, ShiftRule,
} from '@/lib/operations-extensions';
import styles from './AttendanceAdvanced.module.css';

type Editor = { kind: 'site'; site?: ConstructionSite }
  | { kind: 'siteActive'; site: ConstructionSite; active: boolean }
  | { kind: 'assignment'; userId?: string }
  | { kind: 'shift' }
  | { kind: 'overtime'; recordId: string };
type OpenEditor = (editor: Editor) => void;
type Save = AdvancedPanelProps['save'];
type RecordStatus = ExtendedAttendanceRecord['status'];
const STATUS_LABELS: Record<RecordStatus, string> = { PRESENT: 'Present', HALF_DAY: 'Half day', ABSENT: 'Absent', LEAVE: 'Leave' };
const STATUS_SHORT: Record<RecordStatus, string> = { PRESENT: 'P', HALF_DAY: 'H', ABSENT: 'A', LEAVE: 'L' };
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SUMMARY_FIELDS = ['recordedDays', 'presentDays', 'halfDays', 'absentDays', 'leaveDays', 'openShifts', 'workedMinutes', 'lateDays', 'eligibleOvertimeMinutes', 'approvedOvertimeMinutes'] as const;

function minutes(value: number | null): string {
  if (value === null) return 'Not calculated';
  return `${Math.floor(value / 60).toLocaleString('en-IN')}h ${String(value % 60).padStart(2, '0')}m`;
}
function clock(value: string | null): string {
  if (!value) return '—';
  const hour = Number(value.slice(0, 2));
  return `${String(hour % 12 || 12).padStart(2, '0')}:${value.slice(3, 5)} ${hour >= 12 ? 'pm' : 'am'}`;
}
function time(value: string | null): string {
  return value ? new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—';
}
function date(value: string, weekday = false): string {
  return new Date(`${value}T12:00:00+05:30`).toLocaleDateString('en-IN', { ...(weekday ? { weekday: 'long' as const } : {}), day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
function dateTime(value: string): string {
  return new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}
function monthName(value: string): string {
  return new Date(`${value}-01T12:00:00+05:30`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
function scheduledMinutes(rule: ShiftRule): number | null {
  if (!rule.configured || !rule.startLocal || !rule.endLocal) return null;
  const asMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  return asMinutes(rule.endLocal) - asMinutes(rule.startLocal) + (rule.overnight ? 1440 : 0) - rule.breakMinutes;
}
function text(fields: FormData, name: string): string { return String(fields.get(name) ?? '').trim(); }
function archiveReasons(site: ConstructionSite, extension: OperationsExtension, members: Member[]): string[] {
  const reasons: string[] = [];
  const activeIds = new Set(members.filter(member => member.active).map(member => member.userId));
  const assignments = extension.assignments.filter(value => value.siteId === site.id && activeIds.has(value.userId)).length;
  const balances = extension.siteBalances.filter(value => value.siteId === site.id && value.quantityMilli > 0).length;
  const requests = extension.materialRequests.filter(value => value.siteId === site.id && ['SUBMITTED', 'APPROVED'].includes(value.status)).length;
  const orders = (extension.purchaseOrders || []).filter(value => value.siteId === site.id && ['OPEN', 'PART_RECEIVED'].includes(value.status)).length;
  if (assignments) reasons.push(`Reassign or unassign ${assignments} active ${assignments === 1 ? 'employee' : 'employees'}.`);
  if (balances) reasons.push(`Move or use the remaining stock in ${balances} ${balances === 1 ? 'item' : 'items'}.`);
  if (requests) reasons.push(`Complete or cancel ${requests} outstanding material ${requests === 1 ? 'request' : 'requests'}.`);
  if (orders) reasons.push(`Complete or cancel ${orders} outstanding purchase ${orders === 1 ? 'order' : 'orders'}.`);
  return reasons;
}
function editorTitle(editor: Editor): string {
  switch (editor.kind) {
    case 'site': return editor.site ? 'Edit construction site' : 'Add a construction site';
    case 'siteActive': return editor.active ? 'Restore construction site' : 'Archive construction site';
    case 'assignment': return 'Assign an employee to a site';
    case 'shift': return 'Configure the company shift';
    case 'overtime': return 'Review overtime approval';
  }
}

export default function AttendanceAdvanced(props: AdvancedPanelProps) {
  if (!props.data.extension) return null;
  return <AttendanceWorkspace key={`${props.data.user.userId}-${props.data.month}`} {...props} />;
}

function AttendanceWorkspace({ workspace, data, blocked, save }: AdvancedPanelProps) {
  const extension = data.extension;
  const admin = data.permissions.admin && data.user.role === 'OWNER';
  const [employeeId, setEmployeeId] = useState(admin ? 'all' : data.user.userId);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const sending = useRef(false);
  const alive = useRef(true);
  const locked = blocked || pending;
  const selectedEmployee = admin ? employeeId : data.user.userId;
  const records = extension.attendanceCalendar.filter(record => (admin || record.userId === data.user.userId) && (selectedEmployee === 'all' || record.userId === selectedEmployee));
  const summaries = extension.attendanceSummary.filter(summary => (admin || summary.userId === data.user.userId) && (selectedEmployee === 'all' || summary.userId === selectedEmployee));

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const close = useCallback(() => {
    if (locked) return;
    setEditor(null); setError('');
    requestAnimationFrame(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); });
  }, [locked]);
  useEffect(() => {
    if (!editor) return;
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const back = (event: Event) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault(); event.stopImmediatePropagation(); close();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('[role="dialog"][aria-modal="true"]')) { event.preventDefault(); close(); }
    };
    window.addEventListener('smart-construction-back', back, true);
    document.addEventListener('keydown', escape);
    return () => { window.removeEventListener('smart-construction-back', back, true); document.removeEventListener('keydown', escape); };
  }, [editor, close]);

  const open: OpenEditor = value => {
    if (!admin || !data.permissions.canWrite || locked) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setError(''); setEditor(value);
  };
  const submit: Save = async (action, payload) => {
    if (!admin || !data.permissions.canWrite || locked || sending.current) return false;
    sending.current = true; setPending(true); setError('');
    try {
      const saved = await save(action, payload);
      if (!alive.current) return saved;
      if (saved) {
        setEditor(null);
        requestAnimationFrame(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); });
      } else {
        setError('This change has not been confirmed. Review the workspace message above before trying again.');
        requestAnimationFrame(() => document.querySelector('[role="alert"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      }
      return saved;
    } catch {
      if (alive.current) setError('The change could not be confirmed. Review the workspace message before trying again.');
      return false;
    } finally { sending.current = false; if (alive.current) setPending(false); }
  };

  return <div className={styles.workspace}>
    {editor && admin && <section className={styles.editor} aria-label="Attendance settings form"><header className={styles.editorHeader}><div><span className={styles.eyebrow}>PEOPLE, PLACES &amp; WORKING HOURS</span><h2 tabIndex={-1} ref={heading}>{editorTitle(editor)}</h2></div><button className={styles.iconButton} aria-label="Close attendance form" disabled={locked} onClick={close}><X size={19} /></button></header>{error && <div className={styles.error} role="alert"><CircleAlert size={17} /><p>{error}</p></div>}<AttendanceEditor key={editor.kind === 'site' ? `site-${editor.site?.id || 'new'}` : editor.kind === 'assignment' ? `assignment-${editor.userId || 'new'}` : editor.kind === 'overtime' ? editor.recordId : editor.kind} editor={editor} workspace={workspace} data={data} locked={locked} save={submit} close={close} reportError={setError} /></section>}

    <div className={styles.setupGrid}><SitePanel workspace={workspace} data={data} admin={admin} blocked={locked} open={open} /><ShiftPanel rule={extension.shiftRule} admin={admin} blocked={locked} open={open} /></div>

    <section className={styles.card}><header className={styles.cardHeader}><div><span className={styles.eyebrow}>{monthName(data.month)}</span><h2>Monthly attendance</h2><p>{admin ? 'Review the full team month or focus on one employee.' : 'Your complete month of recorded attendance and working hours.'}</p></div>{admin && <label className={styles.employeeSelect}><span>Employee</span><select value={employeeId} disabled={locked} onChange={event => setEmployeeId(event.target.value)}><option value="all">All employees</option>{workspace.members.map(member => <option key={member.userId} value={member.userId}>{member.name}{member.active ? '' : ' (removed account)'}</option>)}</select></label>}</header>
      <MonthlySummary summaries={summaries} allTeam={admin && employeeId === 'all'} />
      <AttendanceCalendar month={data.month} today={data.today} records={records} admin={admin} allTeam={admin && employeeId === 'all'} />
    </section>
    <OvertimePanel records={records} admin={admin} blocked={locked} open={open} members={workspace.members} month={data.month} />
  </div>;
}

function SitePanel({ workspace, data, admin, blocked, open }: { workspace: WorkspaceData; data: OperationsData; admin: boolean; blocked: boolean; open: OpenEditor }) {
  const [showArchived, setShowArchived] = useState(false);
  const extension = data.extension;
  const sites = extension.sites.filter(site => site.kind === 'SITE' && (showArchived ? !site.active : site.active));
  const ownAssignment = extension.assignments.find(assignment => assignment.userId === data.user.userId);
  const ownSite = extension.sites.find(site => site.id === ownAssignment?.siteId);
  const linkedWork = (site: ConstructionSite) => workspace.workorders.find(order => order.id === site.workOrderId);
  const siteLabel = (id: string) => extension.sites.find(site => site.id === id)?.name || 'Assigned site';
  if (!admin) return <section className={`${styles.card} ${styles.setupCard}`}><header className={styles.setupHeader}><span className={styles.setupIcon}><MapPin size={21} /></span><div><span className={styles.eyebrow}>YOUR CURRENT ASSIGNMENT</span><h2>Construction site</h2></div></header>{ownSite && ownSite.active ? <div className={styles.mySite}><h3>{ownSite.name}</h3>{ownSite.address && <p>{ownSite.address}</p>}{linkedWork(ownSite) && <span className={styles.workLink}><HardHat size={14} />{linkedWork(ownSite)!.number} · {linkedWork(ownSite)!.title}</span>}<div className={styles.assignedPill}><CheckCircle2 size={13} />Assigned to you</div></div> : <div className={styles.setupEmpty}><MapPin size={24} /><h3>No active site assigned</h3><p>{data.permissions.canWrite ? 'Ask your administrator to assign a construction site before checking in.' : 'Your administrator can assign a construction site to this account.'}</p></div>}<p className={styles.cardNote}>Your assignment applies to new attendance. Past records keep their recorded site.</p></section>;
  const assigned = workspace.members.filter(member => extension.assignments.some(assignment => assignment.userId === member.userId));
  return <section className={`${styles.card} ${styles.setupCard}`}><header className={styles.setupHeader}><span className={styles.setupIcon}><Building2 size={21} /></span><div><span className={styles.eyebrow}>CURRENT SITES &amp; ASSIGNMENTS</span><h2>Construction sites</h2></div><button className={styles.smallButton} disabled={blocked} onClick={() => open({ kind: 'site' })}><Plus size={14} />Add site</button></header><div className={styles.siteToolbar}><div className={styles.segmented}><button aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>Active</button><button aria-pressed={showArchived} onClick={() => setShowArchived(true)}>Archived</button></div><button className={styles.textButton} disabled={blocked || !extension.sites.some(site => site.kind === 'SITE' && site.active)} onClick={() => open({ kind: 'assignment' })}><UsersRound size={14} />Assign employee</button></div>
    {sites.length ? <div className={styles.siteList}>{sites.map(site => <article key={site.id} className={styles.siteRow}><div><strong>{site.name}</strong>{site.address && <small>{site.address}</small>}{linkedWork(site) && <span className={styles.workLink}><HardHat size={12} />{linkedWork(site)!.number}</span>}<small>{extension.assignments.filter(assignment => assignment.siteId === site.id).length} assigned</small></div><div className={styles.rowActions}><button className={styles.iconButton} aria-label={`Edit ${site.name}`} title="Edit site" disabled={blocked || site.system} onClick={() => open({ kind: 'site', site })}><Pencil size={14} /></button><button className={styles.iconButton} aria-label={`${site.active ? 'Archive' : 'Restore'} ${site.name}`} title={site.active ? 'Archive site' : 'Restore site'} disabled={blocked || site.system} onClick={() => open({ kind: 'siteActive', site, active: !site.active })}>{site.active ? <Archive size={15} /> : <RotateCcw size={15} />}</button></div></article>)}</div> : <div className={styles.setupEmpty}><Building2 size={23} /><h3>{showArchived ? 'No archived sites' : 'Add your first construction site'}</h3><p>{showArchived ? 'Archived sites keep their attendance and material history.' : 'Create a site, then assign employees to it. You can also link the site to a work order.'}</p></div>}
    <details className={styles.assignments}><summary><UsersRound size={14} />Current team assignments <span>{assigned.length}</span><ChevronDown size={14} /></summary>{assigned.length ? assigned.map(member => <div className={styles.assignmentRow} key={member.userId}><span className={styles.personIcon}><UserRound size={15} /></span><div><strong>{member.name}{!member.active && <small> · removed account</small>}</strong><span>{siteLabel(extension.assignments.find(assignment => assignment.userId === member.userId)!.siteId)}</span></div><button className={styles.textButton} disabled={blocked} onClick={() => open({ kind: 'assignment', userId: member.userId })}>Change</button></div>) : <p>No employees have been assigned yet.</p>}</details>
  </section>;
}

function ShiftPanel({ rule, admin, blocked, open }: { rule: ShiftRule; admin: boolean; blocked: boolean; open: OpenEditor }) {
  return <section className={`${styles.card} ${styles.setupCard}`}><header className={styles.setupHeader}><span className={`${styles.setupIcon} ${styles.goldIcon}`}><Clock3 size={21} /></span><div><span className={styles.eyebrow}>APPLIES TO NEW ATTENDANCE</span><h2>Company shift</h2></div>{admin && <button className={styles.smallButton} disabled={blocked} onClick={() => open({ kind: 'shift' })}><Settings2 size={14} />{rule.configured ? 'Edit rules' : 'Configure'}</button>}</header>{rule.configured ? <div className={styles.shiftBody}><div className={styles.shiftTime}><strong>{clock(rule.startLocal)}</strong><ArrowRight size={17} /><strong>{clock(rule.endLocal)}</strong><span>IST</span></div>{rule.overnight && <div className={styles.overnight}><Moon size={13} />Finishes on the following day</div>}<dl className={styles.shiftFacts}><div><dt>Scheduled working time</dt><dd>{minutes(scheduledMinutes(rule))}</dd></div><div><dt>Break deducted</dt><dd>{rule.breakMinutes} min</dd></div><div><dt>Late-arrival grace</dt><dd>{rule.graceMinutes} min</dd></div></dl><p>Eligible overtime is recorded working time beyond the scheduled working time. Approval is recorded separately.</p></div> : <div className={styles.setupEmpty}><Clock3 size={25} /><h3>Shift rules are not configured</h3><p>Attendance hours can still be recorded. Late-arrival and eligible overtime calculations begin for new records once an administrator enables a shift rule.</p></div>}<p className={styles.cardNote}>Each attendance record keeps the shift rule in effect when it was created.</p></section>;
}

function MonthlySummary({ summaries, allTeam }: { summaries: AttendanceSummary[]; allTeam: boolean }) {
  const totals = Object.fromEntries(SUMMARY_FIELDS.map(field => [field, summaries.reduce((sum, summary) => sum + summary[field], 0)])) as Record<typeof SUMMARY_FIELDS[number], number>;
  return <div className={styles.monthlySummary}><div className={styles.summaryStats}><Stat label={allTeam ? 'Attendance records' : 'Recorded days'} value={String(totals.recordedDays)} icon={CalendarDays} /><Stat label="Recorded working time" value={minutes(totals.workedMinutes)} icon={Clock3} /><Stat label="Eligible overtime" value={minutes(totals.eligibleOvertimeMinutes)} icon={Timer} /><Stat label="Approved overtime" value={minutes(totals.approvedOvertimeMinutes)} icon={ShieldCheck} /></div><div className={styles.summaryBreakdown}><span><i className={styles.PRESENT} />{totals.presentDays} present</span><span><i className={styles.HALF_DAY} />{totals.halfDays} half day</span><span><i className={styles.ABSENT} />{totals.absentDays} absent</span><span><i className={styles.LEAVE} />{totals.leaveDays} leave</span><span>{totals.lateDays} late {totals.lateDays === 1 ? 'day' : 'days'}</span><span>{totals.openShifts} open {totals.openShifts === 1 ? 'shift' : 'shifts'}</span></div><p className={styles.summaryNote}>Complete month totals. Unrecorded days are not counted as absent; open shifts do not contribute completed working hours.</p></div>;
}
function Stat({ label, value, icon: Icon }: { label: string; value: string; icon: typeof Clock3 }) {
  return <div className={styles.stat}><span><Icon size={15} />{label}</span><strong>{value}</strong></div>;
}

function AttendanceCalendar({ month, today, records, admin, allTeam }: { month: string; today: string; records: ExtendedAttendanceRecord[]; admin: boolean; allTeam: boolean }) {
  const [selectedDay, setSelectedDay] = useState(today.startsWith(month) ? today : `${month}-01`);
  const calendar = useRef<HTMLTableElement>(null);
  const [year, monthNumber] = month.split('-').map(Number);
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const start = (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7;
  const cells = Array.from({ length: Math.ceil((start + days) / 7) * 7 }, (_, index) => index < start || index >= start + days ? null : `${month}-${String(index - start + 1).padStart(2, '0')}`);
  const grouped = new Map<string, ExtendedAttendanceRecord[]>();
  records.forEach(record => grouped.set(record.workDate, [...(grouped.get(record.workDate) || []), record]));
  const selected = grouped.get(selectedDay) || [];
  function navigate(event: KeyboardEvent<HTMLButtonElement>, value: string) {
    const day = Number(value.slice(8));
    const weekday = (start + day - 1) % 7;
    const target = event.key === 'ArrowLeft' ? day - 1 : event.key === 'ArrowRight' ? day + 1 : event.key === 'ArrowUp' ? day - 7 : event.key === 'ArrowDown' ? day + 7 : event.key === 'Home' ? day - weekday : event.key === 'End' ? day + 6 - weekday : null;
    if (target === null) return;
    event.preventDefault();
    const next = `${month}-${String(Math.max(1, Math.min(days, target))).padStart(2, '0')}`;
    setSelectedDay(next);
    calendar.current?.querySelector<HTMLButtonElement>(`button[data-date="${next}"]`)?.focus();
  }
  return <div className={styles.calendarSection}><div className={styles.calendarTop}><span><CalendarDays size={15} />{monthName(month)}</span><small>Select a date to see its records</small></div><table className={styles.calendar} ref={calendar}><caption className={styles.srOnly}>{monthName(month)} attendance calendar. Use arrow keys to move between dates.</caption><thead><tr>{WEEKDAYS.map(day => <th scope="col" key={day}><abbr title={day}>{day.slice(0, 3)}</abbr></th>)}</tr></thead><tbody>{Array.from({ length: cells.length / 7 }, (_, row) => <tr key={row}>{cells.slice(row * 7, row * 7 + 7).map((value, column) => {
    if (!value) return <td className={styles.calendarPad} key={`empty-${column}`} />;
    const entries = grouped.get(value) || [];
    const counts = (Object.keys(STATUS_LABELS) as RecordStatus[]).map(status => ({ status, count: entries.filter(record => record.status === status).length })).filter(item => item.count > 0);
    const statusText = counts.length ? counts.map(item => `${item.count} ${STATUS_LABELS[item.status].toLocaleLowerCase()}`).join(', ') : value > today ? 'Future date' : 'No attendance recorded';
    return <td key={value}><button data-date={value} tabIndex={selectedDay === value ? 0 : -1} aria-pressed={selectedDay === value} aria-label={`${date(value, true)}. ${statusText}`} className={`${styles.day} ${value === today ? styles.today : ''} ${value > today ? styles.future : ''} ${entries.length === 1 ? styles[`day${entries[0].status}`] : ''}`} onClick={() => setSelectedDay(value)} onKeyDown={event => navigate(event, value)}><span className={styles.dayNumber}>{Number(value.slice(8))}{value === today && <i />}</span>{entries.length ? <span className={styles.dayMarks}>{counts.map(item => <span key={item.status} className={styles[item.status]}><i />{allTeam ? item.count : STATUS_SHORT[item.status]}</span>)}</span> : <span className={styles.noRecord} aria-hidden="true">—</span>}</button></td>;
  })}</tr>)}</tbody></table><div className={styles.calendarLegend}>{(Object.keys(STATUS_LABELS) as RecordStatus[]).map(status => <span key={status}><i className={styles[status]} />{STATUS_LABELS[status]}</span>)}<span><i className={styles.unrecorded} />Not recorded</span></div>
    <section className={styles.dayDetails} aria-label="Selected date attendance"><header><div><span className={styles.eyebrow}>SELECTED DAY</span><h3>{date(selectedDay, true)}</h3></div><span aria-live="polite">{selected.length} {selected.length === 1 ? 'record' : 'records'}</span></header>{selected.length ? selected.map(record => <DayRecord key={record.id} record={record} admin={admin} />) : <div className={styles.dayEmpty}><CalendarDays size={22} /><p>{selectedDay > today ? 'This date has not arrived yet.' : 'No attendance has been recorded for this date.'}</p><small>{selectedDay <= today ? 'A blank day does not mean an employee was absent.' : 'Future dates are not marked as present or absent.'}</small></div>}</section>
  </div>;
}

function DayRecord({ record, admin }: { record: ExtendedAttendanceRecord; admin: boolean }) {
  const open = !!record.checkIn && !record.checkOut;
  return <article className={styles.dayRecord}><div className={styles.dayRecordTop}><div><strong>{admin ? record.memberName : 'Your attendance'}</strong><small>{record.site || 'No site recorded'}</small></div><span className={`${styles.status} ${styles[record.status]}`}>{STATUS_LABELS[record.status]}</span></div><div className={styles.dayRecordMetrics}><div><small>Check-in</small><strong>{time(record.checkIn)}</strong></div><div><small>Check-out</small><strong title={record.checkOut ? `${dateTime(record.checkOut)} IST` : undefined}>{time(record.checkOut)}</strong></div><div><small>Working time</small><strong>{open ? 'Shift open' : minutes(record.metrics.workedMinutes)}</strong></div><div><small>Approved overtime</small><strong>{minutes(record.metrics.approvedOvertimeMinutes)}</strong></div></div><details className={styles.recordDetails}><summary>Shift and attendance details <ChevronDown size={13} /></summary><dl>{record.shiftSnapshot.configured ? <><div><dt>Recorded shift</dt><dd>{clock(record.shiftSnapshot.startLocal)} – {clock(record.shiftSnapshot.endLocal)} IST{record.shiftSnapshot.overnight ? ' · next-day finish' : ''}</dd></div><div><dt>Scheduled working time</dt><dd>{minutes(record.metrics.expectedMinutes)}</dd></div><div><dt>Recorded break / grace</dt><dd>{record.shiftSnapshot.breakMinutes} min break · {record.shiftSnapshot.graceMinutes} min grace</dd></div><div><dt>Late arrival</dt><dd>{record.metrics.lateMinutes === null ? 'Not calculated' : `${record.metrics.lateMinutes} min`}</dd></div><div><dt>Eligible overtime</dt><dd>{minutes(record.metrics.eligibleOvertimeMinutes)}</dd></div></> : <div><dt>Shift rule</dt><dd>No configured shift was applied to this record.</dd></div>}{record.checkOut && <div><dt>Full check-out time</dt><dd>{dateTime(record.checkOut)} IST</dd></div>}{record.notes && <div><dt>Attendance notes</dt><dd>{record.notes}</dd></div>}{record.metrics.overtimeReason && <div><dt>Overtime approval note</dt><dd>{record.metrics.overtimeReason}</dd></div>}</dl></details></article>;
}

function OvertimePanel({ records, admin, blocked, open, members, month }: { records: ExtendedAttendanceRecord[]; admin: boolean; blocked: boolean; open: OpenEditor; members: Member[]; month: string }) {
  const [filter, setFilter] = useState<'all' | 'pending' | 'reviewed'>('all');
  const eligible = records.filter(record => record.checkIn && record.checkOut && record.shiftSnapshot.configured && ((record.metrics.eligibleOvertimeMinutes || 0) > 0 || record.metrics.approvedOvertimeMinutes > 0 || record.metrics.overtimeReviewedAt));
  const visible = eligible.filter(record => filter === 'all' || (filter === 'reviewed' ? !!record.metrics.overtimeReviewedAt : !record.metrics.overtimeReviewedAt));
  return <section className={styles.card}><header className={styles.cardHeader}><div><span className={styles.eyebrow}>{monthName(month)}</span><h2>{admin ? 'Overtime review' : 'Your overtime'}</h2><p>{admin ? 'Review eligible time from completed shifts and record the minutes approved.' : 'Eligible overtime and the minutes your administrator has approved.'}</p></div><span className={styles.readOnly}><ShieldCheck size={14} />{admin ? 'Administrator approval' : 'Approval required'}</span></header><div className={styles.overtimeToolbar}><div className={styles.segmented}>{[['all', 'All'], ['pending', 'Needs review'], ['reviewed', 'Reviewed']].map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value as typeof filter)}>{label}</button>)}</div><span>{visible.length} {visible.length === 1 ? 'shift' : 'shifts'}</span></div>{visible.length ? <div className={styles.overtimeList}>{visible.map(record => <article key={record.id} className={styles.overtimeRow}><span className={styles.overtimeIcon}><Timer size={19} /></span><div className={styles.overtimeIdentity}><strong>{admin ? record.memberName : date(record.workDate)}</strong><small>{admin ? `${date(record.workDate)} · ` : ''}{record.site || 'No site recorded'}</small><span>{record.metrics.overtimeReviewedAt ? record.metrics.approvedOvertimeMinutes > 0 ? 'Approval recorded' : 'No overtime approved' : 'Awaiting review'}</span></div><div className={styles.overtimeAmount}><small>Eligible</small><strong>{minutes(record.metrics.eligibleOvertimeMinutes)}</strong></div><div className={styles.overtimeAmount}><small>Approved</small><strong>{minutes(record.metrics.approvedOvertimeMinutes)}</strong></div>{admin && <button className={styles.smallButton} disabled={blocked} onClick={() => open({ kind: 'overtime', recordId: record.id })}><Pencil size={14} />{record.metrics.overtimeReviewedAt ? 'Review' : 'Approve'}</button>}{record.metrics.overtimeReviewedAt && <div className={styles.overtimeReview}><ShieldCheck size={13} /><p>{record.metrics.overtimeReason || 'Approval recorded'}<span>{members.find(member => member.userId === record.metrics.overtimeReviewedBy)?.name || 'Administrator'} · {dateTime(record.metrics.overtimeReviewedAt)} IST</span></p></div>}</article>)}</div> : <div className={styles.setupEmpty}><Timer size={25} /><h3>{eligible.length ? 'No shifts match this view' : 'No eligible overtime in this view'}</h3><p>{eligible.length ? 'Change the review filter to see other shifts.' : 'Eligible time appears after a configured shift is completed. Open shifts and records without a shift rule are not counted as overtime.'}</p></div>}</section>;
}

type EditorProps = { editor: Editor; workspace: WorkspaceData; data: OperationsData; locked: boolean; save: Save; close: () => void; reportError: (message: string) => void };
function AttendanceEditor(props: EditorProps) {
  const { editor, workspace, data, locked, save, close, reportError } = props;
  if (editor.kind === 'site') return <SiteForm site={editor.site} workspace={workspace} locked={locked} save={save} close={close} />;
  if (editor.kind === 'assignment') return <AssignmentForm userId={editor.userId} workspace={workspace} data={data} locked={locked} save={save} close={close} />;
  if (editor.kind === 'shift') return <ShiftForm rule={data.extension.shiftRule} locked={locked} save={save} close={close} reportError={reportError} />;
  if (editor.kind === 'overtime') {
    const record = data.extension.attendanceCalendar.find(value => value.id === editor.recordId);
    return record ? <OvertimeForm record={record} locked={locked} save={save} close={close} reportError={reportError} /> : <div className={styles.formNotice}><CircleAlert size={17} /><p>This attendance record is no longer in the selected month. Close this form and refresh the workspace.</p></div>;
  }
  const site = data.extension.sites.find(value => value.id === editor.site.id) || editor.site;
  const reasons = editor.active ? [] : archiveReasons(site, data.extension, workspace.members);
  return <form onSubmit={event => { event.preventDefault(); void save('site_active', { id: site.id, active: editor.active }); }}><div className={styles.confirmation}><Building2 size={27} /><h3>{site.name}</h3><p>{editor.active ? 'Restore this site so it can be used for employee assignments and new material movements.' : 'Archive the site when work is complete. Past attendance and material records remain available.'}</p>{reasons.length > 0 && <div className={styles.archiveBlock}><strong>Before archiving this site:</strong><ul>{reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}</div><Footer disabled={locked || !!reasons.length || site.system} closeDisabled={locked} close={close} label={editor.active ? 'Restore site' : 'Archive site'} /></form>;
}
function Field({ label, hint, wide = false, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return <label className={`${styles.field} ${wide ? styles.wide : ''}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function Footer({ disabled, closeDisabled = disabled, close, label }: { disabled: boolean; closeDisabled?: boolean; close: () => void; label: string }) {
  return <footer className={styles.formFooter}><button type="button" className="button button-secondary" disabled={closeDisabled} onClick={close}>Cancel</button><button type="submit" className="button button-primary" disabled={disabled}>{disabled && closeDisabled ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{label}</button></footer>;
}
function SiteForm({ site, workspace, locked, save, close }: { site?: ConstructionSite; workspace: WorkspaceData; locked: boolean; save: Save; close: () => void }) {
  return <form onSubmit={event => { event.preventDefault(); const fields = new FormData(event.currentTarget); void save('site_save', { ...(site ? { id: site.id } : {}), name: text(fields, 'name'), address: text(fields, 'address'), workOrderId: text(fields, 'workOrderId') || null }); }}><p className={styles.formIntro}>Give the construction site a clear name and address. Link a work order if it helps your team identify the project.</p><fieldset disabled={locked}><div className={styles.formGrid}><Field label="Site name *"><input name="name" required maxLength={200} defaultValue={site?.name} placeholder="Construction site / project name" /></Field><Field label="Linked work order"><select name="workOrderId" defaultValue={site?.workOrderId || ''}><option value="">No work order linked</option>{workspace.workorders.filter(order => !order.isDemo || order.id === site?.workOrderId).map(order => <option key={order.id} value={order.id}>{order.number} · {order.title}</option>)}</select></Field><Field label="Site address" wide><textarea name="address" maxLength={1000} rows={3} defaultValue={site?.address} placeholder="Address, landmark, or location details" /></Field></div></fieldset><Footer disabled={locked} close={close} label={site ? 'Save site details' : 'Create construction site'} /></form>;
}
function AssignmentForm({ userId, workspace, data, locked, save, close }: { userId?: string; workspace: WorkspaceData; data: OperationsData; locked: boolean; save: Save; close: () => void }) {
  const [selectedUser, setSelectedUser] = useState(userId || workspace.members.find(member => member.active)?.userId || '');
  const existing = data.extension.assignments.find(assignment => assignment.userId === selectedUser);
  const [siteId, setSiteId] = useState(existing?.siteId || '');
  const person = workspace.members.find(member => member.userId === selectedUser);
  const sites = data.extension.sites.filter(site => site.active && site.kind === 'SITE');
  return <form onSubmit={event => { event.preventDefault(); void save('site_assign', { userId: selectedUser, siteId: siteId || null }); }}><p className={styles.formIntro}>Each employee has one current construction site. A new assignment applies to future check-ins; past attendance keeps its recorded site.</p><fieldset disabled={locked}><div className={styles.formGrid}><Field label="Employee *"><select required value={selectedUser} onChange={event => { setSelectedUser(event.target.value); setSiteId(data.extension.assignments.find(assignment => assignment.userId === event.target.value)?.siteId || ''); }}>{workspace.members.filter(member => member.active || member.userId === userId).map(member => <option key={member.userId} value={member.userId}>{member.name}{member.active ? '' : ' (removed account)'}</option>)}</select></Field><Field label="Assigned site" hint={!person?.active ? 'A removed account can only be unassigned.' : 'Choose no assignment to remove the current site.'}><select value={siteId} onChange={event => setSiteId(event.target.value)}><option value="">No site assigned</option>{person?.active ? sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>) : siteId ? <option value={siteId} disabled>{data.extension.sites.find(site => site.id === siteId)?.name || 'Current site'} — current assignment</option> : null}</select></Field></div></fieldset><Footer disabled={locked || !selectedUser || (!person?.active && !!siteId)} closeDisabled={locked} close={close} label="Save site assignment" /></form>;
}
function ShiftForm({ rule, locked, save, close, reportError }: { rule: ShiftRule; locked: boolean; save: Save; close: () => void; reportError: (message: string) => void }) {
  const [configured, setConfigured] = useState(rule.configured);
  const [overnight, setOvernight] = useState(rule.overnight);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const fields = new FormData(event.currentTarget);
    if (!configured) { void save('shift_rule_save', { configured: false, startLocal: null, endLocal: null, overnight: false, breakMinutes: 0, graceMinutes: 0 }); return; }
    const startLocal = text(fields, 'start'), endLocal = text(fields, 'end');
    const breakMinutes = Number(text(fields, 'break')), graceMinutes = Number(text(fields, 'grace'));
    const atMinute = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
    const duration = atMinute(endLocal) - atMinute(startLocal) + (overnight ? 1440 : 0);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startLocal) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endLocal) || duration <= 0 || duration > 1440) { reportError('Choose valid shift times and check whether the finish is on the following day. A shift must be no longer than 24 hours.'); return; }
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes >= duration) { reportError('The break must be a whole number of minutes shorter than the shift.'); return; }
    if (!Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 120) { reportError('Enter a late-arrival grace period between 0 and 120 minutes.'); return; }
    void save('shift_rule_save', { configured, startLocal, endLocal, overnight, breakMinutes, graceMinutes });
  }
  return <form onSubmit={submit}><p className={styles.formIntro}>These rules apply to new attendance records. Existing records keep their original shift settings, including when an administrator corrects their times.</p><fieldset disabled={locked}><label className={styles.checkbox}><input type="checkbox" checked={configured} onChange={event => setConfigured(event.target.checked)} /><span><strong>Enable shift and overtime calculations</strong><small>Use the company shift to calculate scheduled hours, late arrival, and eligible overtime.</small></span></label>{configured ? <div className={styles.formGrid}><Field label="Shift starts (IST) *"><input name="start" type="time" step={60} required defaultValue={rule.startLocal?.slice(0, 5) || ''} /></Field><Field label="Shift finishes (IST) *"><input name="end" type="time" step={60} required defaultValue={rule.endLocal?.slice(0, 5) || ''} /></Field><div className={styles.wide}><label className={styles.checkbox}><input type="checkbox" checked={overnight} onChange={event => setOvernight(event.target.checked)} /><span><strong>Finishes on the following day</strong><small>Enable this for an overnight shift.</small></span></label></div><Field label="Break deducted (minutes) *" hint="Deducted once from recorded and scheduled working time."><input name="break" type="number" required min={0} max={1439} step={1} defaultValue={rule.breakMinutes} /></Field><Field label="Late-arrival grace (minutes) *" hint="Affects late arrival only; it does not extend the scheduled shift."><input name="grace" type="number" required min={0} max={120} step={1} defaultValue={rule.graceMinutes} /></Field></div> : <div className={styles.formNotice}><Clock3 size={18} /><p>New attendance will record elapsed hours without scheduled-hour, late-arrival, or eligible-overtime calculations.</p></div>}</fieldset><Footer disabled={locked} close={close} label="Save company shift" /></form>;
}
function OvertimeForm({ record, locked, save, close, reportError }: { record: ExtendedAttendanceRecord; locked: boolean; save: Save; close: () => void; reportError: (message: string) => void }) {
  const eligible = record.metrics.eligibleOvertimeMinutes;
  const canReview = !!record.checkIn && !!record.checkOut && record.shiftSnapshot.configured && eligible !== null;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const fields = new FormData(event.currentTarget);
    const approved = Number(text(fields, 'minutes')), reason = text(fields, 'reason');
    if (!canReview || !Number.isInteger(approved) || approved < 0 || approved > eligible!) { reportError('Approved minutes must be a whole number between zero and the eligible overtime for this completed shift.'); return; }
    if (!reason) { reportError('Add a reason or approval note before saving overtime.'); return; }
    void save('attendance_overtime_approve', { id: record.id, minutes: approved, reason });
  }
  return <form onSubmit={submit}><div className={styles.reviewContext}><span><Timer size={23} /></span><div><strong>{record.memberName}</strong><p>{date(record.workDate)} · {record.site || 'No site recorded'}</p></div></div><div className={styles.reviewMetrics}><Stat label="Recorded working time" value={minutes(record.metrics.workedMinutes)} icon={Clock3} /><Stat label="Eligible overtime" value={minutes(eligible)} icon={Timer} /><Stat label="Currently approved" value={minutes(record.metrics.approvedOvertimeMinutes)} icon={ShieldCheck} /></div><p className={styles.formIntro}>Confirm how many eligible minutes are approved for this shift. Enter zero with a reason to remove an existing approval or record that no overtime is approved.</p><fieldset disabled={locked || !canReview}><div className={styles.formGrid}><Field label="Approved overtime (minutes) *" hint={eligible === null ? 'This record does not have calculated eligible overtime.' : `Maximum ${eligible} minutes (${minutes(eligible)}).`}><input name="minutes" type="number" min={0} max={eligible ?? 0} step={1} required defaultValue={record.metrics.overtimeReviewedAt ? record.metrics.approvedOvertimeMinutes : eligible ?? 0} /></Field><Field label="Reason / approval note *" wide><textarea name="reason" required maxLength={2000} rows={3} placeholder="Explain the overtime approved or the reason for changing the approval" /></Field></div></fieldset><Footer disabled={locked || !canReview} closeDisabled={locked} close={close} label="Record overtime approval" /></form>;
}
