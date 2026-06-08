/** StageEvent timeline (NFR5 / architecture.md §8). Server component. */
import type { StageEvent } from "@/contracts";
import { stageLabel, stageStatusStyle, dateTime } from "./format";

export function StageTimeline({ events }: { events: StageEvent[] }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <header className="border-b border-gray-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-gray-800">Pipeline timeline</h2>
        <p className="text-xs text-gray-500">Every stage attempt, in order.</p>
      </header>
      <ol className="px-5 py-3">
        {events.length === 0 && <li className="text-sm text-gray-400">No events recorded.</li>}
        {events.map((ev, i) => {
          const s = stageStatusStyle(ev.status);
          const last = i === events.length - 1;
          return (
            <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
              {!last && <span className="absolute left-[5px] top-4 h-full w-px bg-gray-200" aria-hidden />}
              <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${s.dot}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-gray-900">{stageLabel(ev.stage)}</span>
                  <span className="text-[11px] text-gray-400">{dateTime(ev.at)}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs">
                  <span className={s.text}>{s.label}</span>
                  {ev.latencyMs != null && (
                    <span className="text-gray-500">{ev.latencyMs} ms</span>
                  )}
                  {ev.tokens != null && <span className="text-gray-500">{ev.tokens} tok</span>}
                </div>
                {ev.error && <p className="mt-0.5 text-xs text-rose-600">{ev.error}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
