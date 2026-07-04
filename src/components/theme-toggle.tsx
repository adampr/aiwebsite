"use client";

import { useEffect, useSyncExternalStore } from "react";

type Theme = "light" | "dark" | "system";

const ICONS: Record<Theme, React.ReactNode> = {
  light: (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  ),
  dark: (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  ),
  system: (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  ),
};

const LABELS: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

const CYCLE: Theme[] = ["system", "light", "dark"];

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") {
    root.classList.remove("dark", "light");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.toggle("dark", prefersDark);
  } else if (theme === "dark") {
    root.classList.add("dark");
    root.classList.remove("light");
  } else {
    root.classList.remove("dark");
    root.classList.add("light");
  }
  // The futurism design system (futurism.css) is dark by default and keys
  // light mode off data-theme="light"; keep it in sync with the .dark class
  // that drives Tailwind's dark: variants.
  if (root.classList.contains("dark")) {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", "light");
  }
}

let themeListeners: Array<() => void> = [];
let currentTheme: Theme = "system";

function subscribeTheme(cb: () => void) {
  themeListeners.push(cb);
  return () => { themeListeners = themeListeners.filter((l) => l !== cb); };
}

function getThemeSnapshot(): Theme {
  return currentTheme;
}

function getThemeServerSnapshot(): Theme {
  return "system";
}

const emptySubscribe = () => () => {};
const getTrue = () => true;
const getFalse = () => false;

function setThemeValue(next: Theme) {
  currentTheme = next;
  localStorage.setItem("theme", next);
  applyTheme(next);
  for (const cb of themeListeners) cb();
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeServerSnapshot);

  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    if (stored && CYCLE.includes(stored) && stored !== currentTheme) {
      currentTheme = stored;
      for (const cb of themeListeners) cb();
    }
    applyTheme(currentTheme);

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (currentTheme === "system") applyTheme("system");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const mounted = useSyncExternalStore(emptySubscribe, getTrue, getFalse);

  function cycle() {
    const idx = CYCLE.indexOf(theme);
    const next = CYCLE[(idx + 1) % CYCLE.length];
    setThemeValue(next);
  }

  if (!mounted) {
    return (
      <button
        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
        aria-label="Toggle theme"
      >
        {ICONS.system}
      </button>
    );
  }

  return (
    <button
      onClick={cycle}
      className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-600 transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:border-neutral-500"
      aria-label={`Theme: ${LABELS[theme]}. Click to change.`}
      title={`Theme: ${LABELS[theme]}`}
    >
      {ICONS[theme]}
      <span className="hidden sm:inline">{LABELS[theme]}</span>
    </button>
  );
}
