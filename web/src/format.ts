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
