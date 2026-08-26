"use client";

// Paged table for the scorecard click-through page (§5.19): server-fetched
// rows (<= REQUEST_CAPS.listMax), windowed client-side with the shared
// 10/50/All pager. Every cell arrives pre-formatted EXCEPT the timestamp,
// which arrives as a raw ISO instant and renders through <LocalTime>: the
// server page can only resolve the VM's zone (UTC), and this island is
// imported statically by that page, so it is server-rendered too and
// exact() would format UTC on that pass and the reader's zone in the
// browser - the hydration mismatch a6b52ef fixed.

import { PagerStrip, usePagedList } from "@/components/list-pager";
import { LocalTime } from "@/components/local-time";

export type ListRowData = {
  id: string;
  title: string;
  statusLabel: string;
  valueLabel: string;
  byLabel: string;
  /** ISO-8601 instant, or null when this column's timestamp is unset (a
   * claimed-but-unfinished row has no completedAt). The middot placeholder
   * for null lives in the cell below, not in the caller: the page cannot
   * format the non-null case, so it should not own the null case either. */
  dateIso: string | null;
};

export function RequestsListClient({
  rows,
  dateHeading,
  capNote,
}: {
  rows: ListRowData[];
  dateHeading: string;
  capNote: string | null;
}) {
  const pager = usePagedList(rows, "project");
  return (
    <div className="space-y-4">
      {pager.showPager && (
        <PagerStrip pager={pager} idPrefix="screq" />
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="mono text-xs uppercase tracking-[0.2em] text-faint">
              <th className="border-b border-[var(--xl-line)] py-2 pr-4 font-normal">
                Title
              </th>
              <th className="border-b border-[var(--xl-line)] py-2 pr-4 font-normal">
                Status
              </th>
              <th className="border-b border-[var(--xl-line)] py-2 pr-4 font-normal">
                Est. value / yr
              </th>
              <th className="border-b border-[var(--xl-line)] py-2 pr-4 font-normal">
                Requested by
              </th>
              <th className="border-b border-[var(--xl-line)] py-2 font-normal">
                {dateHeading}
              </th>
            </tr>
          </thead>
          <tbody>
            {pager.windowed.map((r) => (
              <tr key={r.id}>
                <td className="border-b border-[var(--xl-line)] py-2 pr-4">
                  {r.title}
                </td>
                <td className="border-b border-[var(--xl-line)] py-2 pr-4">
                  {r.statusLabel}
                </td>
                <td className="mono border-b border-[var(--xl-line)] py-2 pr-4 text-xs">
                  {r.valueLabel}
                </td>
                <td className="border-b border-[var(--xl-line)] py-2 pr-4">
                  {r.byLabel}
                </td>
                <td className="mono border-b border-[var(--xl-line)] py-2 text-xs">
                  {r.dateIso ? <LocalTime iso={r.dateIso} withTime /> : "·"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pager.showPager && (
        <PagerStrip pager={pager} idPrefix="screq" bottom />
      )}
      {capNote && <p className="mono text-xs text-faint">{capNote}</p>}
    </div>
  );
}
