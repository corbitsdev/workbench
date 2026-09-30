function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

export function dayLabel(date: Date, now: Date = new Date()): string {
  if (sameDay(date, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

export function isSameDay(a: Date, b: Date): boolean {
  return sameDay(a, b);
}

export function DayDivider({ date }: { readonly date: Date }) {
  return <div className="chat-day">{dayLabel(date)}</div>;
}
