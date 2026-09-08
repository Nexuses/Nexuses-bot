"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Field, PrimaryButton } from "@/components/ui";
import type { IntegrationDTO, Provider } from "@/types/chat";

const CATALOG: {
  provider: Exclude<Provider, "other">;
  title: string;
  blurb: string;
  oauth?: boolean;
}[] = [
  { provider: "attio", title: "Attio", blurb: "Lists, stages, people, and companies" },
  {
    provider: "brevo",
    title: "Brevo",
    blurb:
      "MCP key for campaigns; add a normal API key too for who opened/clicked (same connection)",
  },
  { provider: "lemlist", title: "Lemlist", blurb: "Outreach campaigns, leads, activity" },
  {
    provider: "notion",
    title: "Notion",
    blurb: "Pages and databases — Connect opens Notion’s authorize page",
    oauth: true,
  },
];

export function IntegrationsPanel({
  projectId,
  integrations,
  onChange,
  onClose,
}: {
  projectId: string;
  integrations: IntegrationDTO[];
  onChange: (next: IntegrationDTO[]) => void;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [otherName, setOtherName] = useState("");
  const [otherKey, setOtherKey] = useState("");
  const [otherUrl, setOtherUrl] = useState("");
  const [addingOther, setAddingOther] = useState(false);

  const byProvider = useMemo(() => {
    const map = new Map<string, IntegrationDTO>();
    for (const item of integrations) {
      if (item.provider !== "other") map.set(item.provider, item);
    }
    return map;
  }, [integrations]);

  const others = integrations.filter((item) => item.provider === "other");

  async function connect(
    provider: Provider,
    name?: string,
    apiKey?: string,
    baseUrl?: string,
  ) {
    const key = (apiKey ?? keys[provider] ?? "").trim();
    setError("");
    setBusy(provider + (name ?? ""));
    const res = await fetch(`/api/projects/${projectId}/integrations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        name,
        apiKey: key,
        baseUrl,
      }),
    });
    const data = await res.json();
    setBusy("");
    if (!res.ok) {
      setError(data.error ?? "Could not connect");
      return;
    }
    onChange([
      ...integrations.filter((item) =>
        provider === "other"
          ? !(item.provider === "other" && item.name === data.integration.name)
          : item.provider !== provider,
      ),
      data.integration,
    ]);
    if (provider === "other") {
      setOtherName("");
      setOtherKey("");
      setOtherUrl("");
      setAddingOther(false);
    } else {
      setKeys((current) => ({ ...current, [provider]: "" }));
    }
  }

  async function disconnect(item: IntegrationDTO) {
    setError("");
    setBusy(item._id);
    const res = await fetch(`/api/projects/${projectId}/integrations/${item._id}`, {
      method: "DELETE",
    });
    setBusy("");
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Could not disconnect");
      return;
    }
    onChange(integrations.filter((entry) => entry._id !== item._id));
  }

  async function onOther(event: FormEvent) {
    event.preventDefault();
    await connect("other", otherName, otherKey, otherUrl);
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60">
      <button className="absolute inset-0" aria-label="Close integrations" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-md flex-col overflow-auto border-l border-line bg-panel px-6 py-6">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-sea">Connect</p>
            <h2 className="mt-1 font-display text-2xl tracking-tight">Integrations</h2>
            <p className="mt-2 text-sm text-muted">
              Connect here, or paste an API key in chat — Nexuses will save it and start using it.
            </p>
          </div>
          <button onClick={onClose} className="text-sm text-muted hover:text-paper">
            Close
          </button>
        </div>

        {error ? (
          <p className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
            {error}
          </p>
        ) : null}

        <div className="space-y-4">
          {CATALOG.map((item) => {
            const connected = byProvider.get(item.provider);
            return (
              <div key={item.provider} className="rounded-2xl border border-line p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{item.title}</p>
                    <p className="text-sm text-muted">{item.blurb}</p>
                    {connected ? (
                      <p className="mt-1 text-xs text-sea">
                        Connected
                        {item.provider === "brevo"
                          ? connected.mcpUrl && connected.hasRestApiKey
                            ? " via MCP + API"
                            : connected.mcpUrl
                              ? " via MCP"
                              : " via API"
                          : ""}{" "}
                        · {connected.keyHint}
                      </p>
                    ) : null}
                  </div>
                  {connected ? (
                    <button
                      onClick={() => disconnect(connected)}
                      disabled={busy === connected._id}
                      className="text-sm text-muted hover:text-paper"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                {!connected ? (
                  item.oauth ? (
                    <div className="mt-3">
                      <a
                        href={`/api/oauth/${item.provider}/start?projectId=${encodeURIComponent(projectId)}`}
                        className="inline-flex items-center justify-center rounded-full bg-sea px-5 py-2.5 text-sm font-semibold text-ink hover:bg-sea-2"
                      >
                        Connect {item.title}
                      </a>
                      <p className="mt-2 text-xs text-muted">
                        Opens {item.title}’s authorize page, then returns here.
                      </p>
                    </div>
                  ) : (
                  <form
                    className="mt-3 space-y-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void connect(item.provider);
                    }}
                  >
                    <Field
                      label={item.provider === "brevo" ? "Brevo API or MCP key" : "API key"}
                      type="password"
                      value={keys[item.provider] ?? ""}
                      onChange={(event) =>
                        setKeys((current) => ({ ...current, [item.provider]: event.target.value }))
                      }
                      required
                    />
                    {item.provider === "brevo" ? (
                      <p className="text-xs text-muted">
                        Paste only the key itself (no Bearer). Standard keys work for REST; MCP keys need
                        “Create MCP server API key” enabled in Brevo → SMTP &amp; API.
                      </p>
                    ) : null}
                    <PrimaryButton type="submit" tone="sea" disabled={busy === item.provider}>
                      {busy === item.provider ? "Connecting..." : `Connect ${item.title}`}
                    </PrimaryButton>
                  </form>
                  )
                ) : item.provider === "brevo" && connected.mcpUrl && !connected.hasRestApiKey ? (
                  <form
                    className="mt-3 space-y-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void connect("brevo");
                    }}
                  >
                    <p className="text-xs text-muted">
                      Add a normal Brevo API key (not MCP) so we can list who opened/clicked.
                    </p>
                    <Field
                      label="Standard API key"
                      type="password"
                      value={keys.brevo ?? ""}
                      onChange={(event) =>
                        setKeys((current) => ({ ...current, brevo: event.target.value }))
                      }
                      required
                    />
                    <PrimaryButton type="submit" tone="sea" disabled={busy === "brevo"}>
                      {busy === "brevo" ? "Saving..." : "Add API key"}
                    </PrimaryButton>
                  </form>
                ) : null}
              </div>
            );
          })}

          {others.map((item) => (
            <div key={item._id} className="rounded-2xl border border-line p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{item.name}</p>
                  <p className="text-sm text-muted">
                    Custom API
                    {item.baseUrl ? ` · ${item.baseUrl}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-sea">Connected · {item.keyHint}</p>
                </div>
                <button
                  onClick={() => disconnect(item)}
                  disabled={busy === item._id}
                  className="text-sm text-muted hover:text-paper"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}

          <div className="rounded-2xl border border-line p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium">Other</p>
                <p className="text-sm text-muted">
                  Custom API (e.g. SmartLead). Name it SmartLead and paste the key — we use
                  ?api_key= auth automatically.
                </p>
              </div>
              {!addingOther ? (
                <button
                  type="button"
                  onClick={() => setAddingOther(true)}
                  className="text-sm text-sea hover:text-sea-2"
                >
                  Add
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setAddingOther(false);
                    setOtherName("");
                    setOtherKey("");
                    setOtherUrl("");
                  }}
                  className="text-sm text-muted hover:text-paper"
                >
                  Cancel
                </button>
              )}
            </div>
            {addingOther ? (
              <form onSubmit={onOther} className="mt-3 space-y-3">
                <Field
                  label="Name"
                  value={otherName}
                  onChange={(event) => setOtherName(event.target.value)}
                  placeholder="SmartLead"
                  required
                  minLength={2}
                />
                <Field
                  label="API key"
                  type="password"
                  value={otherKey}
                  onChange={(event) => setOtherKey(event.target.value)}
                  required
                />
                <Field
                  label="Base URL (optional)"
                  type="url"
                  value={otherUrl}
                  onChange={(event) => setOtherUrl(event.target.value)}
                  placeholder="https://server.smartlead.ai/api/v1"
                />
                <p className="text-xs text-muted">
                  For SmartLead, leave base URL empty or use https://server.smartlead.ai/api/v1.
                  Auth is ?api_key= (not Bearer).
                </p>
                <PrimaryButton type="submit" tone="sea" disabled={busy === "other" + otherName}>
                  {busy.startsWith("other") ? "Connecting..." : `Connect ${otherName.trim() || "API"}`}
                </PrimaryButton>
              </form>
            ) : null}
          </div>
        </div>
      </aside>
    </div>
  );
}
