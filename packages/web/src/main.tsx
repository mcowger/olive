import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { Artifact, MeetingListItem, Recording, Speaker, StageRunRow } from "@olive/shared";

interface MeetingsResponse {
  meetings: MeetingListItem[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

interface MeetingDetailResponse {
  meeting: MeetingListItem;
  recordings: Recording[];
  artifacts: Artifact[];
  speakers: Speaker[];
  stageRuns: StageRunRow[];
  transcriptContent?: string | null;
  summaryContent?: string | null;
}

interface SpeakerWithStats extends Speaker {
  meetingCount: number;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(timestamp));
}

function formatDuration(ms: number): string {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}

function formatTimeOffset(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function App(): ReactElement {
  const [activeTab, setActiveTab] = useState<"meetings" | "speakers">("meetings");
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);

  // Global speakers cache
  const [knownSpeakers, setKnownSpeakers] = useState<SpeakerWithStats[]>([]);

  const refreshSpeakers = async () => {
    try {
      const res = await fetch("/api/speakers");
      if (res.ok) {
        const data = (await res.json()) as { speakers: SpeakerWithStats[] };
        setKnownSpeakers(data.speakers);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void refreshSpeakers();
  }, []);

  return (
    <div className="min-h-screen bg-stone-950 text-stone-100 selection:bg-lime-400 selection:text-stone-950">
      <nav className="border-b border-stone-800 bg-stone-900/60 backdrop-blur sticky top-0 z-30 px-6 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-lime-400 font-bold text-stone-950 text-base">
                O
              </span>
              <span className="text-xl font-semibold tracking-tight">Olive</span>
            </div>
            <div className="flex items-center gap-1 rounded-lg bg-stone-800/80 p-1 text-sm font-medium">
              <button
                type="button"
                onClick={() => {
                  setActiveTab("meetings");
                  setSelectedMeetingId(null);
                }}
                className={`rounded-md px-3 py-1.5 transition ${
                  activeTab === "meetings" ? "bg-stone-900 text-lime-400 shadow" : "text-stone-400 hover:text-stone-200"
                }`}
              >
                Meetings
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTab("speakers");
                  setSelectedMeetingId(null);
                  void refreshSpeakers();
                }}
                className={`rounded-md px-3 py-1.5 transition ${
                  activeTab === "speakers" ? "bg-stone-900 text-lime-400 shadow" : "text-stone-400 hover:text-stone-200"
                }`}
              >
                People ({knownSpeakers.length})
              </button>
            </div>
          </div>
          <span className="rounded-full border border-stone-700 bg-stone-900 px-3 py-1 text-xs text-stone-400">
            Pipeline Active
          </span>
        </div>
      </nav>

      <main className="mx-auto max-w-6xl px-6 py-8">
        {selectedMeetingId ? (
          <MeetingDetailView
            meetingId={selectedMeetingId}
            knownSpeakers={knownSpeakers}
            onBack={() => setSelectedMeetingId(null)}
            onSpeakerUpdated={() => void refreshSpeakers()}
          />
        ) : activeTab === "meetings" ? (
          <MeetingsListView onSelectMeeting={(id) => setSelectedMeetingId(id)} />
        ) : (
          <SpeakersListView
            speakers={knownSpeakers}
            onRefresh={() => void refreshSpeakers()}
            onSelectMeeting={(id) => {
              setActiveTab("meetings");
              setSelectedMeetingId(id);
            }}
          />
        )}
      </main>
    </div>
  );
}

