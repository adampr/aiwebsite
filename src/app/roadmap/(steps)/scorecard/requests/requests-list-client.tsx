"use client";

// Paged table for the scorecard click-through page (§5.19): server-fetched
// rows (<= REQUEST_CAPS.listMax), windowed client-side with the shared
// 10/50/All pager. Purely presentational: every cell arrives pre-formatted.

import { PagerStrip, usePagedList } from "@/components/list-pager";

export type ListRowData = {
  id: string;
  title: string;
  statusLabel: string;
  valueLabel: string;
  byLabel: string;
  dateLabel: string;
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
        <PagerStrip pager={pager} idPrefix="screq" noun="project" />
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
                  {r.dateLabel}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pager.showPager && (
        <PagerStrip pager={pager} idPrefix="screq" noun="project" bottom />
      )}
      {capNote && <p className="mono text-xs text-faint">{capNote}</p>}
    </div>
  );
}
