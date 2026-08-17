import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type {
  Artifact,
  BackupInfo,
  LlmModelCatalogItem,
  LlmProviderSummary,
  MeetingDetailAggregate,
  MeetingListItem,
  MeetingSummaryItem,
  Recording,
  RestoreResult,
  Speaker,
  StageRunRow,
  Template
} from "@olive/shared";

interface MeetingsResponse {
  meetings: MeetingListItem[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

type MeetingDetailResponse = MeetingDetailAggregate;

interface SpeakerWithStats extends Speaker {
  meetingCount: number;
}

interface PlaudStatus {
  connected: boolean;
  lastPollAt: number | null;
  pcsPending: number;
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
  const [activeTab, setActiveTab] = useState<"meetings" | "speakers" | "templates" | "backup">("meetings");
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);

  // Global speakers cache
  const [knownSpeakers, setKnownSpeakers] = useState<SpeakerWithStats[]>([]);

  // Plaud status
  const [plaudStatus, setPlaudStatus] = useState<PlaudStatus | null>(null);
  const [showPlaudModal, setShowPlaudModal] = useState(false);

  // LLM status & settings
  const [llmConfig, setLlmConfig] = useState<{ defaultProvider: string; defaultModel: string } | null>(null);
  const [showLlmModal, setShowLlmModal] = useState(false);

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

  const refreshPlaudStatus = async () => {
    try {
      const res = await fetch("/api/plaud/status");
      if (res.ok) {
        const data = (await res.json()) as PlaudStatus;
        setPlaudStatus(data);
      }
    } catch {
      // ignore
    }
  };

  const refreshLlmConfig = async () => {
    try {
      const res = await fetch("/api/llm/config");
      if (res.ok) {
        const data = await res.json();
        setLlmConfig(data);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void refreshSpeakers();
    void refreshPlaudStatus();
    void refreshLlmConfig();
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
              <button
                type="button"
                onClick={() => {
                  setActiveTab("templates");
                  setSelectedMeetingId(null);
                }}
                className={`rounded-md px-3 py-1.5 transition ${
                  activeTab === "templates" ? "bg-stone-900 text-lime-400 shadow" : "text-stone-400 hover:text-stone-200"
                }`}
              >
                Templates
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTab("backup");
                  setSelectedMeetingId(null);
                }}
                className={`rounded-md px-3 py-1.5 transition ${
                  activeTab === "backup" ? "bg-stone-900 text-lime-400 shadow" : "text-stone-400 hover:text-stone-200"
                }`}
              >
                Backup & Restore
              </button>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowLlmModal(true)}
              className="flex items-center gap-2 rounded-full border border-stone-700 bg-stone-800/80 px-3 py-1 text-xs font-medium text-stone-300 hover:border-stone-500 hover:text-white transition"
            >
              <span className="h-2 w-2 rounded-full bg-cyan-400" />
              <span>AI: {llmConfig ? `${llmConfig.defaultProvider}/${llmConfig.defaultModel}` : "Configure LLM"}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setShowPlaudModal(true);
                void refreshPlaudStatus();
              }}
              className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition ${
                plaudStatus?.connected
                  ? "border-lime-400/30 bg-lime-400/10 text-lime-300 hover:bg-lime-400/20"
                  : "border-amber-400/30 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${plaudStatus?.connected ? "bg-lime-400" : "bg-amber-400"}`} />
              {plaudStatus?.connected ? "Plaud Connected" : "Connect Plaud"}
            </button>
          </div>
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
        ) : activeTab === "speakers" ? (
          <SpeakersListView
            speakers={knownSpeakers}
            onRefresh={() => void refreshSpeakers()}
            onSelectMeeting={(id) => {
              setActiveTab("meetings");
              setSelectedMeetingId(id);
            }}
          />
        ) : activeTab === "templates" ? (
          <TemplatesListView />
        ) : (
          <BackupRestoreView
            onRestoreComplete={() => {
              void refreshSpeakers();
              void refreshLlmConfig();
            }}
          />
        )}
      </main>

      {/* Plaud Auth & Sync Modal */}
      {showPlaudModal && (
        <PlaudModal
          status={plaudStatus}
          onClose={() => setShowPlaudModal(false)}
          onRefreshStatus={() => void refreshPlaudStatus()}
        />
      )}

      {/* LLM Provider & Model Settings Modal */}
      {showLlmModal && (
        <LlmSettingsModal
          onClose={() => setShowLlmModal(false)}
          onSaved={() => {
            setShowLlmModal(false);
            void refreshLlmConfig();
          }}
        />
      )}
    </div>
  );
}

