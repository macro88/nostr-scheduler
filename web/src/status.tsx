import { Badge } from "@macro88/ui";
import { statusWord } from "./labels";

export function StatusMark({ status }: { status: string }) {
  const word = statusWord(status);
  if (status === "failed" || status === "missed") {
    return (
      <span className="status-slot" data-testid={`status-${status}`}>
        <Badge tone={status === "failed" ? "danger" : "warning"}>{word}</Badge>
      </span>
    );
  }
  return (
    <span className="status status-slot" data-testid={`status-${status}`}>
      {word}
    </span>
  );
}
