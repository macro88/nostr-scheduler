import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type Profile } from "./api";
import { Calendar } from "./screens/Calendar";
import { Composer } from "./screens/Composer";
import { Inbox } from "./screens/Inbox";
import { Log } from "./screens/Log";
import { Sign } from "./screens/Sign";
import { ToastProvider } from "./toasts";

const views = ["inbox", "compose", "calendar", "log", "sign"] as const;
type View = (typeof views)[number];

export function App() {
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => api<Profile[]>("/api/profiles") });
  const [profileId, setProfileId] = useState("");
  const [view, setView] = useState<View>("inbox");
  const heading = useRef<HTMLHeadingElement>(null);
  const firstView = useRef(true);
  const selected = profiles.data?.find((profile) => profile.id === profileId) ?? profiles.data?.[0];
  const titles: Record<View, string> = {
    inbox: "Inbox",
    compose: "Write a note",
    calendar: "Queue",
    log: "Log",
    sign: "Sign",
  };
  const sections: Record<View, string> = {
    inbox: "Inbox",
    compose: "Compose",
    calendar: "Queue",
    log: "Log",
    sign: "Sign",
  };

  useEffect(() => {
    if (!profileId && profiles.data?.[0]) setProfileId(profiles.data[0].id);
  }, [profileId, profiles.data]);

  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    heading.current?.focus();
  }, [view]);

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
    <ToastProvider>
    <div className="mx-auto min-h-screen max-w-6xl px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-[#5c564c]">Local scheduler</p>
          <h1 ref={heading} tabIndex={-1} className="mt-1 text-3xl font-semibold tracking-tight outline-none">
            {titles[view]}
          </h1>
        </div>
        <label className="text-sm text-[#5c564c]">
          Profile
          <select
            data-testid="profile"
            aria-label="Profile"
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
            aria-current={view === name ? "page" : undefined}
            className={`rounded-full px-4 py-2 text-sm ${view === name ? "bg-[#1c1b17] text-white" : "text-[#5c564c] hover:bg-[#ebe6dc]"}`}
            onClick={() => setView(name)}
          >
            {sections[name]}
            <span className="ml-2 text-xs">{index + 1}</span>
          </button>
        ))}
      </nav>
      <main className="mt-8">
        {!selected && !profiles.isPending ? <p>Add a profile in the data directory to begin.</p> : null}
        {selected && view === "inbox" ? <Inbox profile={selected} onCompose={() => setView("compose")} /> : null}
        {selected && view === "compose" ? <Composer profile={selected} /> : null}
        {selected && view === "calendar" ? <Calendar profileId={selected.id} /> : null}
        {selected && view === "log" ? <Log /> : null}
        {selected && view === "sign" ? <Sign profile={selected} /> : null}
      </main>
    </div>
    </ToastProvider>
  );
}
