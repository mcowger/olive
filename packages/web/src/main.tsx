import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { MeetingListItem } from "@olive/shared";

interface MeetingsResponse {
  meetings: MeetingListItem[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(timestamp));
}

function MeetingsPage(): ReactElement {
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    fetch("/api/meetings")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        return (await response.json()) as MeetingsResponse;
      })
      .then((data) => {
        if (!active) {
          return;
        }

        setMeetings(data.meetings);
        setLoading(false);
      })
      .catch((requestError: unknown) => {
        if (!active) {
          return;
        }

        setError(requestError instanceof Error ? requestError.message : "Unable to load meetings");
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="min-h-screen bg-stone-950 px-6 py-10 text-stone-100 sm:px-10">
      <div className="mx-auto max-w-5xl">
        <header className="mb-10 flex items-end justify-between border-b border-stone-800 pb-6">
          <div>
            <p className="mb-2 text-sm font-medium uppercase tracking-[0.3em] text-lime-400">Olive</p>
            <h1 className="text-4xl font-semibold tracking-tight">Meetings</h1>
          </div>
          <span className="rounded-full border border-stone-700 px-3 py-1 text-xs text-stone-400">M0</span>
        </header>

        {loading && <p className="text-stone-400">Loading meetings…</p>}

        {error && (
          <div className="rounded-xl border border-red-900 bg-red-950/40 p-5 text-red-200">
            Unable to load meetings: {error}
          </div>
        )}

        {!loading && !error && meetings.length === 0 && (
          <section className="rounded-2xl border border-dashed border-stone-700 bg-stone-900/60 px-6 py-16 text-center">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-lime-400/10 text-2xl text-lime-300">
              ○
            </div>
            <h2 className="mb-2 text-xl font-medium">No meetings yet</h2>
            <p className="mx-auto max-w-md text-sm leading-6 text-stone-400">
              Meetings will appear here when they are added to Olive.
            </p>
          </section>
        )}

        {!loading && !error && meetings.length > 0 && (
          <div className="space-y-3">
            {meetings.map((meeting) => (
              <article
                className="rounded-xl border border-stone-800 bg-stone-900 p-5 transition hover:border-lime-400/50"
                key={meeting.id}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-lg font-medium">{meeting.title}</h2>
                    <p className="mt-1 text-sm text-stone-400">{formatDate(meeting.startTime)}</p>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-stone-400">
                    <span className="rounded-full bg-stone-800 px-3 py-1 capitalize">{meeting.status}</span>
                    <span>{meeting.source}</span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MeetingsPage />
  </StrictMode>
);
