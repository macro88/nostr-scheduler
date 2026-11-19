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

export function zoneLabel(zone: string, offsetMinutesWest: number): string {
  const city = zone.split("/").at(-1)?.replaceAll("_", " ") || zone;
  if (city === "UTC" || zone === "Etc/UTC") return "UTC";
  const offset = -offsetMinutesWest;
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `${city} UTC${sign}${hours}:${minutes}`;
}

export function localZoneLabel(value: Date | number = new Date()): string {
  const date = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : value;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  return zoneLabel(zone, date.getTimezoneOffset());
}

export function sameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

export function formatClock(value: Date | number): string {
  const date = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : value;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function nextLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

export function formatQueueWhen(value: number, now = new Date()): string {
  const date = new Date(value * 1000);
  const clock = formatClock(date);
  if (sameLocalDay(date, now)) return `Today, ${clock}`;
  if (sameLocalDay(date, nextLocalDay(now))) return `Tomorrow, ${clock}`;
  return formatWhen(date);
}

export function startOfWeek(date: Date): Date {
  const next = new Date(date);
  const day = (next.getDay() + 6) % 7;
  next.setDate(next.getDate() - day);
  next.setHours(0, 0, 0, 0);
  return next;
}
