import { useQuery } from "@tanstack/react-query";
import { api, type Item } from "../api";
import { StatusBadge } from "../components/ui";

export function Log() {
  const log = useQuery({ queryKey: ["log"], queryFn: () => api<Item[]>("/api/log") });
  return (
    <section data-testid="log">
      <h2 className="text-xl font-semibold">Sent and failed</h2>
      <ul className="mt-6 space-y-3">
        {(log.data ?? []).map((item) => (
          <li key={item.id} data-testid="log-item" className="rounded-3xl bg-white p-5">
            <div className="flex items-center gap-2">
              <StatusBadge status={item.status} />
              <p className="text-sm text-[#6d675d]">{item.preview}</p>
            </div>
            <ul className="mt-3 space-y-1 text-sm">
              {(item.results ?? []).map((result, index) => (
                <li key={`${result.relay}-${index}`} data-testid="relay-result">
                  {result.accepted ? "accepted" : "failed"} {result.relay} {result.message}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {(log.data ?? []).length === 0 ? <p className="mt-8 text-[#6d675d]">Nothing has been sent yet.</p> : null}
    </section>
  );
}
