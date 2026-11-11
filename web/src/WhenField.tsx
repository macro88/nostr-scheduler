import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatWhen } from "./format";

type Parts = { day: string; month: string; year: string; hour: string; minute: string };

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function partsFrom(unix: number): Parts {
  const date = new Date(unix * 1000);
  return {
    day: pad(date.getDate()),
    month: pad(date.getMonth() + 1),
    year: String(date.getFullYear()),
    hour: pad(date.getHours()),
    minute: pad(date.getMinutes()),
  };
}

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
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [parts, setParts] = useState<Parts>(() => partsFrom(value));
  const [box, setBox] = useState({ top: 8, left: 8 });

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = buttonRef.current;
    const pop = popRef.current;
    if (!anchor || !pop) return;
    const rect = anchor.getBoundingClientRect();
    const popBox = pop.getBoundingClientRect();
    let left = rect.left;
    if (left + popBox.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - popBox.width);
    let top = rect.bottom + 8;
    if (top + popBox.height > window.innerHeight - 8) top = Math.max(8, rect.top - popBox.height - 8);
    setBox({ top, left });
  }, [open, parts]);

  useLayoutEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  const apply = () => {
    const next = new Date(value * 1000);
    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    if (![year, month, day, hour, minute].every((part) => Number.isFinite(part))) return;
    next.setFullYear(year, month - 1, day);
    next.setHours(hour, minute, 0, 0);
    onChange(Math.floor(next.getTime() / 1000));
    setOpen(false);
  };

  const field = (name: keyof Parts, label: string, test: string) => (
    <label>
      <span>{label}</span>
      <input
        data-testid={test}
        aria-label={label}
        inputMode="numeric"
        autoComplete="off"
        value={parts[name]}
        onChange={(event) => setParts((current) => ({ ...current, [name]: event.target.value }))}
      />
    </label>
  );

  return (
    <div className="when-field">
      <button
        ref={buttonRef}
        type="button"
        className={`date-ctrl${invalid ? " is-error" : ""}`}
        data-testid={testId}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen((current) => {
            if (!current) setParts(partsFrom(value));
            return !current;
          });
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 9h18M8 3v4M16 3v4" />
        </svg>
        {formatWhen(value)}
      </button>
      {open
        ? createPortal(
            <div
              ref={popRef}
              className="time-pop"
              role="dialog"
              aria-label="Choose a time"
              data-testid="time-picker"
              style={{ top: box.top, left: box.left }}
            >
              {field("day", "Day", "time-day")}
              {field("month", "Month", "time-month")}
              {field("year", "Year", "time-year")}
              {field("hour", "Hour", "time-hour")}
              {field("minute", "Minute", "time-minute")}
              <button type="button" className="btn btn-primary btn-sm time-apply" data-testid="time-apply" onClick={apply}>
                Use this time
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
