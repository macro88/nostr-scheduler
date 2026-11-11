const formatter = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((item) => item.type === type)?.value ?? "";
}

export function formatWhen(value: Date | number): string {
  const date = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : value;
  const parts = formatter.formatToParts(date);
  return `${part(parts, "weekday")} ${part(parts, "day")} ${part(parts, "month")}, ${part(parts, "hour")}:${part(parts, "minute")}`;
}

export function sameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

export function formatClock(value: Date | number): string {
  const date = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : value;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatQueueWhen(value: number, now = new Date()): string {
  const date = new Date(value * 1000);
  const clock = formatClock(date);
  if (sameLocalDay(date, now)) return `Today, ${clock}`;
  const weekday = date.toLocaleDateString("en-GB", { weekday: "short" });
  return `${weekday} ${date.getDate()}, ${clock}`;
}

export function startOfWeek(date: Date): Date {
  const next = new Date(date);
  const day = (next.getDay() + 6) % 7;
  next.setDate(next.getDate() - day);
  next.setHours(0, 0, 0, 0);
  return next;
}
