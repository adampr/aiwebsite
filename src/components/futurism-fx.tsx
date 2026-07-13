"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Rise-on-scroll: adds .is-visible to .rise elements as they enter the
 * viewport (per the design system README). Re-runs on route change so
 * client-side navigations pick up new .rise elements.
 *
 * Fail-visible: content is only hidden once html.fx-ready is set (below,
 * before the observer is created), and a 2s watchdog force-reveals anything
 * still hidden, so a broken or wedged observer can never leave sections
 * invisible in production.
 */
export function FuturismFx() {
  const pathname = usePathname();

  useEffect(() => {
    // Opt into the hidden state only once the reveal machinery is live.
    document.documentElement.classList.add("fx-ready");
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        }),
      { rootMargin: "0px 0px -10%" },
    );
    document.querySelectorAll(".rise").forEach((el) => io.observe(el));
    // Watchdog: force-reveal anything the observer failed to reach.
    const failSafe = window.setTimeout(() => {
      document
        .querySelectorAll(".rise:not(.is-visible)")
        .forEach((el) => el.classList.add("is-visible"));
    }, 2000);
    return () => {
      io.disconnect();
      window.clearTimeout(failSafe);
    };
  }, [pathname]);

  return null;
}