function MeetingsListView({ onSelectMeeting }: { onSelectMeeting: (id: string) => void }): ReactElement {
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const fetchMeetings = async () => {
    setLoading(true);
    setError(null);
    try {
      const url = search.trim() ? `/api/meetings?search=${encodeURIComponent(search.trim())}` : "/api/meetings";
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as MeetingsResponse;
      setMeetings(data.meetings);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load meetings");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchMeetings();
  }, [search]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Meetings</h1>
          <p className="mt-1 text-sm text-stone-400">Recorded and ingested audio archive</p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Search meetings…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-lg border border-stone-800 bg-stone-900 px-4 py-2 text-sm text-stone-100 placeholder-stone-500 focus:border-lime-400 focus:outline-none"
          />
        </div>
      </div>

      {loading && <p className="text-stone-400">Loading meetings…</p>}
      {error && <div className="rounded-xl border border-red-900 bg-red-950/40 p-4 text-red-200">{error}</div>}

      {!loading && !error && meetings.length === 0 && (
        <div className="rounded-2xl border border-dashed border-stone-800 bg-stone-900/40 py-16 text-center">
          <p className="text-stone-400">No meetings found.</p>
        </div>
      )}

      {!loading && !error && meetings.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-1">
          {meetings.map((meeting) => (
            <div
              key={meeting.id}
              onClick={() => onSelectMeeting(meeting.id)}
              className="group cursor-pointer rounded-xl border border-stone-800 bg-stone-900/90 p-5 transition hover:border-lime-400/60 hover:bg-stone-900 shadow-sm"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-stone-100 group-hover:text-lime-300 transition">
                    {meeting.title}
                  </h2>
                  <div className="mt-1 flex items-center gap-3 text-xs text-stone-400">
                    <span>{formatDate(meeting.startTime)}</span>
                    <span>•</span>
                    <span>{formatDuration(meeting.endTime - meeting.startTime)}</span>
                    <span>•</span>
                    <span className="capitalize">{meeting.source}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${
                      meeting.status === "ready"
                        ? "bg-lime-400/10 text-lime-300 border border-lime-400/20"
                        : meeting.status === "processing"
                        ? "bg-amber-400/10 text-amber-300 border border-amber-400/20"
                        : "bg-stone-800 text-stone-300"
                    }`}
                  >
                    {meeting.status}
                  </span>
                  {meeting.primaryTranscriptArtifactId && (
                    <span className="rounded-full bg-stone-800 px-2.5 py-1 text-xs text-stone-300">
                      Transcript
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MeetingDetailView({
  meetingId,
  knownSpeakers,
  onBack,
  onSpeakerUpdated
}: {
  meetingId: string;
  knownSpeakers: SpeakerWithStats[];
  onBack: () => void;
  onSpeakerUpdated: () => void;
}): ReactElement {
  const [detail, setDetail] = useState<MeetingDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [reassigningSpeaker, setReassigningSpeaker] = useState<string | null>(null);

  const fetchDetail = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/meetings/${meetingId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as MeetingDetailResponse;
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load meeting");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchDetail();
  }, [meetingId]);

  const handleTriggerTranscription = async () => {
    setTranscribing(true);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/transcribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ poll: true, force: true })
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await fetchDetail();
    } catch (err) {
      alert(`Transcription error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTranscribing(false);
    }
  };

  let parsedTranscriptSegments: Array<{ speaker: string; text: string; startMs: number; endMs: number }> = [];
  if (detail?.transcriptContent) {
    try {
      const parsed = JSON.parse(detail.transcriptContent);
      if (Array.isArray(parsed.segments)) {
        parsedTranscriptSegments = parsed.segments;
      }
    } catch {
      // plain text fallback
    }
  }

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-2 text-sm text-stone-400 hover:text-lime-300 transition"
      >
        ← Back to Meetings
      </button>

      {loading && <p className="text-stone-400">Loading meeting details…</p>}
      {error && <div className="rounded-xl border border-red-900 bg-red-950/40 p-4 text-red-200">{error}</div>}

      {detail && (
        <div className="space-y-8">
          <header className="flex flex-col gap-4 border-b border-stone-800 pb-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">{detail.meeting.title}</h1>
              <div className="mt-2 flex items-center gap-3 text-sm text-stone-400">
                <span>{formatDate(detail.meeting.startTime)}</span>
                <span>•</span>
                <span>{formatDuration(detail.meeting.endTime - detail.meeting.startTime)}</span>
                <span>•</span>
                <span className="capitalize">{detail.meeting.source}</span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={transcribing}
                onClick={() => void handleTriggerTranscription()}
                className="rounded-lg bg-lime-400 px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-lime-300 disabled:opacity-50"
              >
                {transcribing ? "Transcribing with Speechmatics…" : "Transcribe / Retranscribe"}
              </button>
            </div>
          </header>

          {/* Speakers summary */}
          {detail.speakers.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-stone-400">Speakers:</span>
              {detail.speakers.map((s) => (
                <span
                  key={s.id}
                  className="rounded-full border border-stone-700 bg-stone-800/80 px-3 py-1 text-xs font-medium text-lime-300"
                >
                  {s.name}
                </span>
              ))}
            </div>
          )}

          {/* Transcript Viewer */}
          <section className="space-y-4">
            <h2 className="text-xl font-semibold tracking-tight">Transcript</h2>

            {parsedTranscriptSegments.length > 0 ? (
              <div className="space-y-4 rounded-xl border border-stone-800 bg-stone-900/60 p-6">
                {parsedTranscriptSegments.map((seg, idx) => (
                  <div key={idx} className="flex gap-4">
                    <div className="w-16 shrink-0 pt-0.5 text-xs text-stone-500 font-mono">
                      {formatTimeOffset(seg.startMs)}
                    </div>
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setReassigningSpeaker(seg.speaker)}
                          title="Click to rename or enroll person from this turn"
                          className="rounded bg-stone-800 px-2 py-0.5 text-xs font-semibold text-lime-400 hover:bg-lime-400 hover:text-stone-950 transition"
                        >
                          {seg.speaker} ✎
                        </button>
                      </div>
                      <p className="text-sm leading-relaxed text-stone-200">{seg.text}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : detail.transcriptContent ? (
              <pre className="whitespace-pre-wrap rounded-xl border border-stone-800 bg-stone-900/60 p-6 text-sm font-sans text-stone-200">
                {detail.transcriptContent}
              </pre>
            ) : (
              <div className="rounded-xl border border-dashed border-stone-800 bg-stone-900/40 p-8 text-center text-stone-400">
                No transcript generated yet. Click "Transcribe with Speechmatics" above to transcribe this meeting.
              </div>
            )}
          </section>

          {/* Reassign Speaker Modal */}
          {reassigningSpeaker && (
            <ReassignSpeakerModal
              meetingId={meetingId}
              fromLabel={reassigningSpeaker}
              knownSpeakers={knownSpeakers}
              onClose={() => setReassigningSpeaker(null)}
              onSuccess={async () => {
                setReassigningSpeaker(null);
                await fetchDetail();
                onSpeakerUpdated();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ReassignSpeakerModal({
  meetingId,
  fromLabel,
  knownSpeakers,
  onClose,
  onSuccess
}: {
  meetingId: string;
  fromLabel: string;
  knownSpeakers: SpeakerWithStats[];
  onClose: () => void;
  onSuccess: () => void;
}): ReactElement {
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>("");
  const [customName, setCustomName] = useState<string>("");
  const [adoptVoiceprint, setAdoptVoiceprint] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      const payload: any = {
        fromLabel,
        adoptVoiceprint
      };

      if (selectedSpeakerId === "new" || !selectedSpeakerId) {
        if (!customName.trim()) {
          alert("Please enter a name for the new speaker");
          setSubmitting(false);
          return;
        }
        payload.toSpeakerName = customName.trim();
      } else {
        payload.toSpeakerId = selectedSpeakerId;
        const matched = knownSpeakers.find((s) => s.id === selectedSpeakerId);
        if (matched) {
          payload.toSpeakerName = matched.name;
        }
      }

      const res = await fetch(`/api/meetings/${meetingId}/speakers/reassign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      onSuccess();
    } catch (err) {
      alert(`Failed to reassign speaker: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl border border-stone-800 bg-stone-900 p-6 shadow-2xl space-y-5">
        <div className="flex items-center justify-between border-b border-stone-800 pb-3">
          <h3 className="text-lg font-semibold">Assign Speaker: "{fromLabel}"</h3>
          <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-200 text-lg">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-stone-400 mb-1">
              Select Person
            </label>
            <select
              value={selectedSpeakerId}
              onChange={(e) => setSelectedSpeakerId(e.target.value)}
              className="w-full rounded-lg border border-stone-800 bg-stone-950 px-3 py-2 text-sm text-stone-100 focus:border-lime-400 focus:outline-none"
            >
              <option value="">-- Create new or choose person --</option>
              <option value="new">+ Create New Person</option>
              {knownSpeakers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.providerIds.speechmatics?.length ? "Voiceprint enrolled" : "Discovered"})
                </option>
              ))}
            </select>
          </div>

          {(selectedSpeakerId === "new" || !selectedSpeakerId) && (
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-stone-400 mb-1">
                Person Name
              </label>
              <input
                type="text"
                placeholder="e.g. Matt Cowger"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                className="w-full rounded-lg border border-stone-800 bg-stone-950 px-3 py-2 text-sm text-stone-100 placeholder-stone-500 focus:border-lime-400 focus:outline-none"
              />
            </div>
          )}

          <div className="flex items-center gap-3 rounded-lg border border-stone-800 bg-stone-950/50 p-3">
            <input
              type="checkbox"
              id="voiceprint-toggle"
              checked={adoptVoiceprint}
              onChange={(e) => setAdoptVoiceprint(e.target.checked)}
              className="h-4 w-4 rounded border-stone-700 bg-stone-900 text-lime-400 focus:ring-lime-400"
            />
            <label htmlFor="voiceprint-toggle" className="text-xs text-stone-300 leading-snug cursor-pointer">
              <span className="font-semibold text-stone-100">Learn voiceprint from this meeting</span>
              <br />
              Speechmatics will automatically identify this person by name in future recordings.
            </label>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm font-medium text-stone-400 hover:text-stone-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-lime-400 px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-lime-300 disabled:opacity-50"
            >
              {submitting ? "Saving…" : "Apply & Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SpeakersListView({
  speakers,
  onRefresh,
  onSelectMeeting
}: {
  speakers: SpeakerWithStats[];
  onRefresh: () => void;
  onSelectMeeting: (meetingId: string) => void;
}): ReactElement {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [targetMergeId, setTargetMergeId] = useState("");

  const handleRename = async (id: string) => {
    if (!editingName.trim()) return;
    try {
      const res = await fetch(`/api/speakers/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: editingName.trim() })
      });
      if (res.ok) {
        setEditingId(null);
        onRefresh();
      }
    } catch {
      alert("Failed to rename speaker");
    }
  };

  const handleMerge = async (sourceId: string) => {
    if (!targetMergeId) return;
    try {
      const res = await fetch("/api/speakers/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceSpeakerId: sourceId, targetSpeakerId: targetMergeId })
      });
      if (res.ok) {
        setMergingId(null);
        setTargetMergeId("");
        onRefresh();
      }
    } catch {
      alert("Failed to merge speaker");
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Are you sure you want to delete speaker "${name}"?`)) return;
    try {
      const res = await fetch(`/api/speakers/${id}`, { method: "DELETE" });
      if (res.ok) {
        onRefresh();
      }
    } catch {
      alert("Failed to delete speaker");
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">People & Voiceprints</h1>
        <p className="mt-1 text-sm text-stone-400">
          Recognized speakers and their persistent voice identifiers learned from meetings.
        </p>
      </div>

      {speakers.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-800 bg-stone-900/40 py-16 text-center">
          <p className="text-stone-400">
            No people enrolled yet. Open any meeting transcript and click a speaker label (e.g. S1) to assign a person and learn their voice.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {speakers.map((s) => {
            const hasVoiceprint = (s.providerIds.speechmatics?.length ?? 0) > 0;
            return (
              <div
                key={s.id}
                className="rounded-xl border border-stone-800 bg-stone-900/90 p-5 space-y-4 flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-start justify-between">
                    {editingId === s.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          className="rounded border border-stone-700 bg-stone-950 px-2 py-1 text-sm text-stone-100"
                        />
                        <button
                          type="button"
                          onClick={() => void handleRename(s.id)}
                          className="text-xs bg-lime-400 text-stone-950 px-2 py-1 rounded font-semibold"
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <h2 className="text-lg font-bold text-stone-100 flex items-center gap-2">
                        {s.name}
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(s.id);
                            setEditingName(s.name);
                          }}
                          className="text-xs text-stone-500 hover:text-stone-300"
                        >
                          ✎
                        </button>
                      </h2>
                    )}
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        hasVoiceprint
                          ? "bg-lime-400/10 text-lime-300 border border-lime-400/20"
                          : "bg-stone-800 text-stone-400"
                      }`}
                    >
                      {hasVoiceprint ? "Voiceprint Active" : "Discovered"}
                    </span>
                  </div>

                  <div className="mt-3 space-y-1 text-xs text-stone-400">
                    <p>Participated in: <span className="font-semibold text-stone-200">{s.meetingCount} meeting(s)</span></p>
                    {hasVoiceprint && (
                      <p>Speechmatics identifiers: <span className="font-mono text-stone-300">{s.providerIds.speechmatics!.length}</span></p>
                    )}
                    {s.enrolledAt && (
                      <p>Last learned: {formatDate(s.enrolledAt)}</p>
                    )}
                  </div>
                </div>

                {mergingId === s.id ? (
                  <div className="border-t border-stone-800 pt-3 space-y-2">
                    <label className="text-xs text-stone-400">Merge {s.name} into:</label>
                    <select
                      value={targetMergeId}
                      onChange={(e) => setTargetMergeId(e.target.value)}
                      className="w-full rounded border border-stone-700 bg-stone-950 px-2 py-1 text-xs text-stone-100"
                    >
                      <option value="">-- Choose target --</option>
                      {speakers
                        .filter((candidate) => candidate.id !== s.id)
                        .map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.name}
                          </option>
                        ))}
                    </select>
                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => setMergingId(null)}
                        className="text-xs text-stone-400 px-2 py-1"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleMerge(s.id)}
                        className="text-xs bg-lime-400 text-stone-950 font-semibold px-2 py-1 rounded"
                      >
                        Confirm Merge
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between border-t border-stone-800/80 pt-3 text-xs text-stone-400">
                    <button
                      type="button"
                      onClick={() => setMergingId(s.id)}
                      className="hover:text-lime-300 transition"
                    >
                      Merge into…
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(s.id, s.name)}
                      className="text-stone-500 hover:text-red-400 transition"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
