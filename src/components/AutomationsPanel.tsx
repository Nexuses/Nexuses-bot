"use client";

import type { AutomationDTO } from "@/lib/serialize-automation";

function sourceLabel(item: AutomationDTO) {
  if (item.sourceProvider === "other") {
    return item.sourceIntegrationName || "Custom API";
  }
  return item.sourceProvider.charAt(0).toUpperCase() + item.sourceProvider.slice(1);
}

function statusTone(status: AutomationDTO["status"]) {
  if (status === "running") return "border-sea/40 bg-sea/10 text-sea";
  if (status === "completed") return "border-line bg-ink/40 text-muted";
  if (status === "failed") return "border-red-500/30 bg-red-500/10 text-red-400";
  if (status === "stopped") return "border-line bg-ink/30 text-muted";
  return "border-line bg-ink/30 text-muted";
}

function formatWhen(iso: string) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function AutomationsPanel({
  automations,
  stoppingId,
  onStop,
  onRefresh,
  onClose,
}: {
  automations: AutomationDTO[];
  stoppingId: string;
  onStop: (item: AutomationDTO) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const running = automations.filter((item) => item.status === "running");
  const others = automations.filter((item) => item.status !== "running");

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60">
      <button className="absolute inset-0" aria-label="Close automations" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-md flex-col overflow-auto border-l border-line bg-panel px-6 py-6">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-sea">Background</p>
            <h2 className="mt-1 font-display text-2xl tracking-tight">Automations</h2>
            <p className="mt-2 text-sm text-muted">
              Live sync jobs into Attio from connected sources. Ask in chat to start one, or stop
              anything running here.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={onRefresh}
              className="text-sm text-muted hover:text-paper"
            >
              Refresh
            </button>
            <button type="button" onClick={onClose} className="text-sm text-muted hover:text-paper">
              Close
            </button>
          </div>
        </div>

        {!automations.length ? (
          <div className="rounded-2xl border border-dashed border-line px-4 py-10 text-center">
            <p className="text-sm text-muted">No automations yet.</p>
            <p className="mt-2 text-xs text-muted">
              In chat: “Keep updating Attio from [campaign] until it finishes.”
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {running.length ? (
              <section>
                <p className="mb-3 text-xs uppercase tracking-[0.16em] text-sea">
                  Happening now · {running.length}
                </p>
                <div className="space-y-3">
                  {running.map((item) => (
                    <article
                      key={item._id}
                      className="rounded-2xl border border-sea/40 bg-sea/10 px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="flex items-center gap-2 text-sm font-medium text-paper">
                            <span
                              className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-sea"
                              aria-hidden
                            />
                            {item.title || item.campaignName}
                            {item.watchAll ? (
                              <span className="rounded-full border border-sea/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-sea">
                                watch all
                              </span>
                            ) : null}
                            {item.webhookEnabled ? (
                              <span className="rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                                webhook
                              </span>
                            ) : null}
                          </p>
                          <p className="mt-1 text-xs text-muted">
                            {sourceLabel(item)} · {item.campaignName} → Attio “{item.attioList}”
                          </p>
                          {item.webhookUrl ? (
                            <p className="mt-2 break-all rounded-xl border border-line bg-ink/40 px-2 py-1.5 font-mono text-[10px] text-muted">
                              {item.webhookUrl}
                            </p>
                          ) : null}
                        </div>
                        <span
                          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${statusTone(item.status)}`}
                        >
                          {item.status}
                        </span>
                      </div>
                      {item.lastSummary ? (
                        <p className="mt-2 text-xs leading-relaxed text-muted">{item.lastSummary}</p>
                      ) : null}
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[11px] text-muted">
                          Runs: {item.runCount}
                          {item.lastRunAt ? ` · Last ${formatWhen(item.lastRunAt)}` : ""}
                          {item.intervalMinutes ? ` · every ${item.intervalMinutes}m` : ""}
                        </p>
                        <button
                          type="button"
                          disabled={stoppingId === item._id}
                          onClick={() => onStop(item)}
                          className="rounded-full border border-line px-3 py-1.5 text-xs text-muted hover:border-sea hover:text-paper disabled:opacity-50"
                        >
                          {stoppingId === item._id ? "Stopping…" : "Stop"}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            {others.length ? (
              <section>
                <p className="mb-3 text-xs uppercase tracking-[0.16em] text-muted">
                  Recent · {others.length}
                </p>
                <div className="space-y-3">
                  {others.map((item) => (
                    <article
                      key={item._id}
                      className="rounded-2xl border border-line bg-ink/30 px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-paper">
                            {item.title || item.campaignName}
                          </p>
                          <p className="mt-1 text-xs text-muted">
                            {sourceLabel(item)} · {item.campaignName} → Attio “{item.attioList}”
                          </p>
                        </div>
                        <span
                          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${statusTone(item.status)}`}
                        >
                          {item.status}
                        </span>
                      </div>
                      {item.lastSummary || item.error ? (
                        <p className="mt-2 text-xs leading-relaxed text-muted">
                          {item.error || item.lastSummary}
                        </p>
                      ) : null}
                      <p className="mt-2 text-[11px] text-muted">
                        Runs: {item.runCount}
                        {item.lastRunAt ? ` · Last ${formatWhen(item.lastRunAt)}` : ""}
                      </p>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        )}
      </aside>
    </div>
  );
}
