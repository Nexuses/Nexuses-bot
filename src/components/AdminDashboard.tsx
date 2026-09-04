"use client";

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Field, PrimaryButton } from "@/components/ui";
import type { ProjectDTO, SessionUser, UserDTO } from "@/types";

function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function AdminDashboard({
  admin,
  initialProjects,
  initialUsers,
}: {
  admin: SessionUser;
  initialProjects: ProjectDTO[];
  initialUsers: UserDTO[];
}) {
  const router = useRouter();
  const [projects, setProjects] = useState(initialProjects);
  const [users, setUsers] = useState(initialUsers);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [projectOpen, setProjectOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState<ProjectDTO | null>(null);

  const [projectName, setProjectName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");

  const [userName, setUserName] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [userPassword, setUserPassword] = useState("");
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);

  const assignmentLookup = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const project of projects) {
      for (const member of project.members) {
        const current = map.get(member._id) ?? [];
        current.push(project.name);
        map.set(member._id, current);
      }
    }
    return map;
  }, [projects]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/admin");
    router.refresh();
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: projectName, logo: logoUrl }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not create project");
      return;
    }
    setProjects((current) => [data.project, ...current]);
    setProjectOpen(false);
    setProjectName("");
    setLogoUrl("");
  }

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: userName,
        email: userEmail,
        password: userPassword,
      }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not create user");
      return;
    }
    setUsers((current) => [data.user, ...current]);
    setUserOpen(false);
    setUserName("");
    setUserEmail("");
    setUserPassword("");
  }

  async function assignUsers(event: FormEvent) {
    event.preventDefault();
    if (!assignOpen) return;
    setError("");
    setBusy(true);
    const res = await fetch(`/api/projects/${assignOpen._id}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds: selectedUserIds }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not assign users");
      return;
    }
    setProjects((current) =>
      current.map((project) => (project._id === data.project._id ? data.project : project)),
    );
    setAssignOpen(null);
  }

  return (
    <div className="min-h-full bg-ink">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-3 text-brass">
            <BrandMark className="h-8 w-8" />
            <div>
              <p className="font-display text-lg tracking-tight text-paper">Nexuses Admin</p>
              <p className="text-xs text-muted">{admin.email}</p>
            </div>
          </div>
          <button
            onClick={logout}
            className="rounded-full border border-line px-4 py-2 text-sm text-muted transition hover:border-brass hover:text-paper"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        {error ? (
          <p className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">
            {error}
          </p>
        ) : null}

        <section className="mb-14">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-sm uppercase tracking-[0.18em] text-brass">Projects</p>
              <h1 className="mt-1 font-display text-4xl tracking-tight">Workspace</h1>
            </div>
            <button
              onClick={() => {
                setError("");
                setProjectOpen(true);
              }}
              className="rounded-full bg-brass px-5 py-2.5 text-sm font-semibold text-on-brass"
            >
              New project
            </button>
          </div>

          {projects.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-line px-8 py-16 text-center text-muted">
              No projects yet. Create one with a name and logo URL.
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((project) => (
                <article
                  key={project._id}
                  className="rounded-3xl border border-line bg-panel p-5"
                >
                  <div className="mb-5 flex items-center gap-4">
                    <img
                      src={project.logo}
                      alt=""
                      referrerPolicy="no-referrer"
                      className="h-14 w-14 rounded-2xl object-cover ring-1 ring-line"
                    />
                    <div>
                      <h2 className="font-display text-xl tracking-tight">{project.name}</h2>
                      <p className="text-sm text-muted">
                        {project.members.length} assigned
                      </p>
                    </div>
                  </div>
                  <div className="mb-5 flex -space-x-2">
                    {project.members.slice(0, 5).map((member) => (
                      <span
                        key={member._id}
                        title={member.name}
                        className="flex h-8 w-8 items-center justify-center rounded-full bg-ink-2 text-[10px] ring-2 ring-panel"
                      >
                        {initials(member.name)}
                      </span>
                    ))}
                    {project.members.length === 0 ? (
                      <span className="text-sm text-muted">No users assigned</span>
                    ) : null}
                  </div>
                  <button
                    onClick={() => {
                      setError("");
                      setAssignOpen(project);
                      setSelectedUserIds(project.members.map((member) => member._id));
                    }}
                    className="w-full rounded-xl border border-line py-2.5 text-sm text-muted transition hover:border-brass hover:text-paper"
                  >
                    Assign users
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-sm uppercase tracking-[0.18em] text-brass">People</p>
              <h2 className="mt-1 font-display text-4xl tracking-tight">Users</h2>
            </div>
            <button
              onClick={() => {
                setError("");
                setUserOpen(true);
              }}
              className="rounded-full border border-line px-5 py-2.5 text-sm text-paper"
            >
              New user
            </button>
          </div>

          {users.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-line px-8 py-16 text-center text-muted">
              Create a user, then assign them to a project. They sign in at `/`.
            </div>
          ) : (
            <div className="overflow-hidden rounded-3xl border border-line">
              {users.map((user) => (
                <div
                  key={user._id}
                  className="flex flex-col gap-3 border-b border-line px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-ink-2 text-xs">
                      {initials(user.name)}
                    </span>
                    <div>
                      <p className="font-medium">{user.name}</p>
                      <p className="text-sm text-muted">{user.email}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(assignmentLookup.get(user._id) ?? []).length === 0 ? (
                      <span className="text-sm text-muted">Unassigned</span>
                    ) : (
                      (assignmentLookup.get(user._id) ?? []).map((name) => (
                        <span
                          key={name}
                          className="rounded-full bg-ink-2 px-3 py-1 text-xs text-brass-2"
                        >
                          {name}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {projectOpen ? (
        <Modal title="Create project" onClose={() => setProjectOpen(false)}>
          <form onSubmit={createProject} className="space-y-4">
            <Field
              label="Project name"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              required
              minLength={2}
            />
            <Field
              label="Logo URL"
              type="url"
              placeholder="https://example.com/logo.png"
              value={logoUrl}
              onChange={(event) => setLogoUrl(event.target.value)}
              required
            />
            {logoUrl ? (
              <img
                src={logoUrl}
                alt=""
                referrerPolicy="no-referrer"
                className="h-16 w-16 rounded-2xl object-cover ring-1 ring-line"
              />
            ) : null}
            <PrimaryButton type="submit" disabled={busy}>
              {busy ? "Creating..." : "Create project"}
            </PrimaryButton>
          </form>
        </Modal>
      ) : null}

      {userOpen ? (
        <Modal title="Create user" onClose={() => setUserOpen(false)}>
          <form onSubmit={createUser} className="space-y-4">
            <Field
              label="Name"
              value={userName}
              onChange={(event) => setUserName(event.target.value)}
              required
            />
            <Field
              label="Email"
              type="email"
              value={userEmail}
              onChange={(event) => setUserEmail(event.target.value)}
              required
            />
            <Field
              label="Password"
              type="password"
              value={userPassword}
              onChange={(event) => setUserPassword(event.target.value)}
              required
              minLength={8}
            />
            <p className="text-sm text-muted">This person will sign in at the user portal `/`.</p>
            <PrimaryButton type="submit" disabled={busy}>
              {busy ? "Creating..." : "Create user"}
            </PrimaryButton>
          </form>
        </Modal>
      ) : null}

      {assignOpen ? (
        <Modal title={`Assign users to ${assignOpen.name}`} onClose={() => setAssignOpen(null)}>
          <form onSubmit={assignUsers} className="space-y-4">
            {users.length === 0 ? (
              <p className="text-sm text-muted">Create a user first, then assign them here.</p>
            ) : (
              <div className="max-h-72 space-y-2 overflow-auto">
                {users.map((user) => {
                  const checked = selectedUserIds.includes(user._id);
                  return (
                    <label
                      key={user._id}
                      className="flex cursor-pointer items-center gap-3 rounded-xl border border-line px-3 py-3"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setSelectedUserIds((current) =>
                            checked
                              ? current.filter((id) => id !== user._id)
                              : [...current, user._id],
                          );
                        }}
                        className="accent-brass"
                      />
                      <span>
                        <span className="block font-medium">{user.name}</span>
                        <span className="block text-sm text-muted">{user.email}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            <PrimaryButton type="submit" disabled={busy || users.length === 0}>
              {busy ? "Saving..." : "Save assignment"}
            </PrimaryButton>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center">
      <button className="absolute inset-0" aria-label="Close" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-3xl border border-line bg-panel p-6">
        <div className="mb-5 flex items-start justify-between gap-4">
          <h3 className="font-display text-2xl tracking-tight">{title}</h3>
          <button onClick={onClose} className="text-muted hover:text-paper">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
