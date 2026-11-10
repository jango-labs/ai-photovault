/**
 * Backup retention: keep the most recent (4 per day for 3 days), one per day for 14 days, one per ISO week for 8 weeks, one per month for 12 months.
 * Two guarantees: the newest VERIFIED backup is never deleted, and backups are never all deleted. A backup that was never verified does not count
 * towards any bucket and is dropped once it is a week old (unless it is the only one).
 */
export interface BackupFile { name: string; at: Date; verified: boolean }
export interface Policy { perDayRecent: number; recentDays: number; dailyDays: number; weeklyWeeks: number; monthlyMonths: number; unverifiedGraceDays: number }
export const DEFAULT_POLICY: Policy = { perDayRecent: 4, recentDays: 3, dailyDays: 14, weeklyWeeks: 8, monthlyMonths: 12, unverifiedGraceDays: 7 };
const DAY = 86_400_000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const monthKey = (d: Date) => d.toISOString().slice(0, 7);
const weekKey = (d: Date) => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const dow = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - dow + 3); const y = t.getUTCFullYear(); const w1 = new Date(Date.UTC(y, 0, 4)); return `${y}-W${String(1 + Math.round(((t.getTime() - w1.getTime()) / DAY - 3 + ((w1.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`; };

export function planRetention(files: BackupFile[], now: Date, p: Policy = DEFAULT_POLICY): { keep: string[]; remove: string[] } {
  const sorted = [...files].sort((a, b) => b.at.getTime() - a.at.getTime());                           // newest first
  const keep = new Set<string>(); const age = (f: BackupFile) => (now.getTime() - f.at.getTime()) / DAY;
  const verified = sorted.filter((f) => f.verified);
  if (verified[0]) keep.add(verified[0].name);                                                          // never delete the newest verified backup
  const seenDay = new Map<string, number>(), seenDaily = new Set<string>(), seenWeek = new Set<string>(), seenMonth = new Set<string>();
  for (const f of verified) {
    const a = age(f);
    if (a <= p.recentDays) { const k = dayKey(f.at); const n = seenDay.get(k) ?? 0; if (n < p.perDayRecent) { seenDay.set(k, n + 1); keep.add(f.name); } }
    if (a <= p.dailyDays) { const k = dayKey(f.at); if (!seenDaily.has(k)) { seenDaily.add(k); keep.add(f.name); } }
    if (a <= p.weeklyWeeks * 7) { const k = weekKey(f.at); if (!seenWeek.has(k)) { seenWeek.add(k); keep.add(f.name); } }
    if (a <= p.monthlyMonths * 31) { const k = monthKey(f.at); if (!seenMonth.has(k)) { seenMonth.add(k); keep.add(f.name); } }
  }
  for (const f of sorted.filter((x) => !x.verified)) if (age(f) <= p.unverifiedGraceDays) keep.add(f.name);
  if (keep.size === 0 && sorted[0]) keep.add(sorted[0].name);                                           // never end up with nothing
  return { keep: sorted.filter((f) => keep.has(f.name)).map((f) => f.name), remove: sorted.filter((f) => !keep.has(f.name)).map((f) => f.name) };
}
