"use client";

import { Bookmark, Pin, StickyNote, Link, TrendingUp, TrendingDown, Minus, FolderOpen, LayoutGrid, CheckSquare2 } from "lucide-react";

interface ActivityDay {
  date: string;
  bookmarks: number;
  pins: number;
  notes: number;
  links: number;
}

interface Totals {
  bookmarks: number;
  pins: number;
  notes: number;
  links: number;
}

interface Insights {
  topFolder: { name: string; count: number } | null;
  topBoard:  { name: string; count: number } | null;
  velocity:  { thisWeek: number; lastWeek: number } | null;
}

interface HomeWidgetsProps {
  totals: Totals;
  activity: ActivityDay[];
  insights?: Insights | null;
  todoRate?: number | null;
}

const TYPES = [
  { key: "bookmarks" as const, label: "Bookmarks", icon: Bookmark, color: "#5b9888", bar: "bg-[#5b9888]" },
  { key: "pins"      as const, label: "Pins",      icon: Pin,      color: "#e05252", bar: "bg-[#e05252]" },
  { key: "notes"     as const, label: "Notes",     icon: StickyNote, color: "#d97706", bar: "bg-[#d97706]" },
  { key: "links"     as const, label: "Links",     icon: Link,     color: "#6366f1", bar: "bg-[#6366f1]" },
];

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayTotal(d: ActivityDay) {
  return d.bookmarks + d.pins + d.notes + d.links;
}

function computeStreak(activity: ActivityDay[]): number {
  const sorted = [...activity].sort((a, b) => b.date.localeCompare(a.date));
  let streak = 0;
  for (const day of sorted) {
    if (dayTotal(day) > 0) streak++;
    else break;
  }
  return streak;
}

function computeLongestStreak(activity: ActivityDay[]): number {
  const sorted = [...activity].sort((a, b) => a.date.localeCompare(b.date));
  let longest = 0, current = 0;
  for (const day of sorted) {
    if (dayTotal(day) > 0) { current++; longest = Math.max(longest, current); }
    else current = 0;
  }
  return longest;
}

function bestDayOfWeek(activity: ActivityDay[]): string | null {
  const totals = new Array(7).fill(0);
  for (const d of activity) {
    const dow = new Date(d.date + "T00:00:00").getDay();
    totals[dow] += dayTotal(d);
  }
  const max = Math.max(...totals);
  if (max === 0) return null;
  return DAY_LABELS[totals.indexOf(max)];
}

function heatColor(count: number, isStreakDay: boolean) {
  const ring = isStreakDay ? "ring-1 ring-amber-400/70 ring-offset-1 ring-offset-transparent" : "";
  if (count === 0) return `bg-black/[0.06] rounded-sm ${ring}`;
  if (count <= 2)  return `bg-[#5b9888]/30 rounded-sm ${ring}`;
  if (count <= 5)  return `bg-[#5b9888]/55 rounded-sm ${ring}`;
  if (count <= 10) return `bg-[#5b9888]/80 rounded-sm ${ring}`;
  return `bg-[#5b9888] rounded-sm ${ring}`;
}