function PlaudModal({
  status,
  onClose,
  onRefreshStatus
}: {
  status: PlaudStatus | null;
  onClose: () => void;
  onRefreshStatus: () => void;
}): ReactElement {
  const [authStep, setAuthStep] = useState<"idle" | "authorizing" | "success" | "error">("idle");
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [callbackInput, setCallbackInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const handleStartAuth = async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/plaud/auth/start", { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { authUrl: string; sessionId: string };
      setAuthUrl(data.authUrl);
      setSessionId(data.sessionId);
      setAuthStep("authorizing");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sessionId || !callbackInput.trim()) {
      alert("Please paste the callback URL or code from your browser");
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/plaud/auth/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          pastedUrlOrCode: callbackInput.trim()
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      setAuthStep("success");
      onRefreshStatus();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleTriggerSync = async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await fetch("/api/plaud/sync/trigger", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setSyncMessage(`Sync completed: ${data.discovered} discovered, ${data.resolved} resolved.`);
      onRefreshStatus();
    } catch (err) {
      setSyncMessage(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-2xl border border-stone-800 bg-stone-900 p-6 shadow-2xl space-y-6">
        <div className="flex items-center justify-between border-b border-stone-800 pb-3">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold">Plaud Integration</span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                status?.connected ? "bg-lime-400/10 text-lime-300" : "bg-amber-400/10 text-amber-300"
              }`}
            >
              {status?.connected ? "Connected" : "Disconnected"}
            </span>
          </div>
          <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-200 text-lg">
            ✕
          </button>
        </div>

        {errorMessage && (
          <div className="rounded-xl border border-red-900 bg-red-950/40 p-4 text-xs text-red-200">
            {errorMessage}
          </div>
        )}

        {syncMessage && (
          <div className="rounded-xl border border-lime-900 bg-lime-950/40 p-4 text-xs text-lime-200">
            {syncMessage}
          </div>
        )}

        {status?.connected && authStep === "idle" ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-stone-800 bg-stone-950/60 p-4 space-y-2 text-xs text-stone-300">
              <div className="flex justify-between">
                <span className="text-stone-400">Connection Status:</span>
                <span className="font-semibold text-lime-300">Active (OAuth tokens valid)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-stone-400">Last Synced:</span>
                <span>{status.lastPollAt ? formatDate(status.lastPollAt) : "Never"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-stone-400">Pending PCS Items:</span>
                <span>{status.pcsPending}</span>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                disabled={syncing}
                onClick={() => void handleTriggerSync()}
                className="flex-1 rounded-lg bg-lime-400 py-2 text-sm font-semibold text-stone-950 hover:bg-lime-300 disabled:opacity-50 transition"
              >
                {syncing ? "Syncing with Plaud…" : "Sync Now"}
              </button>
              <button
                type="button"
                onClick={() => void handleStartAuth()}
                className="rounded-lg border border-stone-700 bg-stone-800 px-4 py-2 text-sm font-medium text-stone-300 hover:bg-stone-700 transition"
              >
                Re-authenticate
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {authStep === "idle" && (
              <div className="space-y-4 text-sm text-stone-300">
                <p>
                  Connect your Plaud account using OAuth 2.0 PKCE to automatically ingest recordings, transcripts, and summaries into Olive.
                </p>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void handleStartAuth()}
                  className="w-full rounded-lg bg-lime-400 py-2.5 text-sm font-semibold text-stone-950 hover:bg-lime-300 disabled:opacity-50 transition"
                >
                  {loading ? "Generating login link…" : "Start Plaud OAuth Login"}
                </button>
              </div>
            )}

            {authStep === "authorizing" && authUrl && (
              <form onSubmit={handleCompleteAuth} className="space-y-4 text-sm">
                <div className="rounded-xl border border-stone-800 bg-stone-950/80 p-4 space-y-3">
                  <p className="font-semibold text-stone-200">Step 1: Authorize with Plaud</p>
                  <p className="text-xs text-stone-400 leading-relaxed">
                    Click the button below to open the official Plaud login in a new tab. Log in and grant permission.
                  </p>
                  <a
                    href={authUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg bg-lime-400 px-4 py-2 text-xs font-bold text-stone-950 hover:bg-lime-300 transition"
                  >
                    Open Plaud Login Page ↗
                  </a>
                </div>

                <div className="rounded-xl border border-stone-800 bg-stone-950/80 p-4 space-y-3">
                  <p className="font-semibold text-stone-200">Step 2: Paste the Callback URL</p>
                  <p className="text-xs text-stone-400 leading-relaxed">
                    After authorizing, Plaud will redirect your browser to a callback address starting with{" "}
                    <code className="rounded bg-stone-900 px-1 py-0.5 text-lime-400">http://localhost:8199/auth/callback?code=...</code>{" "}
                    (your browser might show "Site can't be reached"—this is normal). Copy the <strong>entire URL</strong> from your address bar and paste it below:
                  </p>
                  <input
                    type="text"
                    required
                    placeholder="http://localhost:8199/auth/callback?code=...&state=..."
                    value={callbackInput}
                    onChange={(e) => setCallbackInput(e.target.value)}
                    className="w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-2 text-xs text-stone-100 placeholder-stone-500 focus:border-lime-400 focus:outline-none"
                  />
                </div>

                <div className="flex justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setAuthStep("idle")}
                    className="rounded-lg px-4 py-2 text-sm text-stone-400 hover:text-stone-200"
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={loading || !callbackInput.trim()}
                    className="rounded-lg bg-lime-400 px-5 py-2 text-sm font-semibold text-stone-950 hover:bg-lime-300 disabled:opacity-50 transition"
                  >
                    {loading ? "Verifying…" : "Complete Connection"}
                  </button>
                </div>
              </form>
            )}

            {authStep === "success" && (
              <div className="space-y-4 py-4 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-lime-400/20 text-2xl text-lime-300">
                  ✓
                </div>
                <h4 className="text-lg font-bold text-stone-100">Plaud Connected Successfully!</h4>
                <p className="text-xs text-stone-400">
                  Olive is now authenticated with your Plaud account. Tokens will refresh automatically.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setAuthStep("idle");
                    onClose();
                  }}
                  className="rounded-lg bg-lime-400 px-6 py-2 text-sm font-semibold text-stone-950 hover:bg-lime-300 transition"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MeetingsListView({ onSelectMeeting }: { onSelectMeeting: (id: string) => void }): ReactElement {
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showUploadModal, setShowUploadModal] = useState(false);

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
          <button
            type="button"
            onClick={() => setShowUploadModal(true)}
            className="flex items-center gap-2 rounded-lg bg-lime-400 px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-lime-300 shrink-0"
          >
            <span>+</span> Upload Audio
          </button>
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

      {showUploadModal && (
        <UploadAudioModal
          onClose={() => setShowUploadModal(false)}
          onUploaded={(meetingId) => {
            setShowUploadModal(false);
            onSelectMeeting(meetingId);
          }}
        />
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
  const [selectedProvider, setSelectedProvider] = useState<"local" | "speechmatics">("local");
  const [reassigningSpeaker, setReassigningSpeaker] = useState<string | null>(null);
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  const [selectedSummaryId, setSelectedSummaryId] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const fetchDetail = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/meetings/${meetingId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as MeetingDetailResponse;
      setDetail(data);
      if (data.summaries && data.summaries.length > 0) {
        const primary = data.summaries.find((s) => s.isPrimary);
        setSelectedSummaryId((prev) => prev || primary?.id || data.summaries[0].id);
      }
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
        body: JSON.stringify({ provider: selectedProvider, poll: true, force: true })
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

  const handleSetPrimarySummary = async (artifactId: string) => {
    try {
      const res = await fetch(`/api/meetings/${meetingId}/summaries/${artifactId}/primary`, {
        method: "POST"
      });
      if (!res.ok) throw new Error("Failed to set primary summary");
      await fetchDetail();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteSummary = async (artifactId: string) => {
    if (!confirm("Are you sure you want to delete this summary?")) {
      return;
    }
    try {
      const res = await fetch(`/api/meetings/${meetingId}/summaries/${artifactId}`, {
        method: "DELETE"
      });
      if (!res.ok) throw new Error("Failed to delete summary");
      setSelectedSummaryId(null);
      await fetchDetail();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopySummary = (content: string) => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  let parsedTranscriptSegments: Array<{ speaker: string; text: string; startMs: number; endMs: number }> = [];
  if (detail?.transcriptContent) {
    try {
      const parsed = JSON.parse(detail.transcriptContent);
      if (Array.isArray(parsed.segments)) {
        parsedTranscriptSegments = parsed.segments.map((s: any) => ({
          speaker: s.speaker || "Speaker",
          text: s.text || s.content || "",
          startMs: s.startMs ?? s.start_time ?? 0,
          endMs: s.endMs ?? s.end_time ?? 0
        }));
      } else if (Array.isArray(parsed)) {
        parsedTranscriptSegments = parsed
          .filter((item: any) => item.content && item.content.trim())
          .map((item: any) => ({
            speaker: item.speaker || "Speaker",
            text: item.content,
            startMs: item.start_time ?? 0,
            endMs: item.end_time ?? 0
          }));
      }
    } catch {
      // plain text fallback
    }
  }

  const summaries = detail?.summaries || [];
  const activeSummary =
    summaries.find((s) => s.id === selectedSummaryId) ||
    summaries.find((s) => s.isPrimary) ||
    summaries[0] ||
    null;

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
              <select
                value={selectedProvider}
                onChange={(e) => setSelectedProvider(e.target.value as "local" | "speechmatics")}
                className="rounded-lg border border-stone-800 bg-stone-900 px-3 py-2 text-xs text-stone-200 focus:border-lime-400 focus:outline-none"
              >
                <option value="local">Local SOTA (Cohere 2B + Diarization)</option>
                <option value="speechmatics">Speechmatics (Cloud)</option>
              </select>
              <button
                type="button"
                disabled={transcribing}
                onClick={() => void handleTriggerTranscription()}
                className="rounded-lg bg-lime-400 px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-lime-300 disabled:opacity-50"
              >
                {transcribing ? "Transcribing…" : "Transcribe"}
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

          {/* Audio Player if recording exists */}
          {detail.recordings.length > 0 && (
            <section className="rounded-xl border border-stone-800 bg-stone-900/80 p-4 space-y-2">
              <div className="flex items-center justify-between text-xs text-stone-400">
                <span className="font-semibold uppercase tracking-wider text-stone-300">Recording Audio</span>
                <span>{detail.recordings[0].mime} • {(detail.recordings[0].sizeBytes / 1024 / 1024).toFixed(2)} MB</span>
              </div>
              <audio
                ref={audioRef}
                controls
                src={`/api/meetings/${meetingId}/audio`}
                className="w-full h-10 rounded"
              />
            </section>
          )}

          {/* AI Summaries Section */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-semibold tracking-tight">AI Summaries</h2>
                {summaries.length > 0 && (
                  <span className="rounded-full bg-stone-800 px-2.5 py-0.5 text-xs font-medium text-stone-300">
                    {summaries.length} version{summaries.length > 1 ? "s" : ""}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowSummaryModal(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-lime-400 px-3.5 py-1.5 text-xs font-semibold text-stone-950 hover:bg-lime-300 transition"
              >
                <span>+</span>
                <span>Generate Summary</span>
              </button>
            </div>

            {summaries.length > 0 ? (
              <div className="rounded-xl border border-stone-800 bg-stone-900/70 shadow-lg overflow-hidden">
                {/* Summary Tabs Header */}
                <div className="flex items-center gap-2 border-b border-stone-800 bg-stone-950/60 p-2 overflow-x-auto">
                  {summaries.map((s, idx) => {
                    const parts = s.provider.split(":");
                    const label = parts[2] || parts[1] || `Summary ${idx + 1}`;
                    const isSelected = (activeSummary && activeSummary.id === s.id) || (!activeSummary && idx === 0);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setSelectedSummaryId(s.id)}
                        className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition whitespace-nowrap ${
                          isSelected
                            ? "bg-stone-800 text-lime-300 shadow border border-stone-700"
                            : "text-stone-400 hover:text-stone-200 hover:bg-stone-900"
                        }`}
                      >
                        <span>{label}</span>
                        {s.isPrimary && (
                          <span className="rounded bg-lime-400/20 px-1.5 py-0.2 text-[10px] text-lime-300 font-bold">
                            ★ Primary
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Active Summary Content */}
                {activeSummary && (
                  <div className="p-6 space-y-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-stone-800/80 pb-3">
                      <div className="flex items-center gap-2 text-xs text-stone-400">
                        <span className="font-mono text-stone-300">{activeSummary.provider}</span>
                        <span>•</span>
                        <span>{formatDate(activeSummary.createdAt)}</span>
                        {activeSummary.isPrimary && (
                          <span className="rounded-full bg-lime-400/10 px-2 py-0.5 text-[11px] font-medium text-lime-300 border border-lime-400/20">
                            Primary Note
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        {!activeSummary.isPrimary && (
                          <button
                            type="button"
                            onClick={() => void handleSetPrimarySummary(activeSummary.id)}
                            className="rounded border border-stone-700 bg-stone-800 px-2.5 py-1 text-xs text-stone-300 hover:text-lime-300 transition"
                          >
                            ★ Set as Primary
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleCopySummary(activeSummary.content)}
                          className="rounded border border-stone-700 bg-stone-800 px-2.5 py-1 text-xs text-stone-300 hover:text-white transition"
                        >
                          {copied ? "✓ Copied!" : "📋 Copy Markdown"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteSummary(activeSummary.id)}
                          className="rounded border border-stone-800 px-2.5 py-1 text-xs text-stone-500 hover:border-red-800 hover:text-red-400 transition"
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    <div className="prose prose-invert max-w-none text-sm leading-relaxed text-stone-200 whitespace-pre-wrap font-sans">
                      {activeSummary.content}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-stone-800 bg-stone-900/40 p-8 text-center space-y-3">
                <p className="text-sm text-stone-400">
                  No summary generated yet. Create AI meeting notes using a custom or built-in template.
                </p>
                <button
                  type="button"
                  onClick={() => setShowSummaryModal(true)}
                  className="inline-flex items-center gap-2 rounded-lg bg-lime-400 px-4 py-2 text-xs font-semibold text-stone-950 hover:bg-lime-300 transition"
                >
                  <span>+</span>
                  <span>Generate Summary</span>
                </button>
              </div>
            )}
          </section>

          {/* Transcript Viewer */}
          <section className="space-y-4">
            <h2 className="text-xl font-semibold tracking-tight">Transcript</h2>

            {parsedTranscriptSegments.length > 0 ? (
              <div className="space-y-4 rounded-xl border border-stone-800 bg-stone-900/60 p-6">
                {parsedTranscriptSegments.map((seg, idx) => (
                  <div key={idx} className="flex gap-4">
                    <button
                      type="button"
                      onClick={() => {
                        if (audioRef.current) {
                          audioRef.current.currentTime = seg.startMs / 1000;
                          void audioRef.current.play();
                        }
                      }}
                      title="Click to play audio from this timestamp"
                      className="w-16 shrink-0 pt-0.5 text-xs text-stone-500 hover:text-lime-400 font-mono transition text-left cursor-pointer"
                    >
                      ▶ {formatTimeOffset(seg.startMs)}
                    </button>
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
                No transcript generated yet. Click "Transcribe" above to generate a transcript.
              </div>
            )}
          </section>

          {/* Generate Summary Modal */}
          {showSummaryModal && (
            <GenerateSummaryModal
              meetingId={meetingId}
              onClose={() => setShowSummaryModal(false)}
              onSuccess={async (newArtifactId) => {
                setShowSummaryModal(false);
                setSelectedSummaryId(newArtifactId);
                await fetchDetail();
              }}
            />
          )}

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

function GenerateSummaryModal({
  meetingId,
  onClose,
  onSuccess
}: {
  meetingId: string;
  onClose: () => void;
  onSuccess: (artifactId: string) => void;
}): ReactElement {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [models, setModels] = useState<LlmModelCatalogItem[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [selectedProvider, setSelectedProvider] = useState<string>("google");
  const [selectedModel, setSelectedModel] = useState<string>("gemini-2.5-flash");
  const [thinkingLevel, setThinkingLevel] = useState<string>("low");
  const [setPrimary, setSetPrimary] = useState(true);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [tplRes, llmRes, configRes] = await Promise.all([
          fetch("/api/templates"),
          fetch("/api/llm/models"),
          fetch("/api/llm/config")
        ]);

        if (tplRes.ok) {
          const tData = await tplRes.json();
          const tList: Template[] = tData.templates || [];
          setTemplates(tList);
          const defaultTpl = tList.find((t) => t.isDefault) || tList[0];
          if (defaultTpl) {
            setSelectedTemplateId(defaultTpl.id);
          }
        }

        if (llmRes.ok) {
          const mData = await llmRes.json();
          setModels(mData.models || []);
        }

        if (configRes.ok) {
          const cData = await configRes.json();
          if (cData.defaultProvider) setSelectedProvider(cData.defaultProvider);
          if (cData.defaultModel) setSelectedModel(cData.defaultModel);
          if (cData.defaultThinkingLevel) setThinkingLevel(cData.defaultThinkingLevel);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  const handleProviderChange = (pId: string) => {
    setSelectedProvider(pId);
    const pModels = models.filter((m) => m.provider === pId);
    if (pModels.length > 0) {
      setSelectedModel(pModels[0].id);
      const supported = pModels[0].supportedThinkingLevels || ["low", "medium", "high"];
      setThinkingLevel(supported.includes("off") ? "off" : supported[0] || "low");
    }
  };

  const handleModelChange = (mId: string) => {
    setSelectedModel(mId);
    const m = models.find((mod) => mod.provider === selectedProvider && mod.id === mId);
    if (m?.supportedThinkingLevels) {
      if (!m.supportedThinkingLevels.includes(thinkingLevel as any)) {
        setThinkingLevel(m.supportedThinkingLevels[0] || "low");
      }
    }
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setGenerating(true);
    setError(null);

    try {
      const res = await fetch(`/api/meetings/${meetingId}/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: selectedTemplateId || undefined,
          provider: selectedProvider,
          model: selectedModel,
          thinkingLevel: selectedModelObj?.reasoning ? thinkingLevel : undefined,
          setPrimary
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      onSuccess(data.artifactId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setGenerating(false);
    }
  };

  const providers = Array.from(new Set(models.map((m) => m.provider)));
  const providerModels = models.filter((m) => m.provider === selectedProvider);
  const selectedModelObj = models.find((m) => m.provider === selectedProvider && m.id === selectedModel);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm overflow-y-auto">
      <div className="relative w-full max-w-lg rounded-xl border border-stone-800 bg-stone-900 p-6 shadow-2xl space-y-5 my-8">
        <div className="flex items-center justify-between border-b border-stone-800 pb-3">
          <h3 className="text-lg font-semibold text-stone-100">Generate AI Summary</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-stone-400 hover:text-stone-200 transition"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
            {error}
          </div>
        )}

        {loading ? (
          <div className="p-8 text-center text-sm text-stone-400">Loading templates & models…</div>
        ) : (
          <form onSubmit={handleGenerate} className="space-y-4">
            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wider text-stone-400">
                Summary Template
              </label>
              <select
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
                className="w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100 focus:border-lime-400 focus:outline-none"
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} {t.isDefault ? "(Default)" : ""} {t.isBuiltin ? "" : "★ Custom"}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wider text-stone-400">
                  AI Provider
                </label>
                <select
                  value={selectedProvider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  className="w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100 focus:border-lime-400 focus:outline-none capitalize"
                >
                  {providers.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wider text-stone-400">
                  Model
                </label>
                <select
                  value={selectedModel}
                  onChange={(e) => handleModelChange(e.target.value)}
                  className="w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100 focus:border-lime-400 focus:outline-none"
                >
                  {providerModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} {m.reasoning ? "🧠" : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {selectedModelObj && selectedModelObj.reasoning && (
              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wider text-stone-400 flex items-center gap-1.5">
                  <span>🧠 Thinking / Reasoning Level</span>
                </label>
                <select
                  value={thinkingLevel}
                  onChange={(e) => setThinkingLevel(e.target.value)}
                  className="w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100 focus:border-lime-400 focus:outline-none capitalize"
                >
                  {(selectedModelObj.supportedThinkingLevels || ["low", "medium", "high"]).map((lvl) => (
                    <option key={lvl} value={lvl}>
                      {lvl === "off" ? "Off (Standard Response)" : `${lvl.charAt(0).toUpperCase() + lvl.slice(1)} Thinking`}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                id="setPrimarySummary"
                checked={setPrimary}
                onChange={(e) => setSetPrimary(e.target.checked)}
                className="rounded border-stone-700 bg-stone-950 text-lime-400 focus:ring-lime-400"
              />
              <label htmlFor="setPrimarySummary" className="text-xs text-stone-300 cursor-pointer">
                Set as primary summary for this meeting
              </label>
            </div>

            <div className="flex justify-end gap-3 border-t border-stone-800 pt-4">
              <button
                type="button"
                onClick={onClose}
                disabled={generating}
                className="rounded-lg border border-stone-700 px-4 py-2 text-xs font-medium text-stone-300 hover:bg-stone-800 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={generating}
                className="inline-flex items-center gap-2 rounded-lg bg-lime-400 px-4 py-2 text-xs font-semibold text-stone-950 transition hover:bg-lime-300 disabled:opacity-50"
              >
                {generating ? "Generating Summary…" : "Generate Summary"}
              </button>
            </div>
          </form>
        )}
      </div>
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

function UploadAudioModal({
  onClose,
  onUploaded
}: {
  onClose: () => void;
  onUploaded: (meetingId: string) => void;
}): ReactElement {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [autoTranscribe, setAutoTranscribe] = useState(true);
  const [provider, setProvider] = useState<"local" | "speechmatics">("local");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selected = e.target.files[0];
      setFile(selected);
      if (!title.trim()) {
        setTitle(selected.name.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " "));
      }
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      alert("Please select an audio file to upload");
      return;
    }

    setUploading(true);
    setError(null);

    const formData = new FormData();
    formData.append("file", file);
    if (title.trim()) {
      formData.append("title", title.trim());
    }
    formData.append("autoTranscribe", String(autoTranscribe));
    formData.append("provider", provider);

    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        body: formData
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const data = (await res.json()) as { meetingId: string; deduped: boolean };
      onUploaded(data.meetingId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl border border-stone-800 bg-stone-900 p-6 shadow-2xl space-y-5">
        <div className="flex items-center justify-between border-b border-stone-800 pb-3">
          <h3 className="text-lg font-bold">Upload Audio Recording</h3>
          <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-200 text-lg">
            ✕
          </button>
        </div>

        {error && <div className="rounded-xl border border-red-900 bg-red-950/40 p-3 text-xs text-red-200">{error}</div>}

        <form onSubmit={handleUpload} className="space-y-4 text-sm">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-stone-400 mb-1">
              Audio File (.m4a, .mp3, .wav, .aac, .ogg, .flac)
            </label>
            <input
              type="file"
              required
              accept="audio/*,.m4a,.mp3,.wav,.aac,.ogg,.flac,.webm"
              onChange={handleFileChange}
              className="w-full rounded-lg border border-stone-800 bg-stone-950 p-2.5 text-xs text-stone-200 file:mr-3 file:rounded-md file:border-0 file:bg-stone-800 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-lime-300 hover:file:bg-stone-700"
            />
            {file && (
              <p className="mt-1 text-xs text-stone-400">
                Selected: {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-stone-400 mb-1">
              Meeting / Recording Title
            </label>
            <input
              type="text"
              placeholder="e.g. Planning Session with Team"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-stone-800 bg-stone-950 px-3 py-2 text-sm text-stone-100 placeholder-stone-500 focus:border-lime-400 focus:outline-none"
            />
          </div>

          <div className="space-y-2 rounded-lg border border-stone-800 bg-stone-950/50 p-3">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="auto-transcribe"
                checked={autoTranscribe}
                onChange={(e) => setAutoTranscribe(e.target.checked)}
                className="h-4 w-4 rounded border-stone-700 bg-stone-900 text-lime-400 focus:ring-lime-400"
              />
              <label htmlFor="auto-transcribe" className="text-xs font-semibold text-stone-200 cursor-pointer">
                Automatically transcribe after upload
              </label>
            </div>

            {autoTranscribe && (
              <div className="pt-2 pl-6">
                <label className="block text-xs text-stone-400 mb-1">Transcription Engine:</label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as "local" | "speechmatics")}
                  className="w-full rounded border border-stone-700 bg-stone-900 px-2 py-1 text-xs text-stone-200"
                >
                  <option value="local">Local SOTA (Cohere 2B + Offline Diarizer)</option>
                  <option value="speechmatics">Speechmatics (Cloud API)</option>
                </select>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm text-stone-400 hover:text-stone-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={uploading || !file}
              className="rounded-lg bg-lime-400 px-5 py-2 text-sm font-semibold text-stone-950 hover:bg-lime-300 disabled:opacity-50 transition"
            >
              {uploading ? "Ingesting…" : "Upload & Save"}
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
  const [syncing, setSyncing] = useState(false);

  const handleBackfill = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/speakers/backfill", { method: "POST" });
      if (res.ok) {
        onRefresh();
      }
    } catch {
      alert("Failed to backfill voiceprints");
    } finally {
      setSyncing(false);
    }
  };

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
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">People & Voiceprints</h1>
          <p className="mt-1 text-sm text-stone-400">
            Recognized speakers and their persistent voice identifiers learned from meetings.
          </p>
        </div>
        <div>
          <button
            type="button"
            disabled={syncing}
            onClick={() => void handleBackfill()}
            className="rounded-lg border border-stone-700 bg-stone-900 px-3.5 py-1.5 text-xs font-semibold text-stone-200 hover:border-lime-400 hover:text-lime-300 transition disabled:opacity-50"
          >
            {syncing ? "Syncing Voiceprints…" : "Sync & Cross-fill Voiceprints"}
          </button>
        </div>
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
            const hasSmVoiceprint = (s.providerIds.speechmatics?.length ?? 0) > 0;
            const hasLocalVoiceprint = (s.providerIds.local?.length ?? 0) > 0;
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
                    <div className="flex flex-col gap-1 items-end">
                      {hasLocalVoiceprint && (
                        <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-lime-400/10 text-lime-300 border border-lime-400/20">
                          Local Vector Active
                        </span>
                      )}
                      {hasSmVoiceprint && (
                        <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-blue-400/10 text-blue-300 border border-blue-400/20">
                          Speechmatics Active
                        </span>
                      )}
                      {!hasLocalVoiceprint && !hasSmVoiceprint && (
                        <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-stone-800 text-stone-400">
                          Discovered
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 space-y-1 text-xs text-stone-400">
                    <p>Participated in: <span className="font-semibold text-stone-200">{s.meetingCount} meeting(s)</span></p>
                    {s.enrollmentClipPaths?.length > 0 && (
                      <p>Stored clips: <span className="font-semibold text-stone-300">{s.enrollmentClipPaths.length}</span></p>
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

function TemplatesListView(): ReactElement {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [cloningTemplate, setCloningTemplate] = useState<Template | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const fetchTemplates = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/templates");
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: Failed to fetch templates`);
      }
      const data = (await res.json()) as { templates: Template[] };
      setTemplates(data.templates);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchTemplates();
  }, []);

  const handleSetDefault = async (id: string) => {
    try {
      const res = await fetch(`/api/templates/${id}/default`, { method: "POST" });
      if (!res.ok) {
        throw new Error("Failed to set default template");
      }
      await fetchTemplates();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Are you sure you want to delete template "${name}"?`)) {
      return;
    }
    try {
      const res = await fetch(`/api/templates/${id}`, { method: "DELETE" });
      if (!res.ok) {
        throw new Error("Failed to delete template");
      }
      await fetchTemplates();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const filteredTemplates = templates.filter((t) => {
    if (!search.trim()) return true;
    const query = search.toLowerCase();
    return (
      t.name.toLowerCase().includes(query) ||
      (t.description && t.description.toLowerCase().includes(query)) ||
      t.userPrompt.toLowerCase().includes(query)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Summary Templates</h1>
          <p className="text-sm text-stone-400">
            Customizable prompt templates for generating structured meeting summaries & action items
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditingTemplate(null);
            setCloningTemplate(null);
            setIsCreating(true);
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-lime-400 px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-lime-300"
        >
          <span>+</span>
          <span>New Template</span>
        </button>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="Filter templates…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-sm rounded-lg border border-stone-800 bg-stone-900/80 px-3.5 py-2 text-sm text-stone-100 placeholder-stone-500 focus:border-lime-400 focus:outline-none"
        />
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="p-12 text-center text-sm text-stone-500">Loading templates…</div>
      ) : filteredTemplates.length === 0 ? (
        <div className="rounded-xl border border-stone-800 bg-stone-900/30 p-12 text-center text-sm text-stone-500">
          No templates found.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {filteredTemplates.map((t) => (
            <div
              key={t.id}
              className={`flex flex-col justify-between rounded-xl border p-5 transition ${
                t.isDefault
                  ? "border-lime-400/40 bg-stone-900/80 ring-1 ring-lime-400/20"
                  : "border-stone-800 bg-stone-900/50 hover:border-stone-700"
              }`}
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold text-stone-100">{t.name}</h3>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {t.isDefault && (
                      <span className="rounded-full bg-lime-400/10 px-2 py-0.5 text-[11px] font-medium text-lime-300 border border-lime-400/20">
                        Default
                      </span>
                    )}
                    {t.isBuiltin ? (
                      <span className="rounded-full bg-stone-800 px-2 py-0.5 text-[11px] font-medium text-stone-400">
                        Built-in
                      </span>
                    ) : (
                      <span className="rounded-full bg-purple-400/10 px-2 py-0.5 text-[11px] font-medium text-purple-300 border border-purple-400/20">
                        Custom
                      </span>
                    )}
                  </div>
                </div>

                {t.description && (
                  <p className="text-xs text-stone-400 leading-relaxed">{t.description}</p>
                )}

                {t.systemPrompt && (
                  <div className="space-y-1">
                    <span className="text-[10px] font-medium tracking-wider uppercase text-stone-500">
                      System Instructions
                    </span>
                    <p className="text-xs text-stone-300 bg-stone-950/60 rounded p-2 border border-stone-800/80 line-clamp-2">
                      {t.systemPrompt}
                    </p>
                  </div>
                )}

                <div className="space-y-1">
                  <span className="text-[10px] font-medium tracking-wider uppercase text-stone-500">
                    Prompt Template
                  </span>
                  <pre className="max-h-48 overflow-y-auto rounded-lg border border-stone-800/80 bg-stone-950/80 p-3 font-mono text-[11px] text-stone-300 whitespace-pre-wrap leading-relaxed">
                    {t.userPrompt}
                  </pre>
                </div>
              </div>

              <div className="mt-5 flex items-center justify-between border-t border-stone-800/80 pt-3 text-xs">
                <div>
                  {!t.isDefault && (
                    <button
                      type="button"
                      onClick={() => void handleSetDefault(t.id)}
                      className="font-medium text-lime-400 hover:text-lime-300 transition"
                    >
                      Make Default
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  {t.isBuiltin ? (
                    <button
                      type="button"
                      onClick={() => {
                        setCloningTemplate(t);
                        setEditingTemplate(null);
                        setIsCreating(true);
                      }}
                      className="text-stone-300 hover:text-white transition"
                    >
                      Duplicate & Edit
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingTemplate(t);
                          setCloningTemplate(null);
                          setIsCreating(true);
                        }}
                        className="text-stone-300 hover:text-white transition"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(t.id, t.name)}
                        className="text-stone-500 hover:text-red-400 transition"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {isCreating && (
        <TemplateEditorModal
          template={editingTemplate}
          initialClone={cloningTemplate}
          onClose={() => {
            setIsCreating(false);
            setEditingTemplate(null);
            setCloningTemplate(null);
          }}
          onSaved={() => {
            setIsCreating(false);
            setEditingTemplate(null);
            setCloningTemplate(null);
            void fetchTemplates();
          }}
        />
      )}
    </div>
  );
}

function TemplateEditorModal({
  template,
  initialClone,
  onClose,
  onSaved
}: {
  template: Template | null;
  initialClone: Template | null;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const isEditing = Boolean(template && !initialClone);
  const [name, setName] = useState(
    template ? template.name : initialClone ? `${initialClone.name} (Custom)` : ""
  );
  const [description, setDescription] = useState(
    template ? template.description || "" : initialClone ? initialClone.description || "" : ""
  );
  const [systemPrompt, setSystemPrompt] = useState(
    template ? template.systemPrompt : initialClone ? initialClone.systemPrompt : ""
  );
  const [userPrompt, setUserPrompt] = useState(
    template
      ? template.userPrompt
      : initialClone
      ? initialClone.userPrompt
      : `# Meeting Summary: {{title}}\n**Date:** {{date}}\n**Participants:** {{speakers}}\n\n## Summary\n\n## Action Items\n- [ ] \n\n---\n### Transcript\n{{transcript}}`
  );
  const [isDefault, setIsDefault] = useState(template ? template.isDefault : false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);

  const insertVariable = (tag: string) => {
    const textarea = promptTextareaRef.current;
    if (!textarea) {
      setUserPrompt((prev) => `${prev} ${tag}`);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const nextVal = userPrompt.substring(0, start) + tag + userPrompt.substring(end);
    setUserPrompt(nextVal);
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + tag.length, start + tag.length);
    }, 0);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Template name is required");
      return;
    }
    if (!userPrompt.trim()) {
      setError("User prompt template is required");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const url = isEditing ? `/api/templates/${template!.id}` : "/api/templates";
      const method = isEditing ? "PATCH" : "POST";
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        systemPrompt: systemPrompt.trim(),
        userPrompt: userPrompt.trim(),
        isDefault
      };

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm overflow-y-auto">
      <div className="relative w-full max-w-2xl rounded-xl border border-stone-800 bg-stone-900 p-6 shadow-2xl space-y-5 my-8">
        <div className="flex items-center justify-between border-b border-stone-800 pb-3">
          <h3 className="text-lg font-semibold text-stone-100">
            {isEditing ? "Edit Template" : initialClone ? `Customize "${initialClone.name}"` : "New Summary Template"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-stone-400 hover:text-stone-200 transition"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-medium uppercase tracking-wider text-stone-400">
              Template Name *
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sprint Retrospective"
              className="w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100 focus:border-lime-400 focus:outline-none"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium uppercase tracking-wider text-stone-400">
              Description
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Highlights wins, blockers, and next sprint commitments"
              className="w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100 focus:border-lime-400 focus:outline-none"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium uppercase tracking-wider text-stone-400">
              System Instructions (Optional)
            </label>
            <textarea
              rows={2}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="e.g. You are an expert agile coach summarizing a team retrospective."
              className="w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-xs text-stone-100 focus:border-lime-400 focus:outline-none font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium uppercase tracking-wider text-stone-400">
                User Prompt Template *
              </label>
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-stone-500 mr-1">Insert tags:</span>
                {["{{title}}", "{{date}}", "{{speakers}}", "{{transcript}}"].map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => insertVariable(tag)}
                    className="rounded bg-stone-800 px-1.5 py-0.5 text-[11px] font-mono text-lime-300 hover:bg-stone-700 transition"
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              ref={promptTextareaRef}
              rows={9}
              required
              value={userPrompt}
              onChange={(e) => setUserPrompt(e.target.value)}
              className="w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-xs text-stone-100 focus:border-lime-400 focus:outline-none font-mono whitespace-pre leading-relaxed"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="isDefaultCheckbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="rounded border-stone-700 bg-stone-950 text-lime-400 focus:ring-lime-400"
            />
            <label htmlFor="isDefaultCheckbox" className="text-xs text-stone-300 cursor-pointer">
              Set as default summary template
            </label>
          </div>

          <div className="flex justify-end gap-3 border-t border-stone-800 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg border border-stone-700 px-4 py-2 text-xs font-medium text-stone-300 hover:bg-stone-800 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-lime-400 px-4 py-2 text-xs font-semibold text-stone-950 transition hover:bg-lime-300 disabled:opacity-50"
            >
              {saving ? "Saving…" : isEditing ? "Save Changes" : "Create Template"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function LlmSettingsModal({
  onClose,
  onSaved
}: {
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const [providers, setProviders] = useState<LlmProviderSummary[]>([]);
  const [models, setModels] = useState<LlmModelCatalogItem[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>("google");
  const [selectedModel, setSelectedModel] = useState<string>("gemini-2.5-flash");
  const [thinkingLevel, setThinkingLevel] = useState<string>("off");
  const [apiKey, setApiKey] = useState<string>("");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string; durationMs?: number } | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchModel, setSearchModel] = useState("");

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [configRes, provRes, modelsRes] = await Promise.all([
        fetch("/api/llm/config"),
        fetch("/api/llm/providers"),
        fetch("/api/llm/models")
      ]);

      if (configRes.ok) {
        const config = await configRes.json();
        setSelectedProvider(config.defaultProvider || "google");
        setSelectedModel(config.defaultModel || "gemini-2.5-flash");
        if (config.defaultThinkingLevel) {
          setThinkingLevel(config.defaultThinkingLevel);
        }
        const provConfig = config.providers?.[config.defaultProvider || "google"];
        setBaseUrl(provConfig?.baseUrl || "");
      }

      if (provRes.ok) {
        const pData = await provRes.json();
        setProviders(pData.providers || []);
      }

      if (modelsRes.ok) {
        const mData = await modelsRes.json();
        setModels(mData.models || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchData();
  }, []);

  const handleProviderChange = (pId: string) => {
    setSelectedProvider(pId);
    setTestResult(null);
    const providerModels = models.filter((m) => m.provider === pId);
    if (providerModels.length > 0) {
      setSelectedModel(providerModels[0].id);
      const supported = providerModels[0].supportedThinkingLevels || ["low", "medium", "high"];
      setThinkingLevel(supported.includes("off") ? "off" : supported[0] || "low");
    }
  };

  const handleModelChange = (mId: string) => {
    setSelectedModel(mId);
    setTestResult(null);
    const m = models.find((mod) => mod.provider === selectedProvider && mod.id === mId);
    if (m?.supportedThinkingLevels) {
      if (!m.supportedThinkingLevels.includes(thinkingLevel as any)) {
        setThinkingLevel(m.supportedThinkingLevels[0] || "low");
      }
    }
  };

  const handleRefreshCatalog = async () => {
    setRefreshingCatalog(true);
    try {
      const res = await fetch("/api/llm/refresh-catalog", { method: "POST" });
      if (res.ok) {
        const mRes = await fetch("/api/llm/models");
        if (mRes.ok) {
          const mData = await mRes.json();
          setModels(mData.models || []);
        }
      }
    } catch (err) {
      alert("Failed to refresh catalog: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRefreshingCatalog(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/llm/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider,
          model: selectedModel,
          apiKey: apiKey.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
          thinkingLevel: selectedModelObj?.reasoning ? thinkingLevel : undefined
        })
      });

      const data = await res.json();
      if (res.ok && data.ok) {
        setTestResult({
          ok: true,
          message: `Connected successfully! Response: "${data.response}"`,
          durationMs: data.durationMs
        });
      } else {
        setTestResult({
          ok: false,
          message: data.error || "Connection failed"
        });
      }
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, any> = {
        defaultProvider: selectedProvider,
        defaultModel: selectedModel,
        defaultThinkingLevel: selectedModelObj?.reasoning ? thinkingLevel : "off",
        providers: {
          [selectedProvider]: {
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {})
          }
        }
      };

      const res = await fetch("/api/llm/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save configuration");
      }

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const providerModels = models.filter((m) => m.provider === selectedProvider);
  const filteredModels = providerModels.filter((m) => {
    if (!searchModel.trim()) return true;
    const q = searchModel.toLowerCase();
    return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
  });

  const selectedModelObj = models.find((m) => m.provider === selectedProvider && m.id === selectedModel);
  const currentProviderSummary = providers.find((p) => p.id === selectedProvider);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm overflow-y-auto">
      <div className="relative w-full max-w-2xl rounded-xl border border-stone-800 bg-stone-900 p-6 shadow-2xl space-y-5 my-8">
        <div className="flex items-center justify-between border-b border-stone-800 pb-3">
          <div>
            <h3 className="text-lg font-semibold text-stone-100">LLM Provider & Model Settings</h3>
            <p className="text-xs text-stone-400">Powered by pi-ai unified multi-provider model catalog</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-stone-400 hover:text-stone-200 transition"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
            {error}
          </div>
        )}

        {loading ? (
          <div className="p-8 text-center text-sm text-stone-400">Loading catalog…</div>
        ) : (
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wider text-stone-400">
                  AI Provider
                </label>
                <select
                  value={selectedProvider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  className="w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100 focus:border-lime-400 focus:outline-none"
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} {p.isConfigured ? "✓" : "(unconfigured)"} ({p.modelCount} models)
                    </option>
                  ))}
                </select>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-[11px] text-stone-500">
                    Status: {currentProviderSummary?.isConfigured ? "🟢 Key Configured" : "🟡 Needs API Key"}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleRefreshCatalog()}
                    disabled={refreshingCatalog}
                    className="text-[11px] text-lime-400 hover:underline disabled:opacity-50"
                  >
                    {refreshingCatalog ? "Syncing…" : "↻ Sync Web Catalog"}
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wider text-stone-400">
                  Model
                </label>
                <input
                  type="text"
                  placeholder="Filter models…"
                  value={searchModel}
                  onChange={(e) => setSearchModel(e.target.value)}
                  className="w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-1.5 text-xs text-stone-100 placeholder-stone-500 focus:border-lime-400 focus:outline-none mb-1"
                />
                <select
                  value={selectedModel}
                  onChange={(e) => handleModelChange(e.target.value)}
                  className="w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100 focus:border-lime-400 focus:outline-none"
                >
                  {filteredModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} {m.reasoning ? "🧠" : ""} {m.contextWindow ? `(${Math.round(m.contextWindow / 1000)}k ctx)` : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {selectedModelObj && selectedModelObj.reasoning && (
              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wider text-stone-400 flex items-center gap-1.5">
                  <span>🧠 Thinking / Reasoning Level</span>
                </label>
                <select
                  value={thinkingLevel}
                  onChange={(e) => setThinkingLevel(e.target.value)}
                  className="w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100 focus:border-lime-400 focus:outline-none capitalize"
                >
                  {(selectedModelObj.supportedThinkingLevels || ["low", "medium", "high"]).map((lvl) => (
                    <option key={lvl} value={lvl}>
                      {lvl === "off" ? "Off (Standard Response)" : `${lvl.charAt(0).toUpperCase() + lvl.slice(1)} Thinking`}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wider text-stone-400">
                API Key Override (Optional)
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={currentProviderSummary?.isConfigured ? "Using configured environment key (leave blank to keep)" : "Enter provider API key…"}
                className="w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:border-lime-400 focus:outline-none font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wider text-stone-400">
                Base URL Override (Optional)
              </label>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="e.g. http://localhost:11434/v1 for Ollama, or custom LiteLLM proxy"
                className="w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:border-lime-400 focus:outline-none font-mono"
              />
            </div>

            {testResult && (
              <div
                className={`rounded-lg border p-3 text-xs ${
                  testResult.ok
                    ? "border-lime-400/30 bg-lime-400/10 text-lime-300"
                    : "border-red-500/30 bg-red-500/10 text-red-300"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span>{testResult.message}</span>
                  {testResult.durationMs && (
                    <span className="font-mono text-[10px] opacity-75">{testResult.durationMs}ms</span>
                  )}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between border-t border-stone-800 pt-4">
              <button
                type="button"
                onClick={() => void handleTestConnection()}
                disabled={testing}
                className="rounded-lg border border-stone-700 bg-stone-800 px-3 py-1.5 text-xs font-medium text-stone-200 hover:bg-stone-700 transition disabled:opacity-50"
              >
                {testing ? "Testing…" : "⚡ Test Connection"}
              </button>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={saving}
                  className="rounded-lg border border-stone-700 px-4 py-2 text-xs font-medium text-stone-300 hover:bg-stone-800 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-lg bg-lime-400 px-4 py-2 text-xs font-semibold text-stone-950 transition hover:bg-lime-300 disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save LLM Settings"}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export function BackupRestoreView({ onRestoreComplete }: { onRestoreComplete: () => void }): ReactElement {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);
  const [confirmRestoreTarget, setConfirmRestoreTarget] = useState<{
    type: "file" | "stored";
    filename?: string;
    stats?: { meetings: number; audioFiles: number; sizeBytes?: number };
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadBackups = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/backup/list");
      if (res.ok) {
        const data = await res.json();
        setBackups(data.backups || []);
      }
    } catch {
      setStatusMessage({ type: "error", text: "Failed to fetch backup list from server." });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadBackups();
  }, []);

  const handleCreateServerBackup = async () => {
    setCreating(true);
    setStatusMessage(null);
    try {
      const res = await fetch("/api/backup", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create backup");
      }
      setStatusMessage({
        type: "success",
        text: `Backup created successfully (${formatBytes(data.backup.sizeBytes)}). Included ${data.backup.manifest.stats.meetingCount} meetings & ${data.backup.manifest.stats.audioFilesCount} audio files.`
      });
      await loadBackups();
    } catch (err) {
      setStatusMessage({ type: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteBackup = async (filename: string) => {
    if (!confirm(`Are you sure you want to delete backup archive "${filename}" from server?`)) {
      return;
    }
    try {
      const res = await fetch(`/api/backup/${encodeURIComponent(filename)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete backup");
      }
      setStatusMessage({ type: "success", text: `Deleted backup ${filename}` });
      await loadBackups();
    } catch (err) {
      setStatusMessage({ type: "error", text: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleExecuteRestore = async () => {
    if (!confirmRestoreTarget) return;
    setRestoring(true);
    setStatusMessage(null);

    try {
      let res: Response;
      if (confirmRestoreTarget.type === "file" && selectedFile) {
        const formData = new FormData();
        formData.append("file", selectedFile);
        res = await fetch("/api/backup/restore", {
          method: "POST",
          body: formData
        });
      } else if (confirmRestoreTarget.type === "stored" && confirmRestoreTarget.filename) {
        res = await fetch("/api/backup/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: confirmRestoreTarget.filename })
        });
      } else {
        throw new Error("No restore target selected");
      }

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Restore operation failed");
      }

      setStatusMessage({
        type: "success",
        text: `Restore complete! Successfully restored ${data.result.stats.meetings} meetings, ${data.result.stats.audioFiles} audio files, ${data.result.stats.summaries} summaries, and ${data.result.stats.speakers} speakers.`
      });

      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setConfirmRestoreTarget(null);
      onRestoreComplete();
      await loadBackups();
    } catch (err) {
      setStatusMessage({ type: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setRestoring(false);
      setConfirmRestoreTarget(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-stone-100">Backup & Restore</h1>
          <p className="text-sm text-stone-400">
            Create complete portable archives of your database, settings, templates, transcripts, notes, and all audio files.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <a
            href="/api/backup/export"
            download
            className="inline-flex items-center gap-2 rounded-lg bg-lime-400 px-4 py-2 text-xs font-semibold text-stone-950 transition hover:bg-lime-300 shadow"
          >
            <span>⬇️</span>
            <span>Download Full Backup (.tar.gz)</span>
          </a>
          <button
            type="button"
            onClick={() => void handleCreateServerBackup()}
            disabled={creating}
            className="inline-flex items-center gap-2 rounded-lg border border-stone-700 bg-stone-900 px-4 py-2 text-xs font-semibold text-stone-200 transition hover:border-stone-500 hover:text-white disabled:opacity-50"
          >
            <span>💾</span>
            <span>{creating ? "Creating Snapshot…" : "Save Server Snapshot"}</span>
          </button>
        </div>
      </div>

      {/* Status Alert */}
      {statusMessage && (
        <div
          className={`rounded-xl border p-4 text-sm flex items-start justify-between ${
            statusMessage.type === "success"
              ? "border-lime-400/40 bg-lime-400/10 text-lime-300"
              : statusMessage.type === "error"
              ? "border-red-500/40 bg-red-500/10 text-red-300"
              : "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
          }`}
        >
          <div className="flex items-center gap-3">
            <span>{statusMessage.type === "success" ? "✅" : statusMessage.type === "error" ? "❌" : "ℹ️"}</span>
            <span>{statusMessage.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setStatusMessage(null)}
            className="text-stone-400 hover:text-stone-200 text-xs px-2"
          >
            ✕
          </button>
        </div>
      )}

      {/* Restore from Upload Box */}
      <div className="rounded-xl border border-stone-800 bg-stone-900/60 p-5 backdrop-blur">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-300 mb-2">
          Restore from Backup Archive
        </h2>
        <p className="text-xs text-stone-400 mb-4">
          Select an Olive <code className="text-stone-300">.tar.gz</code> archive from your computer. All meetings, audio recordings, transcripts, summaries, and configuration will be restored.
        </p>

        <div className="flex flex-col sm:flex-row items-center gap-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".tar.gz,.tgz,application/gzip,application/x-gzip"
            onChange={(e) => {
              const file = e.target.files?.[0] || null;
              setSelectedFile(file);
            }}
            className="block w-full text-xs text-stone-400 file:mr-4 file:rounded-lg file:border-0 file:bg-stone-800 file:px-4 file:py-2 file:text-xs file:font-semibold file:text-lime-400 hover:file:bg-stone-700 cursor-pointer"
          />
          {selectedFile && (
            <button
              type="button"
              onClick={() => {
                setConfirmRestoreTarget({
                  type: "file",
                  filename: selectedFile.name,
                  stats: { meetings: 0, audioFiles: 0, sizeBytes: selectedFile.size }
                });
              }}
              className="whitespace-nowrap rounded-lg bg-amber-400 px-4 py-2 text-xs font-semibold text-stone-950 hover:bg-amber-300 transition shadow"
            >
              Restore Uploaded File
            </button>
          )}
        </div>
      </div>

      {/* Saved Backups Table */}
      <div className="rounded-xl border border-stone-800 bg-stone-900/60 backdrop-blur overflow-hidden">
        <div className="flex items-center justify-between border-b border-stone-800 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-300">
              Server Backup Snapshots
            </h2>
            <p className="text-xs text-stone-500">Stored on server persistent storage</p>
          </div>
          <button
            type="button"
            onClick={() => void loadBackups()}
            disabled={loading}
            className="rounded-lg border border-stone-800 bg-stone-950/60 px-3 py-1 text-xs text-stone-400 hover:text-stone-200 transition"
          >
            {loading ? "Refreshing…" : "🔄 Refresh List"}
          </button>
        </div>

        {backups.length === 0 ? (
          <div className="p-8 text-center text-stone-500 text-sm">
            No backup snapshots currently saved on the server. Click &ldquo;Save Server Snapshot&rdquo; or &ldquo;Download Full Backup&rdquo; above.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-stone-300">
              <thead className="border-b border-stone-800 bg-stone-950/40 text-stone-400 font-medium">
                <tr>
                  <th className="px-5 py-3">Archive File</th>
                  <th className="px-5 py-3">Created</th>
                  <th className="px-5 py-3">Size</th>
                  <th className="px-5 py-3">Meetings</th>
                  <th className="px-5 py-3">Audio Recordings</th>
                  <th className="px-5 py-3">Summaries</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-800/60">
                {backups.map((b) => (
                  <tr key={b.filename} className="hover:bg-stone-800/30 transition">
                    <td className="px-5 py-3.5 font-mono text-lime-400 font-medium">
                      {b.filename}
                    </td>
                    <td className="px-5 py-3.5 text-stone-400">
                      {formatDate(new Date(b.createdAt).getTime())}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-stone-300">
                      {formatBytes(b.sizeBytes)}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="rounded bg-stone-800 px-2 py-0.5 font-mono text-stone-200">
                        {b.manifest?.stats.meetingCount ?? "—"}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-1.5">
                        <span className="rounded bg-stone-800 px-2 py-0.5 font-mono text-stone-200">
                          {b.manifest?.stats.audioFilesCount ?? "—"} files
                        </span>
                        {b.manifest?.stats.totalAudioSizeBytes ? (
                          <span className="text-[10px] text-stone-500 font-mono">
                            ({formatBytes(b.manifest.stats.totalAudioSizeBytes)})
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="rounded bg-stone-800 px-2 py-0.5 font-mono text-stone-200">
                        {b.manifest?.stats.summaryCount ?? "—"}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <a
                          href={`/api/backup/download/${encodeURIComponent(b.filename)}`}
                          download
                          className="rounded border border-stone-700 bg-stone-800 px-2.5 py-1 text-xs text-stone-200 hover:bg-stone-700 hover:text-white transition"
                        >
                          ⬇️ Download
                        </a>
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmRestoreTarget({
                              type: "stored",
                              filename: b.filename,
                              stats: {
                                meetings: b.manifest?.stats.meetingCount ?? 0,
                                audioFiles: b.manifest?.stats.audioFilesCount ?? 0,
                                sizeBytes: b.sizeBytes
                              }
                            });
                          }}
                          className="rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-300 hover:bg-amber-500/20 transition"
                        >
                          ♻️ Restore
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteBackup(b.filename)}
                          className="rounded border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs text-red-400 hover:bg-red-500/20 transition"
                        >
                          🗑️ Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Confirmation Modal for Restore */}
      {confirmRestoreTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-amber-500/40 bg-stone-900 p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-amber-400">
              <span className="text-2xl">⚠️</span>
              <h3 className="text-lg font-bold text-stone-100">Confirm System Restore</h3>
            </div>

            <p className="text-sm text-stone-300 leading-relaxed">
              Restoring from <strong className="text-amber-300 font-mono">{confirmRestoreTarget.filename}</strong> will overwrite current meetings, audio recordings, transcripts, summaries, and configuration with the contents of this archive.
            </p>

            <div className="rounded-xl border border-stone-800 bg-stone-950 p-4 space-y-1.5 text-xs text-stone-400">
              <div className="flex justify-between">
                <span>Source Archive:</span>
                <span className="font-mono text-stone-200">{confirmRestoreTarget.filename}</span>
              </div>
              {confirmRestoreTarget.stats?.sizeBytes && (
                <div className="flex justify-between">
                  <span>Archive Size:</span>
                  <span className="font-mono text-stone-200">{formatBytes(confirmRestoreTarget.stats.sizeBytes)}</span>
                </div>
              )}
              {confirmRestoreTarget.stats?.meetings ? (
                <div className="flex justify-between">
                  <span>Meetings included:</span>
                  <span className="font-mono text-stone-200">{confirmRestoreTarget.stats.meetings}</span>
                </div>
              ) : null}
              {confirmRestoreTarget.stats?.audioFiles ? (
                <div className="flex justify-between">
                  <span>Audio recordings included:</span>
                  <span className="font-mono text-stone-200">{confirmRestoreTarget.stats.audioFiles}</span>
                </div>
              ) : null}
            </div>

            <p className="text-xs text-stone-500">
              Note: An automatic rollback snapshot will be created in temporary storage before file replacement in case of unexpected errors.
            </p>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmRestoreTarget(null)}
                disabled={restoring}
                className="rounded-lg border border-stone-700 px-4 py-2 text-xs font-medium text-stone-300 hover:bg-stone-800 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleExecuteRestore()}
                disabled={restoring}
                className="inline-flex items-center gap-2 rounded-lg bg-amber-400 px-4 py-2 text-xs font-bold text-stone-950 transition hover:bg-amber-300 disabled:opacity-50 shadow"
              >
                {restoring ? "Restoring System…" : "Yes, Restore System"}
              </button>
            </div>
          </div>
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

