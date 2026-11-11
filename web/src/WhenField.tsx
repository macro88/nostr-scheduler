import { useState } from "react";
import { formatWhen } from "./format";

export function WhenField({
  value,
  onChange,
  testId = "schedule",
  invalid = false,
}: {
  value: number;
  onChange: (unix: number) => void;
  testId?: string;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const date = new Date(value * 1000);
  const setPart = (part: "day" | "month" | "year" | "hour" | "minute", raw: string) => {
    const next = new Date(date);
    const number = Number(raw);
    if (!Number.isFinite(number)) return;
    if (part === "day") next.setDate(number);
    if (part === "month") next.setMonth(number - 1);
    if (part === "year") next.setFullYear(number);
    if (part === "hour") next.setHours(number);
    if (part === "minute") next.setMinutes(number);
    next.setSeconds(0, 0);
    onChange(Math.floor(next.getTime() / 1000));
  };
  return (
    <div className="when-field">
      <button
        type="button"
        className={`date-ctrl${invalid ? " is-error" : ""}`}
        data-testid={testId}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        {formatWhen(value)}
      </button>
      {open ? (
        <div className="time-pop" role="dialog" aria-label="Choose a time" data-testid="time-picker">
          <label>
            Day
            <input data-testid="time-day" inputMode="numeric" value={date.getDate()} onChange={(event) => setPart("day", event.target.value)} />
          </label>
          <label>
            Month
            <input data-testid="time-month" inputMode="numeric" value={date.getMonth() + 1} onChange={(event) => setPart("month", event.target.value)} />
          </label>
          <label>
            Year
            <input data-testid="time-year" inputMode="numeric" value={date.getFullYear()} onChange={(event) => setPart("year", event.target.value)} />
          </label>
          <label>
            Hour
            <input data-testid="time-hour" inputMode="numeric" value={date.getHours()} onChange={(event) => setPart("hour", event.target.value)} />
          </label>
          <label>
            Minute
            <input data-testid="time-minute" inputMode="numeric" value={date.getMinutes()} onChange={(event) => setPart("minute", event.target.value)} />
          </label>
          <button type="button" className="btn btn-primary btn-sm" data-testid="time-apply" onClick={() => setOpen(false)}>
            Use this time
          </button>
        </div>
      ) : null}
    </div>
  );
}
