"use client";

import { NexusesLogo } from "@/components/NexusesLogo";
import type { ChatThreadDTO } from "@/types/chat";
import type { ProjectDTO, SessionUser } from "@/types";

export function ChatSidebar({
  user,
  project,
  projects,
  chats,
  activeChatId,
  open,
  onClose,
  onSelect,
  onNew,
  onDelete,
  onSwitchProject,
  onLogout,
}: {
  user: SessionUser;
  project: ProjectDTO;
  projects: ProjectDTO[];
  chats: ChatThreadDTO[];
  activeChatId: string;
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onSwitchProject: (id: string) => void;
  onLogout: () => void;
}) {
  return (
    <>
      {open ? (
        <button
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          aria-label="Close chats"
          onClick={onClose}
        />
      ) : null}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex h-full w-72 shrink-0 flex-col overflow-hidden border-r border-line bg-ink-2 transition-transform md:static md:h-full md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
          {project.logo ? (
            <img
              src={project.logo}
              alt={project.name}
              referrerPolicy="no-referrer"
              className="h-12 w-auto max-w-[180px] object-contain"
            />
          ) : (
            <NexusesLogo className="h-8 w-auto max-w-[140px]" />
          )}
          <button
            type="button"
            onClick={onNew}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-panel hover:text-paper"
            aria-label="New chat"
            title="New chat"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {projects.length > 1 ? (
          <div className="shrink-0 px-3 pt-3">
            <select
              value={project._id}
              onChange={(event) => onSwitchProject(event.target.value)}
              className="w-full truncate rounded-xl border border-line bg-panel px-3 py-2 text-sm outline-none"
            >
              {projects.map((item) => (
                <option key={item._id} value={item._id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <nav className="mt-4 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <p className="px-2 pb-2 text-[11px] uppercase tracking-[0.16em] text-muted">Chats</p>
          {chats.length === 0 ? (
            <p className="px-2 text-sm text-muted">No chats yet. Start a new one.</p>
          ) : (
            <ul className="space-y-1">
              {chats.map((item) => {
                const active = item._id === activeChatId;
                return (
                  <li key={item._id} className="group relative">
                    <button
                      type="button"
                      onClick={() => onSelect(item._id)}
                      className={`w-full truncate rounded-xl px-3 py-2.5 pr-9 text-left text-sm ${
                        active ? "bg-panel text-paper" : "text-muted hover:bg-panel/70 hover:text-paper"
                      }`}
                    >
                      {item.title}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(item._id)}
                      className="absolute right-2 top-1/2 hidden -translate-y-1/2 text-muted hover:text-paper group-hover:block"
                      aria-label={`Delete ${item.title}`}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        <div className="shrink-0 border-t border-line px-4 py-4">
          <p className="truncate text-sm text-paper">{user.name}</p>
          <p className="truncate text-xs text-muted">{user.email}</p>
          <button
            type="button"
            onClick={onLogout}
            className="mt-3 text-xs text-muted hover:text-paper"
          >
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}