function shortDate(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function buildCalendarGrid(days: ActivityDay[]) {
  if (days.length === 0) return { grid: [], numWeeks: 0, monthLabels: [] };

  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const firstDate = new Date(sorted[0].date + "T00:00:00");
  const startDow = firstDate.getDay();

  const byDate: Record<string, ActivityDay> = {};
  sorted.forEach(d => { byDate[d.date] = d; });

  const totalCells = startDow + sorted.length;
  const numWeeks = Math.ceil(totalCells / 7);

  const grid: (ActivityDay | null)[][] = Array.from({ length: 7 }, () =>
    Array(numWeeks).fill(null)
  );

  sorted.forEach((day, i) => {
    const cellIndex = startDow + i;
    const col = Math.floor(cellIndex / 7);
    const row = cellIndex % 7;
    grid[row][col] = day;
  });

  const monthLabels: { label: string; col: number }[] = [];
  sorted.forEach((day, i) => {
    const d = new Date(day.date + "T00:00:00");
    const cellIndex = startDow + i;
    const col = Math.floor(cellIndex / 7);
    if (d.getDate() === 1 || i === 0) {
      const last = monthLabels[monthLabels.length - 1];
      if (!last || last.col !== col) {
        monthLabels.push({ label: d.toLocaleDateString("en-US", { month: "short" }), col });
      }
    }
  });

  return { grid, numWeeks, monthLabels };
}

function getStreakDates(activity: ActivityDay[]): Set<string> {
  const sorted = [...activity].sort((a, b) => b.date.localeCompare(a.date));
  const set = new Set<string>();
  for (const day of sorted) {
    if (dayTotal(day) > 0) set.add(day.date);
    else break;
  }
  return set;
}

function velocityBadge(thisWeek: number, lastWeek: number) {
  if (lastWeek === 0 && thisWeek === 0) return null;
  if (lastWeek === 0) return { pct: 100, up: true };
  const pct = Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
  return { pct: Math.abs(pct), up: pct >= 0 };
}

export default function HomeWidgets({ totals, activity, insights, todoRate }: HomeWidgetsProps) {
  const streak = computeStreak(activity);
  const longestStreak = computeLongestStreak(activity);
  const days = [...activity].sort((a, b) => a.date.localeCompare(b.date));
  const { grid, numWeeks, monthLabels } = buildCalendarGrid(days);
  const streakDates = getStreakDates(activity);
  const bestDay = bestDayOfWeek(activity);

  const thirtyDay = {
    bookmarks: days.reduce((s, d) => s + d.bookmarks, 0),
    pins:      days.reduce((s, d) => s + d.pins, 0),
    notes:     days.reduce((s, d) => s + d.notes, 0),
    links:     days.reduce((s, d) => s + d.links, 0),
  };
  const thirtyTotal = Object.values(thirtyDay).reduce((a, b) => a + b, 0);

  const vel = insights?.velocity ? velocityBadge(insights.velocity.thisWeek, insights.velocity.lastWeek) : null;

  return (
    <div className="w-full max-w-2xl mx-auto px-4 grid grid-cols-2 gap-3">

      {/* ── LEFT PANEL ── */}
      <div className="flex flex-col gap-3">
        {/* 2×2 stat cards */}
        <div className="grid grid-cols-2 gap-2">
          {TYPES.map(({ key, label, icon: Icon, color }) => (
            <div key={key} className="bg-white/50 backdrop-blur-sm border border-white/60 rounded-2xl p-3 shadow-sm">
              <p className="text-2xl font-bold text-[#2a2a2a] leading-none">
                {totals[key].toLocaleString()}
              </p>
              <div className="flex items-center gap-1 mt-1.5">
                <Icon className="w-3 h-3 flex-shrink-0" style={{ color }} strokeWidth={2} />
                <p className="text-[10px] font-semibold tracking-widest text-[#3a3a3a]/40 uppercase">
                  {label}
                </p>
              </div>
              {/* Todo completion rate on Notes card */}
              {key === "notes" && todoRate !== null && todoRate !== undefined && (
                <div className="mt-2 flex items-center gap-1">
                  <CheckSquare2 className="w-3 h-3 flex-shrink-0 text-[#d97706]/60" strokeWidth={1.75} />
                  <div className="flex-1 h-1 bg-black/5 rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-[#d97706]/60 transition-all duration-700" style={{ width: `${todoRate}%` }} />
                  </div>
                  <span className="text-[9px] font-medium text-[#3a3a3a]/40">{todoRate}%</span>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Activity breakdown */}
        <div className="bg-white/50 backdrop-blur-sm border border-white/60 rounded-2xl p-3 shadow-sm flex-1">
          <div className="flex items-baseline justify-between mb-2.5">
            <p className="text-xs font-semibold text-[#2a2a2a]/80">Saved this month</p>
            <div className="flex items-center gap-1.5">
              {vel && (
                <span className={`flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${vel.up ? "bg-emerald-100/70 text-emerald-600" : "bg-red-100/70 text-red-500"}`}>
                  {vel.up
                    ? <TrendingUp className="w-2.5 h-2.5" strokeWidth={2.5} />
                    : <TrendingDown className="w-2.5 h-2.5" strokeWidth={2.5} />}
                  {vel.pct}%
                </span>
              )}
              <p className="text-[10px] font-semibold tracking-widest text-[#3a3a3a]/35 uppercase">
                Total · {thirtyTotal}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2.5">
            {TYPES.map(({ key, label, icon: Icon, color, bar }) => {
              const count = thirtyDay[key];
              const pct = thirtyTotal > 0 ? Math.round((count / thirtyTotal) * 100) : 0;
              return (
                <div key={key} className="flex items-center gap-2">
                  <Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color }} strokeWidth={1.75} />
                  <div className="flex-1 h-2 bg-black/5 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all duration-700 ${bar}`} style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-[10px] font-medium text-[#3a3a3a]/50 w-5 text-right">{pct}%</span>
                  <span className="text-[10px] text-[#3a3a3a]/35 w-6 text-right">{count}</span>
                </div>
              );
            })}
          </div>

          {/* Insight chips: top folder, top board */}
          {(insights?.topFolder || insights?.topBoard) && (
            <div className="flex flex-wrap gap-1.5 mt-3 pt-2.5 border-t border-black/5">
              {insights.topFolder && (
                <div className="flex items-center gap-1 bg-[#5b9888]/10 rounded-full px-2 py-0.5">
                  <FolderOpen className="w-2.5 h-2.5 text-[#5b9888]" strokeWidth={2} />
                  <span className="text-[9px] font-medium text-[#5b9888]/80 max-w-[70px] truncate">{insights.topFolder.name}</span>
                  <span className="text-[9px] text-[#5b9888]/50">{insights.topFolder.count}</span>
                </div>
              )}
              {insights.topBoard && (
                <div className="flex items-center gap-1 bg-[#e05252]/10 rounded-full px-2 py-0.5">
                  <LayoutGrid className="w-2.5 h-2.5 text-[#e05252]" strokeWidth={2} />
                  <span className="text-[9px] font-medium text-[#e05252]/80 max-w-[70px] truncate">{insights.topBoard.name}</span>
                  <span className="text-[9px] text-[#e05252]/50">{insights.topBoard.count}</span>
                </div>
              )}
              {bestDay && (
                <div className="flex items-center gap-1 bg-[#6366f1]/10 rounded-full px-2 py-0.5">
                  <Minus className="w-2.5 h-2.5 text-[#6366f1]" strokeWidth={2} />
                  <span className="text-[9px] font-medium text-[#6366f1]/80">Best · {bestDay}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── RIGHT PANEL — Calendar heatmap ── */}
      <div className="bg-white/50 backdrop-blur-sm border border-white/60 rounded-2xl p-3 shadow-sm flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between mb-2">
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-xl">🔥</span>
              <p className="text-xl font-bold text-[#2a2a2a] leading-none">{streak} day streak</p>
            </div>
          </div>
          {longestStreak > 0 && (
            <p className="text-[9px] font-semibold tracking-widest text-[#3a3a3a]/35 uppercase text-right leading-tight">
              Longest<br />streak · {longestStreak}d
            </p>
          )}
        </div>

        {/* Month labels */}
        <div className="flex ml-7 mb-0.5" style={{ gap: "3px" }}>
          {Array.from({ length: numWeeks }, (_, col) => {
            const month = monthLabels.find(m => m.col === col);
            return (
              <div key={col} className="flex-1 text-[9px] text-[#3a3a3a]/40 font-medium">
                {month ? month.label : ""}
              </div>
            );
          })}
        </div>

        {/* Grid: 7 rows (days) × numWeeks cols */}
        <div className="flex flex-col gap-[3px] flex-1">
          {DAY_LABELS.map((dayLabel, row) => (
            <div key={dayLabel} className="flex items-center gap-[3px]">
              <span className="text-[9px] text-[#3a3a3a]/35 w-6 flex-shrink-0 text-right pr-1">
                {row % 2 === 1 ? dayLabel : ""}
              </span>
              {Array.from({ length: numWeeks }, (_, col) => {
                const day = grid[row]?.[col] ?? null;
                if (!day) {
                  return <div key={col} className="flex-1 h-5 rounded-sm opacity-0" />;
                }
                const total = dayTotal(day);
                const isStreak = streakDates.has(day.date);
                return (
                  <div key={col} className="group relative flex-1 h-5">
                    <div className={`w-full h-full transition-all duration-150 cursor-default ${heatColor(total, isStreak)}`} />
                    <div className="absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 z-10 hidden group-hover:flex flex-col items-center pointer-events-none">
                      <div className="bg-[#2a2a2a]/90 text-white text-[10px] rounded-lg px-2 py-1 whitespace-nowrap shadow-lg">
                        <span className="font-medium">{shortDate(day.date)}</span>
                        {total > 0
                          ? <span className="text-white/60"> · {total} saved</span>
                          : <span className="text-white/40"> · nothing</span>}
                      </div>
                      <div className="w-1.5 h-1.5 bg-[#2a2a2a]/90 rotate-45 -mt-1" />
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-1">
            <span className="text-[9px] text-[#3a3a3a]/30">More</span>
            {["bg-[#5b9888]", "bg-[#5b9888]/80", "bg-[#5b9888]/55", "bg-[#5b9888]/30", "bg-black/[0.06]"].map((cls, i) => (
              <div key={i} className={`w-2.5 h-2.5 rounded-sm ${cls}`} />
            ))}
            <span className="text-[9px] text-[#3a3a3a]/30">Less</span>
          </div>
          {streak > 0 && (
            <div className="flex items-center gap-1">
              <div className="w-2.5 h-2.5 rounded-sm bg-black/[0.06] ring-1 ring-amber-400/70 ring-offset-1" />
              <span className="text-[9px] text-[#3a3a3a]/35">Current streak</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
