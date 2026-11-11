import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type Profile } from "./api";
import { Calendar } from "./screens/Calendar";
import { Composer } from "./screens/Composer";
import { Inbox } from "./screens/Inbox";
import { Log } from "./screens/Log";
import { Sign } from "./screens/Sign";

const views = ["inbox", "compose", "calendar", "log", "sign"] as const;
type View = (typeof views)[number];

export function App() {
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => api<Profile[]>("/api/profiles") });
  const [profileId, setProfileId] = useState("");
  const [view, setView] = useState<View>("inbox");
  const selected = profiles.data?.find((profile) => profile.id === profileId) ?? profiles.data?.[0];

  useEffect(() => {
    if (!profileId && profiles.data?.[0]) setProfileId(profiles.data[0].id);
  }, [profileId, profiles.data]);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onmessage = () => {
      void queryClient.invalidateQueries();
    };
    return () => source.close();
  }, [queryClient]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      if (event.key === "1") setView("inbox");
      if (event.key === "2") setView("compose");
      if (event.key === "3") setView("calendar");
      if (event.key === "4") setView("log");
      if (event.key === "5") setView("sign");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="mx-auto min-h-screen max-w-6xl px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-[#7a746a]">Local scheduler</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Today</h1>
        </div>
        <label className="text-sm text-[#5c564c]">
          Profile
          <select
            data-testid="profile"
            className="ml-2 h-10 rounded-full border border-[#d9d3c7] bg-white px-3"
            value={selected?.id ?? ""}
            onChange={(event) => setProfileId(event.target.value)}
          >
            {(profiles.data ?? []).map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
          </select>
        </label>
      </header>
      <nav className="mt-6 flex gap-2" aria-label="Sections">
        {views.map((name, index) => (
          <button
            key={name}
            data-testid={`nav-${name}`}
            className={`rounded-full px-4 py-2 text-sm capitalize ${view === name ? "bg-[#1c1b17] text-white" : "text-[#5c564c] hover:bg-[#ebe6dc]"}`}
            onClick={() => setView(name)}
          >
            {name}
            <span className="ml-2 text-xs opacity-60">{index + 1}</span>
          </button>
        ))}
      </nav>
      <main className="mt-8">
        {!selected ? <p className="text-[#6d675d]">Add a profile in the data directory to begin.</p> : null}
        {selected && view === "inbox" ? <Inbox profile={selected} /> : null}
        {selected && view === "compose" ? <Composer profile={selected} onDone={() => setView("calendar")} /> : null}
        {selected && view === "calendar" ? <Calendar profileId={selected.id} /> : null}
        {selected && view === "log" ? <Log /> : null}
        {selected && view === "sign" ? <Sign profile={selected} /> : null}
      </main>
    </div>
  );
}
