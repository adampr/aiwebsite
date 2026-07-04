"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Rise-on-scroll: adds .is-visible to .rise elements as they enter the
 * viewport (per the design system README). Re-runs on route change so
 * client-side navigations pick up new .rise elements.
 */
export function FuturismFx() {
  const pathname = usePathname();

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        }),
      { threshold: 0.12 },
    );
    document.querySelectorAll(".rise").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [pathname]);

  return null;
}
