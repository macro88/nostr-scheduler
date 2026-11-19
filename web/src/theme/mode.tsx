import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const KEY = "nostr-scheduler-theme";
type Choice = "light" | "dark" | "system";

function stored(): Choice {
  try {
    const value = localStorage.getItem(KEY);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch {
    /* keep the system choice */
  }
  return "system";
}

function systemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function apply(choice: Choice) {
  const dark = choice === "dark" || (choice === "system" && systemDark());
  document.documentElement.dataset.theme = "nostr";
  document.documentElement.dataset.scheme = dark ? "dark" : "light";
}

const ThemeContext = createContext({
  dark: false,
  choice: "system" as Choice,
  setChoice: (_choice: Choice) => undefined as void,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<Choice>(stored);
  const dark = choice === "dark" || (choice === "system" && systemDark());
  useEffect(() => {
    apply(choice);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (choice === "system") apply("system");
    };
    media.addEventListener("change", onChange);
    const fit = () => {
      const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
      const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
      const viewport = window.visualViewport;
      const width = Math.min(window.innerWidth / safeZoom, viewport?.width ?? window.innerWidth);
      document.documentElement.dataset.fit = width <= 800 ? "stack" : "wide";
    };
    fit();
    const observed = new MutationObserver(fit);
    observed.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", fit);
    window.visualViewport?.addEventListener("resize", fit);
    return () => {
      media.removeEventListener("change", onChange);
      observed.disconnect();
      window.removeEventListener("resize", fit);
      window.visualViewport?.removeEventListener("resize", fit);
    };
  }, [choice]);
  const choose = (next: Choice) => {
    localStorage.setItem(KEY, next);
    setChoice(next);
  };
  return <ThemeContext.Provider value={{ dark, choice, setChoice: choose }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
